/**
 * Claude Code adapter — drives the `claude` CLI through the Claude Agent SDK,
 * one query (one CLI process) per turn, resuming the same session across turns.
 *
 * The SDK speaks the CLI's stream-json control protocol over stdio. Over plain
 * `claude -p` it adds what Loom needs: permission prompts answered in-process
 * (`canUseTool`, so "ask" is real approvals without an MCP shim), a proper
 * interrupt, compaction status (`system/status: compacting`, `compact_boundary`),
 * the model's context window on the result, and rate-limit utilisation.
 *
 * Loom spawns the CLI itself (`spawnClaudeCodeProcess`) so the turn owns a
 * process group: the writer lease is released only after that group has exited.
 * The SDK is pointed at the user's installed `claude`, so the version the user
 * signed into is the one that runs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { query, type CanUseTool, type McpServerConfig, type Options, type Query, type SDKMessage, type SpawnOptions, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { AgentCapabilities, McpServerEntry, SendInput } from "../types.js";
import { AdapterBase, ADAPTER_CAPABILITIES, agentEnv, cliAvailable, guardNativeOutput, quiesceProcessGroup, trackNativeExit } from "./base.js";
import { hasApprovalBroker, requestApproval } from "../core/approvals.js";
import { permissionFor } from "../core/permissions.js";
import { NativeDispatchRejected, NativeQuiescenceUnknown, NativeSessionMissing } from "../core/continuity/contracts.js";

interface ClaudeOptions {
  /** Claude permission mode, overriding the Loom mode; e.g. "acceptEdits". */
  permissionMode?: string;
  /** Optional model override. */
  model?: string;
  /**
   * Path to the claude binary, when it isn't `claude` on PATH.
   *
   * Same escape hatch codex and grok have, and the seam these tests drive: an
   * adapter whose job is to parse another program's output can be tested
   * properly by handing it another program.
   */
  bin?: string;
  /** Extra CLI args (`["--flag", "value", "--switch"]`), escape hatch. */
  extraArgs?: string[];
  /** Loom project id, for approval cards. */
  loomProject?: string;
}

const MISSING_SESSION = /No conversation found|session .* (?:not found|does not exist)/i;
const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, seven_day: 10_080, seven_day_opus: 10_080, seven_day_sonnet: 10_080 };

/**
 * Where `claude` lives when it isn't on PATH.
 *
 * Anthropic's installer puts it in ~/.local/bin, which is on an interactive
 * shell's PATH and frequently not on a daemon's — Loom's daemon is spawned
 * detached, and from the desktop shell it inherits a GUI environment with a
 * minimal PATH. The result was Setup reporting "Claude Code — not installed"
 * on a machine where `which claude` answers, which is the worst kind of wrong:
 * it sends you to reinstall something you already have.
 *
 * Codex, Grok and Antigravity each already look in their known locations. This
 * is the same idea for the one that was missing it. PATH is still the last
 * word, so a `claude` earlier in PATH wins.
 */
export function claudeBin(override?: string): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  const home = process.env.HOME ?? "";
  const known = [
    `${home}/.local/bin/claude`,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    `${home}/.bun/bin/claude`,
    `${home}/.volta/bin/claude`,
  ];
  for (const p of known) {
    if (p && fs.existsSync(p)) return p;
  }
  return "claude"; // let PATH resolution (and cliAvailable) decide
}

/** `["--a", "1", "--b"]` → `{ a: "1", b: null }`, the SDK's extraArgs shape. */
function extraArgsRecord(args: unknown): Record<string, string | null> | undefined {
  if (args === undefined) return undefined;
  if (!Array.isArray(args) || args.some(a => typeof a !== "string")) throw new NativeDispatchRejected("extraArgs must be a list of strings");
  if (!args.length) return undefined;
  const out: Record<string, string | null> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) { out[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const next = args[i + 1];
    out[arg.slice(2)] = next !== undefined && !next.startsWith("--") ? (i++, next) : null;
  }
  return out;
}

function mcpServer(entry: McpServerEntry): McpServerConfig {
  if (entry.type === "stdio") return { type: "stdio", command: entry.command, ...(entry.args ? { args: entry.args } : {}), ...(entry.env ? { env: entry.env } : {}) };
  return { type: entry.type, url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
}

interface Turn {
  child: ChildProcess | null;
  query: Query | null;
  abort: AbortController;
  interrupted: boolean;
  stderr: string;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  spawnError: Error | null;
  /** A native stream failure (oversized record, handler error); fails the turn. */
  failure: Error | null;
  quiesce: (() => Promise<void>) | null;
  closed: Promise<void> | null;
}

export class ClaudeCodeAdapter extends AdapterBase {
  /** The SDK takes MCP server config per query, so this adapter accepts SendInput.mcp. */
  override readonly capabilities: AgentCapabilities = { ...ADAPTER_CAPABILITIES, mcp: true };
  private options: ClaudeOptions;
  private turn: Turn | null = null;
  private settled: Promise<void> | null = null;
  /** The context window, learned from result messages (the largest across
   * the models a turn used, as t3code reads it); outlives turns. */
  private contextWindow: number | undefined;

  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) {
    super(id, "claude-code", projectDir);
    this.options = options as ClaudeOptions;
  }

  private get sessionId(): string | undefined {
    if (this.continuityTurn) return this.continuityTurn.nativeSessionId ?? undefined;
    return this.nativeState.read().sessionId as string | undefined;
  }

  private set sessionId(value: string | undefined) {
    if (this.continuityTurn) { this.continuityTurn.nativeSessionId = value ?? null; return; }
    this.nativeState.patch({ sessionId: value });
  }

  private get bin(): string | null {
    return claudeBin(this.options.bin);
  }

  async available(): Promise<boolean> {
    const bin = this.bin;
    return bin ? cliAvailable(bin) : false;
  }

  async start(): Promise<void> {
    this.emit({ kind: "status", payload: { state: "ready", session: this.sessionId ?? null } });
  }

  async stop(): Promise<void> {
    await this.interrupt();
  }

  /** Permission mode and approval callback from the Loom mode (core/permissions). */
  private permissions(): Pick<Options, "permissionMode" | "canUseTool" | "allowDangerouslySkipPermissions"> {
    if (this.options.permissionMode) {
      const mode = this.options.permissionMode as NonNullable<Options["permissionMode"]>;
      return { permissionMode: mode, ...(mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}) };
    }
    const mode = permissionFor("claude-code", this.options as Record<string, unknown>);
    if (mode === "bypass") return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
    if (mode === "auto") return { permissionMode: "acceptEdits" };
    // "ask" needs someone to ask; with no daemon it degrades to plan
    // (read-only), never to "allow".
    if (!hasApprovalBroker()) return { permissionMode: "plan" };
    const canUseTool: CanUseTool = async (tool, input, { signal }) => {
      const decision = await requestApproval({ project: String(this.options.loomProject ?? ""), agent: this.id,
        tool, input, summary: summarizeToolInput(tool, input), signal });
      return decision.behavior === "allow"
        ? { behavior: "allow", updatedInput: decision.updatedInput ?? input }
        : { behavior: "deny", message: decision.message ?? "Denied in Loom." };
    };
    return { permissionMode: "default", canUseTool };
  }

  async send(input: SendInput): Promise<void> {
    if (this._busy) throw new Error(`claude-code agent "${this.id}" is busy`);
    const bin = this.bin;
    if (!bin) throw new NativeDispatchRejected("claude CLI not found — install Claude Code or set its path");
    this._busy = true;
    this.beginContinuity(input);
    let release!: () => void;
    this.settled = new Promise(resolve => { release = resolve; });
    try {
      const resumed = this.sessionId;
      const outcome = await this.run(bin, input);
      if (outcome === "missing-session") {
        // No turn ran: the CLI refused the resume before reading the prompt.
        if (input.continuity) throw new NativeSessionMissing(`claude session ${resumed} could not be resumed`);
        this.sessionId = undefined;
        if (await this.run(bin, input) === "missing-session") throw new NativeDispatchRejected("claude could not start a new session");
      }
    } finally {
      this.turn = null;
      this._busy = false;
      this.endContinuity();
      release();
    }
  }

  /** One query. Resolves "missing-session" when a resume found no session and no turn ran. */
  private async run(bin: string, input: SendInput): Promise<"done" | "missing-session"> {
    const started = Date.now();
    const turn: Turn = { child: null, query: null, abort: new AbortController(), interrupted: this.turn?.interrupted ?? false,
      stderr: "", exit: null, spawnError: null, failure: null, quiesce: null, closed: null };
    this.turn = turn;
    const prompt = input.continuity ? [input.continuity.context, input.briefing, input.text].filter(Boolean).join("\n\n") : input.text;
    const model = input.model ?? this.options.model;
    const resume = this.sessionId;
    const extraArgs = extraArgsRecord(this.options.extraArgs);
    // The project's MCP servers, for this turn only — passed only when the
    // runtime produced some.
    const mcpServers = input.mcp?.servers.length
      ? Object.fromEntries(input.mcp.servers.map(s => [s.key, mcpServer(s.entry)])) : undefined;
    const options: Options = {
      cwd: this.projectDir,
      pathToClaudeCodeExecutable: bin,
      env: agentEnv(),
      abortController: turn.abort,
      // Claude Code's own system prompt and the user's/project's settings, as
      // an interactive `claude` would load them; a handoff briefing is
      // appended to the system prompt outside continuity.
      systemPrompt: { type: "preset", preset: "claude_code", ...(input.briefing && !input.continuity ? { append: input.briefing } : {}) },
      settingSources: ["user", "project", "local"],
      ...this.permissions(),
      ...(resume ? { resume } : {}),
      ...(model ? { model } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(extraArgs ? { extraArgs } : {}),
      spawnClaudeCodeProcess: spawnOptions => this.spawnProcess(turn, spawnOptions),
    };

    let lastText = "", lastModel: string | null = null, accepted = false, missing = false;
    let result: Extract<SDKMessage, { type: "result" }> | null = null;
    let used: number | null = null;
    const accept = () => {
      if (accepted) return;
      accepted = true;
      if (this.continuityTurn) this.emit({ kind: "status", payload: { state: "native_turn_accepted" } });
    };
    const contextUsage = () => {
      if (used === null) return;
      const max = this.contextWindow;
      this.emit({ kind: "status", payload: { state: "context_usage", usedTokens: max ? Math.min(used, max) : used,
        ...(max ? { maxTokens: max } : {}), autoCompacts: true } });
    };

    const handle = (msg: SDKMessage): void => {
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") {
            if (msg.session_id) this.sessionId = msg.session_id;
            this.emit({ kind: "status", payload: { state: "turn_started", session: msg.session_id ?? null } });
          } else if (msg.subtype === "status") {
            if (msg.status === "requesting") accept();
            else if (msg.status === "compacting") this.emit({ kind: "status", payload: { state: "compacting" } });
            if (msg.compact_result === "failed")
              this.emit({ kind: "status", payload: { state: "notice", message: `compaction failed${msg.compact_error ? `: ${msg.compact_error}` : ""}` } });
          } else if (msg.subtype === "compact_boundary") {
            // Native compaction: the session now holds a summary, not its history.
            const meta = msg.compact_metadata;
            // What the context holds now is the summary's size.
            if (typeof meta.post_tokens === "number" && meta.post_tokens > 0) { used = meta.post_tokens; contextUsage(); }
            this.emit({ kind: "status", payload: { state: "native_compacted", trigger: meta.trigger, preTokens: meta.pre_tokens,
              ...(typeof meta.post_tokens === "number" ? { postTokens: meta.post_tokens } : {}) } });
          }
          return;
        case "assistant": {
          accept();
          const message = msg.message as unknown as { content?: Array<Record<string, unknown>>; model?: string; usage?: Record<string, number | null> };
          // Sub-agent frames describe another context; only the main thread's
          // usage is this session's context.
          if (msg.parent_tool_use_id === null) {
            if (typeof message.model === "string" && message.model) lastModel = message.model;
            const next = activeTokens(message.usage);
            if (next > 0 && next !== used) { used = next; contextUsage(); }
            if (msg.error === "authentication_failed")
              this.emit({ kind: "error", payload: { message: "claude not signed in — run `claude` and /login, then try again" } });
          }
          for (const block of message.content ?? []) {
            if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
              if (msg.parent_tool_use_id === null) lastText = block.text;
              this.emit({ kind: "message", payload: { text: block.text } });
            } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
              // Extended thinking, as a reasoning-tagged message the UI folds
              // into its "thinking" block. Never the reply.
              this.emit({ kind: "message", payload: { text: block.thinking, reasoning: true } });
            } else if (block.type === "tool_use") {
              const name = String(block.name ?? "tool");
              const toolInput = (block.input ?? {}) as Record<string, unknown>;
              this.emit({ kind: "tool_call", payload: { tool: name, summary: summarizeToolInput(name, toolInput),
                ...(this.continuityTurn ? { outcome: "pending" } : {}) } });
              const path = toolInput.file_path ?? toolInput.notebook_path;
              if (["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(name) && path)
                this.emit({ kind: "file_edit", payload: { path: String(path), tool: name } });
            }
          }
          return;
        }
        case "user":
          accept();
          return;
        case "result": {
          const errors = msg.subtype === "success" ? [] : msg.errors;
          if (msg.is_error && !accepted && resume && MISSING_SESSION.test(`${errors.join("\n")}\n${msg.subtype === "success" ? msg.result : ""}`)) {
            missing = true;
            return;
          }
          accept();
          result = msg;
          const windows = Object.values(msg.modelUsage ?? {}).map(u => u.contextWindow).filter(w => w > 0);
          if (windows.length) this.contextWindow = Math.max(...windows);
          contextUsage();
          if (msg.is_error && !turn.interrupted)
            this.emit({ kind: "error", payload: { message: msg.subtype === "success" ? msg.result || "unknown error" : errors.join("; ") || msg.subtype } });
          if (msg.total_cost_usd !== undefined) this.emit({ kind: "status", payload: { state: "turn_cost", costUsd: msg.total_cost_usd } });
          return;
        }
        case "rate_limit_event": {
          const info = msg.rate_limit_info;
          // Overage the account has provisioned keeps the turn running.
          const blocked = info.status === "rejected" && !(info.overageStatus === "allowed" || info.overageStatus === "allowed_warning"
            || info.isUsingOverage === true || info.overageInUse === true);
          if (typeof info.utilization !== "number" || !info.rateLimitType) {
            if (blocked) this.emit({ kind: "status", payload: { state: "notice", message: "Claude usage limit reached" } });
            return;
          }
          this.emit({ kind: "status", payload: { state: "usage_limits", provider: "claude", windows: [{ id: info.rateLimitType,
            usedPercent: Math.round(info.utilization * 1000) / 10,
            ...(WINDOW_MINUTES[info.rateLimitType] ? { windowMinutes: WINDOW_MINUTES[info.rateLimitType] } : {}),
            ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt * 1000 } : {}) }],
            ...(blocked ? { reached: info.rateLimitType } : {}) } });
          // A rejected window parks the turn inside the CLI: no result
          // arrives, so say why the turn is waiting.
          if (blocked) this.emit({ kind: "status", payload: { state: "notice",
            message: `Claude usage limit reached (${info.rateLimitType})${typeof info.resetsAt === "number" ? ` — resets ${new Date(info.resetsAt * 1000).toLocaleString()}` : ""}` } });
          return;
        }
        default:
          return;
      }
    };

    let streamError: unknown = null;
    try {
      if (turn.interrupted) throw new NativeDispatchRejected("interrupted before the turn started");
      const q = query({ prompt, options });
      turn.query = q;
      for await (const msg of q) {
        if (turn.failure) break;
        try { handle(msg); }
        catch (error) { turn.failure = error as Error; this.killGroup(turn, "SIGKILL"); break; }
      }
    } catch (error) { streamError = error; }
    await this.closeProcess(turn);

    if (turn.spawnError) {
      this.emit({ kind: "error", payload: { message: `${bin}: ${turn.spawnError.message}` } });
      throw new NativeDispatchRejected(turn.spawnError.message);
    }
    if (streamError instanceof NativeDispatchRejected) {
      this.emit({ kind: "status", payload: { state: "interrupted" } });
      if (input.continuity) throw streamError;
      return "done";
    }
    if (turn.failure) throw turn.failure;
    if (!accepted && resume && MISSING_SESSION.test(turn.stderr)) missing = true;
    if (missing) return "missing-session";
    if (turn.interrupted) {
      this.emit({ kind: "status", payload: { state: "interrupted", ...(turn.exit?.signal ? { signal: turn.exit.signal } : {}) } });
      return "done";
    }
    const exitCode = turn.exit?.code ?? null;
    if (!result) {
      const stderr = turn.stderr.trim();
      if (turn.exit?.signal) {
        this.emit({ kind: "status", payload: { state: "interrupted", signal: turn.exit.signal } });
        return "done";
      }
      const detail = stderr || (streamError instanceof Error ? streamError.message : "");
      this.emit({ kind: "error", payload: { message: `${bin} exited ${exitCode}`, stderr: detail.slice(-2000) } });
      if (input.continuity && accepted) throw new Error("claude closed without a result; native outcome is unknown");
      if (input.continuity) throw new Error(`${bin} exited ${exitCode} before any output; native outcome is unknown: ${detail.slice(0, 200)}`);
      throw new Error(`${bin} exited ${exitCode}: ${detail.slice(0, 200)}`);
    }
    const final = result as Extract<SDKMessage, { type: "result" }>;
    if (input.continuity && (final.is_error || (exitCode !== null && exitCode !== 0))) throw new Error("claude reported a failed turn");
    // Blocked-on-human heuristic: the turn ended on a question.
    if (/\?\s*$/.test(lastText.trim())) this.emit({ kind: "needs_input", payload: { question: lastText.slice(-500) } });
    // Cache reads and creations count as input, so tokens aren't lost.
    const usage = final.usage as unknown as Record<string, number | undefined>;
    this.emit({ kind: "run_complete", payload: { durationMs: Date.now() - started,
      ...(lastModel ? { model: lastModel } : {}),
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0 } });
    return "done";
  }

  /** Spawn the CLI in its own process group so the turn can prove quiescence. */
  private spawnProcess(turn: Turn, spawnOptions: SpawnOptions): SpawnedProcess {
    const child = spawn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd ?? this.projectDir,
      env: spawnOptions.env as NodeJS.ProcessEnv,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    turn.child = child;
    turn.closed = new Promise(resolve => child.once("close", () => resolve()));
    child.once("exit", (code, signal) => { turn.exit = { code, signal }; });
    child.on("error", error => { if (!child.pid) turn.spawnError = error; });
    child.stderr?.on("data", (d: Buffer) => { turn.stderr = (turn.stderr + d.toString()).slice(-4000); });
    turn.quiesce = trackNativeExit(child, error => { turn.failure ??= error; });
    guardNativeOutput(child, error => { turn.failure ??= error; this.killGroup(turn, "SIGKILL"); });
    const onAbort = () => this.killGroup(turn, "SIGTERM");
    if (spawnOptions.signal.aborted) onAbort();
    else spawnOptions.signal.addEventListener("abort", onAbort, { once: true });
    return child as unknown as SpawnedProcess;
  }

  private killGroup(turn: Turn, signal: NodeJS.Signals): void {
    const child = turn.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* already gone */ }
  }

  /** Wait for the CLI to exit (ending it if needed) and its group to be gone. */
  private async closeProcess(turn: Turn): Promise<void> {
    const child = turn.child;
    if (!child || !child.pid) return;
    if (child.exitCode === null && child.signalCode === null) {
      const timeout = (ms: number) => new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), ms).unref());
      // A single-turn query closes stdin after its result; give the CLI a
      // moment to exit on its own before ending it.
      if (await Promise.race([turn.closed!, timeout(5000)]) === "timeout") {
        this.killGroup(turn, "SIGTERM");
        if (await Promise.race([turn.closed!, timeout(3000)]) === "timeout") {
          this.killGroup(turn, "SIGKILL");
          await Promise.race([turn.closed!, timeout(3000)]);
        }
      }
    } else await turn.closed;
    await turn.quiesce?.();
    if (process.platform !== "win32") await quiesceProcessGroup(child.pid);
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) {
      if (this._busy) throw new Error("native turn is still preparing; quiescence is not established");
      return;
    }
    turn.interrupted = true;
    // Ask the CLI to stop the turn; if it can't answer, end the process.
    const asked = turn.query
      ? await Promise.race([turn.query.interrupt().then(() => true, () => false),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5000).unref())])
      : false;
    if (!asked) { turn.abort.abort(); this.killGroup(turn, "SIGINT"); }
    // The turn settles once its process group has exited; an unproven stop
    // is an error, never a silent release.
    const settled = this.settled ?? Promise.resolve();
    const deadline = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 15_000).unref());
    if (await Promise.race([settled.then(() => "done" as const), deadline]) === "timeout")
      throw new NativeQuiescenceUnknown("claude did not stop after interruption; quiescence unknown");
  }
}

/** Tokens now in context from a main-thread response's usage: its last
 * server-side iteration when present, input (with cache) plus output. */
function activeTokens(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const usage = value as Record<string, unknown>;
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  const u = (iterations.length ? iterations[iterations.length - 1] : usage) as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" && Number.isFinite(u[k]) ? Math.max(0, u[k] as number) : 0);
  if (n("total_tokens") > 0) return n("total_tokens");
  return n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const interesting =
    input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.prompt ?? "";
  const text = String(interesting).replace(/\s+/g, " ");
  return `${name}: ${text.slice(0, 160)}`;
}
