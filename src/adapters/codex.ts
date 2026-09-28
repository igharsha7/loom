/**
 * Codex adapter — drives `codex app-server` (JSON-RPC over stdio), one
 * app-server process per turn, resuming the same thread across turns.
 *
 *   initialize → thread/start | thread/resume → turn/start → … → turn/completed
 *
 * The protocol follows the bindings `codex app-server generate-ts` emits (checked
 * against codex-cli 0.153.4). Over `codex exec --json` it adds what continuity
 * needs: `thread/tokenUsage/updated` (tokens in context and the model's context
 * window), `contextCompaction` items (compaction as it starts and ends), account
 * rate limits, and approval requests that Loom answers — so "ask" is real
 * approvals rather than a read-only stand-in.
 *
 * One process per turn keeps the lifecycle Brain relies on: the turn owns a
 * process group, and the writer lease is released only after that group has
 * exited.
 *
 * Codex reports tokens, never money, so this adapter reports tokens and no cost.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { AgentCapabilities, McpServerEntry, SendInput } from "../types.js";
import { AdapterBase, ADAPTER_CAPABILITIES, agentEnv, cliAvailable, frameBriefing, guardNativeOutput, quiesceProcessGroup, trackNativeExit } from "./base.js";
import { CodexRpc, type Json, type RpcError } from "./codex-rpc.js";
import { permissionFor } from "../core/permissions.js";
import { requestApproval } from "../core/approvals.js";
import { ContextArtifacts } from "../core/continuity/artifacts.js";
import { NativeDispatchRejected, NativeQuiescenceUnknown, NativeSessionMissing } from "../core/continuity/contracts.js";
import { VERSION } from "../version.js";

interface CodexOptions {
  /** Sandbox policy for model-run commands; default "workspace-write". */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Optional model override. */
  model?: string;
  /** Absolute path to the codex binary, when it's somewhere unusual. */
  bin?: string;
  /** Extra `codex app-server` args (e.g. `-c key=value`), escape hatch. */
  extraArgs?: string[];
  /** Loom project id, for approval cards. */
  loomProject?: string;
}

/** The CLI bundled inside the desktop app, per platform. */
const BUNDLED = [
  "/Applications/Codex.app/Contents/Resources/codex",
  `${process.env.HOME ?? ""}/Applications/Codex.app/Contents/Resources/codex`,
];
const SIGNED_OUT = /\b(?:not\s+(?:logged|signed)\s+in|not\s+authenticated|authentication\s+required|login\s+required|please\s+log\s+in)\b/i;
const MISSING_THREAD = /not found|missing thread|no such thread|unknown thread|does not exist|no rollout found/i;

function codexFailure(message: string, stderr = ""): string {
  if (SIGNED_OUT.test(`${message}\n${stderr}`)) return "codex not signed in — run `codex login` and try again";
  return message;
}

/**
 * Where the codex CLI is on this machine: an explicit override, then PATH,
 * then inside the app bundle.
 */
export function codexBin(override?: string): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  for (const p of BUNDLED) {
    if (fs.existsSync(p)) return p;
  }
  return "codex"; // let PATH resolution (and cliAvailable) decide
}

/** A project MCP server as a Codex `mcp_servers.<key>` config value. */
function codexMcpServer(entry: McpServerEntry): Json {
  if (entry.type === "stdio") return { command: entry.command, ...(entry.args ? { args: entry.args } : {}), ...(entry.env ? { env: entry.env } : {}) };
  // Codex's key for per-server HTTP headers is unverified; a guessed key is
  // either ignored or rejected, so headers are deliberately not sent.
  return { url: entry.url };
}

type Usage = { input: number; cached: number; output: number; reasoning: number };
const usageOf = (u: Json | undefined): Usage => ({ input: Number(u?.inputTokens ?? 0), cached: Number(u?.cachedInputTokens ?? 0),
  output: Number(u?.outputTokens ?? 0), reasoning: Number(u?.reasoningOutputTokens ?? 0) });

interface Turn {
  child: ChildProcess;
  rpc: CodexRpc;
  threadId: string | null;
  turnId: string | null;
  /** Settles with the turn's final status, or rejects when the process dies first. */
  done: Promise<{ status: string; error: string | null }>;
  interrupted: boolean;
  closed: boolean;
  stderr: () => string;
  /** Aborted at shutdown, so approval cards still open are closed. */
  abort: AbortController;
  /** Waits for inherited-pipe drain and descendant cleanup after exit. */
  quiesce: () => Promise<void>;
}

export class CodexAdapter extends AdapterBase {
  /** Project MCP servers ride `thread/start` config, so SendInput.mcp is real. */
  override readonly capabilities: AgentCapabilities = { ...ADAPTER_CAPABILITIES, mcp: true };
  private options: CodexOptions;
  private turn: Turn | null = null;
  private settled: Promise<void> | null = null;
  // The model codex actually ran, for the turn's gen_ai span. Cleared each turn.
  private lastModel: string | null = null;

  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) {
    super(id, "codex", projectDir);
    this.options = options as CodexOptions;
  }

  /** Codex calls it a thread; loom stores it in the same slot as any session. */
  private get threadId(): string | undefined {
    if (this.continuityTurn) return this.continuityTurn.nativeSessionId ?? undefined;
    return this.nativeState.read().sessionId as string | undefined;
  }

  private set threadId(value: string | undefined) {
    if (this.continuityTurn) { this.continuityTurn.nativeSessionId = value ?? null; return; }
    this.nativeState.patch({ sessionId: value });
  }

  async available(): Promise<boolean> {
    const bin = codexBin(this.options.bin);
    if (!bin) return false;
    return cliAvailable(bin);
  }

  async start(): Promise<void> {
    this.emit({ kind: "status", payload: { state: "ready", session: this.threadId ?? null } });
  }

  async stop(): Promise<void> {
    await this.interrupt();
  }

  /** Thread settings from the permission mode, applied on start and resume. */
  private threadParams(input: SendInput): Json {
    // bypass: no sandbox, no approvals. auto: sandboxed writes, never asks.
    // ask: read-only sandbox; every command and edit waits for approval in Loom.
    const mode = permissionFor("codex", this.options as Record<string, unknown>);
    const sandbox = this.options.sandbox ?? (mode === "bypass" ? "danger-full-access" : mode === "ask" ? "read-only" : "workspace-write");
    const model = input.model ?? this.options.model;
    const mcp = input.mcp?.servers.length
      ? Object.fromEntries(input.mcp.servers.map(s => [`mcp_servers.${s.key}`, codexMcpServer(s.entry)])) : undefined;
    return { cwd: this.projectDir, sandbox, approvalPolicy: mode === "ask" ? "untrusted" : "never", approvalsReviewer: "user",
      ...(model ? { model } : {}), ...(mcp ? { config: mcp } : {}) };
  }

  async send(input: SendInput): Promise<void> {
    if (this._busy) throw new Error(`codex agent "${this.id}" is busy`);
    const bin = codexBin(this.options.bin);
    if (!bin) throw new NativeDispatchRejected("codex CLI not found — install it or open Codex.app once");
    this._busy = true;
    this.beginContinuity(input);
    const started = Date.now();
    let release!: () => void;
    this.settled = new Promise(resolve => { release = resolve; });
    let child: ChildProcess | null = null, turnStarted = false;
    try {
      // Codex has no per-turn system channel, so a briefing rides in front of
      // the text, framed as an unmissable block (see frameBriefing).
      const text = input.continuity
        ? [input.continuity.context, input.briefing, input.text].filter(Boolean).join("\n\n")
        : input.briefing ? `${frameBriefing(input.briefing)}\n\n${input.text}` : input.text;
      const args = ["app-server", ...(this.options.extraArgs ?? [])];
      child = spawn(bin, args, { cwd: this.projectDir, detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"], env: agentEnv() });
      const proc = child;
      if (!proc.pid) await new Promise<void>((_, reject) => proc.once("error", e => reject(new NativeDispatchRejected(e.message))));
      const turn = this.openTurn(proc);
      await turn.rpc.request("initialize", { clientInfo: { name: "loom", title: "Loom", version: VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false } });
      turn.rpc.notify("initialized");

      const params = this.threadParams(input);
      const bound = this.threadId;
      let opened: Json;
      try {
        opened = bound
          ? await turn.rpc.request("thread/resume", { threadId: bound, ...params, excludeTurns: true })
          : await turn.rpc.request("thread/start", params);
      } catch (error) {
        const message = (error as Error).message;
        // No turn exists yet, so nothing was submitted. A lost native session
        // is rebuilt by Brain; a plain resume slot just starts fresh.
        if (bound && MISSING_THREAD.test(message)) {
          if (input.continuity) throw new NativeSessionMissing(`codex thread ${bound} could not be resumed: ${message}`);
          opened = await turn.rpc.request("thread/start", params);
        } else throw new NativeDispatchRejected(codexFailure(`codex could not open its thread: ${message}`, turn.stderr()));
      }
      const thread = (opened.thread ?? {}) as Json;
      const threadId = String(thread.id ?? bound ?? "");
      if (!threadId) throw new NativeDispatchRejected("codex app-server returned no thread id");
      turn.threadId = threadId;
      this.threadId = threadId;
      if (typeof opened.model === "string" && opened.model) this.lastModel = opened.model;
      this.emit({ kind: "status", payload: { state: "turn_started", session: threadId } });
      if (turn.interrupted) throw new NativeDispatchRejected("interrupted before the turn started");

      turnStarted = true; // from here the prompt may have been submitted
      let response: Json;
      try {
        response = await turn.rpc.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }],
          ...(input.continuity ? { clientUserMessageId: input.continuity.runId } : {}),
          ...(params.model ? { model: params.model } : {}) });
      } catch (error) {
        // An error *response* is a refusal: the server did not start the turn.
        // A dead process or timeout is not — that outcome stays unknown.
        if ((error as RpcError).code === undefined) throw error;
        const message = codexFailure(`codex refused the turn: ${(error as Error).message}`, turn.stderr());
        this.emit({ kind: "error", payload: { message } });
        throw new NativeDispatchRejected(message);
      }
      const turnId = String((response.turn as Json | undefined)?.id ?? "");
      if (turnId) turn.turnId = turnId;
      this.accepted();
      if (turn.interrupted && turnId) await turn.rpc.request("turn/interrupt", { threadId, turnId }).catch(() => {});

      const outcome = await turn.done;
      await this.shutdown(turn);
      if (outcome.status === "interrupted") {
        this.emit({ kind: "status", payload: { state: "interrupted" } });
        return;
      }
      if (outcome.status !== "completed") {
        const message = codexFailure(outcome.error ?? "codex reported a failed turn", turn.stderr());
        this.emit({ kind: "error", payload: { message } });
        throw new Error(message);
      }
      // Blocked-on-human heuristic: the turn ended on a question.
      if (/\?\s*$/.test(this.lastMessage.trim())) {
        this.emit({ kind: "needs_input", payload: { question: this.lastMessage.slice(-500) } });
      }
      this.emit({ kind: "run_complete", payload: { durationMs: Date.now() - started,
        ...(this.lastModel ? { model: this.lastModel } : {}),
        // Codex's input already includes cached tokens, and its output already
        // includes reasoning (totalTokens = input + output), as t3code reads it.
        ...(this.turnUsage ? { inputTokens: this.turnUsage.input, outputTokens: this.turnUsage.output } : {}) } });
    } catch (error) {
      const turn = this.turn;
      if (turn) {
        try { await this.shutdown(turn); }
        catch (shutdownError) { if (shutdownError instanceof NativeQuiescenceUnknown) throw shutdownError; }
      }
      if (error instanceof NativeQuiescenceUnknown) throw error;
      if (turn?.interrupted && !turnStarted) {
        // Stopped before any prompt reached Codex: interrupted, not failed.
        this.emit({ kind: "status", payload: { state: "interrupted" } });
        if (input.continuity) throw new NativeDispatchRejected("interrupted before the turn started");
        return;
      }
      if (error instanceof NativeDispatchRejected) throw error;
      const stderr = turn?.stderr() ?? "";
      if (!turnStarted) {
        const message = codexFailure((error as Error).message, stderr);
        this.emit({ kind: "error", payload: { message, ...(stderr ? { stderr } : {}) } });
        throw new NativeDispatchRejected(message);
      }
      if (!this.turnFinished) {
        // A stream failure (an oversized record, a handler error) says what
        // went wrong; a bare exit only that the process is gone.
        const cause = (error as Error).message;
        const message = /exited before the turn completed/.test(cause)
          ? codexFailure("codex app-server exited before the turn completed; native outcome is unknown", stderr)
          : `${cause}; native outcome is unknown`;
        this.emit({ kind: "error", payload: { message, ...(stderr ? { stderr } : {}) } });
        throw new Error(message);
      }
      throw error;
    } finally {
      this.turn = null;
      this.turnBaseline = null;
      this.turnUsage = null;
      this.turnFinished = false;
      this.lastModel = null;
      this.lastMessage = "";
      this.compacting = false;
      this._busy = false;
      this.endContinuity();
      release();
    }
  }

  // Per-turn state read by the notification handlers.
  private lastMessage = "";
  private turnUsage: Usage | null = null;
  private turnFinished = false;
  private compacting = false;
  private acceptedEmitted = false;

  private accepted(): void {
    if (this.acceptedEmitted) return;
    this.acceptedEmitted = true;
    if (this.continuityTurn) this.emit({ kind: "status", payload: { state: "native_turn_accepted" } });
  }

  private openTurn(child: ChildProcess): Turn {
    this.acceptedEmitted = false;
    let stderrTail = "";
    child.stderr?.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    let finish!: (value: { status: string; error: string | null }) => void, fail!: (error: Error) => void;
    const done = new Promise<{ status: string; error: string | null }>((resolve, reject) => { finish = resolve; fail = reject; });
    done.catch(() => {});
    const rpc = new CodexRpc(child, {
      notification: (method, params) => {
        try { this.notification(method, params, finish); }
        catch (error) { fail(error as Error); }
      },
      request: (method, params) => this.serverRequest(method, params),
    });
    const quiesce = trackNativeExit(child, error => fail(error));
    // An oversized record is dropped, not imported: stop reading before failing.
    guardNativeOutput(child, error => { rpc.close(error); fail(error); try { child.kill("SIGKILL"); } catch { /* lease stays held */ } });
    child.once("close", code => {
      rpc.close(new Error(`codex app-server exited${code === null ? "" : ` ${code}`}`));
      fail(new Error("codex app-server exited before the turn completed"));
    });
    const turn: Turn = { child, rpc, threadId: null, turnId: null, done,
      interrupted: false, closed: false, stderr: () => stderrTail, abort: new AbortController(), quiesce };
    this.turn = turn;
    return turn;
  }

  /** End the per-turn process and its group; a group that won't die holds the lease. */
  private async shutdown(turn: Turn): Promise<void> {
    if (turn.closed) return;
    turn.closed = true;
    turn.abort.abort();
    const { child } = turn;
    turn.rpc.close(new Error("turn finished"));
    child.stdin?.end();
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
      } else child.kill("SIGTERM");
      const timeout = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 3000).unref());
      if (await Promise.race([closed, timeout]) === "timeout") {
        try { child.kill("SIGKILL"); } catch { /* checked below */ }
        await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000).unref())]);
      }
    }
    await turn.quiesce();
    if (child.pid && process.platform !== "win32") await quiesceProcessGroup(child.pid);
  }

  private notification(method: string, params: Json, finish: (value: { status: string; error: string | null }) => void): void {
    const turn = this.turn;
    // Sub-agent threads report their own items; this turn's thread is the one.
    if (turn?.threadId && typeof params.threadId === "string" && params.threadId !== turn.threadId) return;
    switch (method) {
      case "turn/started":
        this.accepted();
        return;
      case "item/started": {
        const item = (params.item ?? {}) as Json;
        if (item.type === "contextCompaction" && !this.compacting) {
          this.compacting = true;
          this.emit({ kind: "status", payload: { state: "compacting" } });
        }
        return; // an item that only started has nothing to report yet
      }
      case "item/completed":
        this.item((params.item ?? {}) as Json);
        return;
      case "thread/compacted": // deprecated form; the item carries it on current versions
        if (!this.compacting) this.compacted();
        return;
      case "thread/tokenUsage/updated":
        this.tokenUsage((params.tokenUsage ?? {}) as Json);
        return;
      case "account/rateLimits/updated":
        this.rateLimits((params.rateLimits ?? {}) as Json);
        return;
      case "error": {
        // A retried stream error is a notice; a final failure also arrives as
        // a failed turn/completed, which is what fails the turn.
        const error = (params.error ?? {}) as Json;
        this.emit({ kind: "status", payload: { state: "notice", message: String(error.message ?? "codex error"),
          ...(params.willRetry === true ? { retrying: true } : {}) } });
        return;
      }
      case "turn/completed": {
        const t = (params.turn ?? {}) as Json;
        if (turn?.turnId && t.id !== turn.turnId) return;
        this.turnFinished = true;
        const error = (t.error ?? null) as Json | null;
        finish({ status: String(t.status ?? "failed"), error: error ? String(error.message ?? "codex failed") : null });
        return;
      }
      default:
        return;
    }
  }

  private tokenUsage(usage: Json): void {
    const total = usageOf(usage.total as Json), last = usageOf(usage.last as Json);
    const window = typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : null;
    // `last` is the newest model response; the context now holds its total.
    const used = Number((usage.last as Json | undefined)?.totalTokens ?? 0);
    // Turn usage: growth of the running total, seeded by the first response.
    this.turnBaseline ??= { total, first: last };
    const b = this.turnBaseline;
    this.turnUsage = { input: total.input - b.total.input + b.first.input, cached: total.cached - b.total.cached + b.first.cached,
      output: total.output - b.total.output + b.first.output, reasoning: total.reasoning - b.total.reasoning + b.first.reasoning };
    if (this.turnUsage.input < 0) this.turnUsage = last; // Codex reset its running total
    this.emit({ kind: "status", payload: { state: "turn_tokens", inputTokens: this.turnUsage.input,
      cachedInputTokens: this.turnUsage.cached, outputTokens: this.turnUsage.output, reasoningTokens: this.turnUsage.reasoning } });
    if (used > 0) this.contextUsed = used;
    if (used > 0) this.emit({ kind: "status", payload: { state: "context_usage", usedTokens: used,
      ...(window ? { maxTokens: window } : {}), autoCompacts: true } });
  }
  private turnBaseline: { total: Usage; first: Usage } | null = null;
  /** Tokens in context at the last report; what a compaction started from. Outlives turns. */
  private contextUsed: number | null = null;

  private compacted(): void {
    // Codex reports the size after compaction on its next token update.
    this.emit({ kind: "status", payload: { state: "native_compacted", trigger: "auto",
      ...(this.contextUsed ? { preTokens: this.contextUsed } : {}) } });
  }

  private rateLimits(snapshot: Json): void {
    const windows = (["primary", "secondary"] as const).flatMap(key => {
      const w = snapshot[key] as Json | null | undefined;
      if (!w || typeof w.usedPercent !== "number") return [];
      return [{ id: key, usedPercent: w.usedPercent, ...(typeof w.windowDurationMins === "number" ? { windowMinutes: w.windowDurationMins } : {}),
        ...(typeof w.resetsAt === "number" ? { resetsAt: w.resetsAt * 1000 } : {}) }];
    });
    if (windows.length) this.emit({ kind: "status", payload: { state: "usage_limits", provider: "codex", windows,
      ...(typeof snapshot.rateLimitReachedType === "string" ? { reached: snapshot.rateLimitReachedType } : {}) } });
  }

  private item(item: Json): void {
    switch (item.type) {
      case "agentMessage": {
        const text = String(item.text ?? "");
        if (!text.trim()) return;
        this.lastMessage = text;
        this.emit({ kind: "message", payload: { text } });
        return;
      }
      case "reasoning": {
        const parts = [...((item.summary as unknown[]) ?? []), ...((item.content as unknown[]) ?? [])].map(String);
        const text = parts.join("\n").trim();
        if (text) this.emit({ kind: "message", payload: { text, reasoning: true } });
        return;
      }
      case "commandExecution": {
        const command = String(item.command ?? "");
        const exit = item.exitCode;
        const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null;
        const outputArtifact = this.continuityTurn && output !== null && output.length > 100_000
          ? new ContextArtifacts(this.projectDir).put(JSON.stringify({ version: 1, output })) : undefined;
        this.emit({ kind: "tool_call", payload: { tool: "shell", summary: `shell: ${command.replace(/\s+/g, " ").slice(0, 160)}`,
          exitCode: typeof exit === "number" ? exit : null,
          ...(this.continuityTurn ? { outcome: typeof exit === "number" ? exit === 0 ? "success" : "failure" : item.status === "declined" ? "cancelled" : "unknown",
            output: output?.slice(0, 100_000) ?? null, ...(outputArtifact ? { outputArtifact } : {}),
            outputTruncated: output !== null && output.length > 100_000 } : {}) } });
        return;
      }
      case "fileChange": {
        for (const change of (item.changes as Array<{ path?: string; kind?: { type?: string } }> | undefined) ?? []) {
          if (!change.path) continue;
          this.emit({ kind: "file_edit", payload: { path: String(change.path), tool: `file_change:${change.kind?.type ?? "update"}` } });
        }
        return;
      }
      case "mcpToolCall":
        this.emit({ kind: "tool_call", payload: { tool: String(item.tool ?? "mcp"), summary: `mcp: ${String(item.tool ?? "")}` } });
        return;
      case "webSearch":
        this.emit({ kind: "tool_call", payload: { tool: "web_search", summary: `search: ${String(item.query ?? "")}`.slice(0, 160) } });
        return;
      case "contextCompaction":
        this.compacting = false;
        this.compacted();
        return;
      default:
        // Plans, images and whatever Codex adds next: inventing a rendering
        // for an item we don't understand is worse than staying quiet.
        return;
    }
  }

  /** Server requests. Approvals go to the person, through Loom; anything
   * this adapter can't answer is declined rather than left waiting. */
  private async serverRequest(method: string, params: Json): Promise<Json> {
    const signal = this.turn?.abort.signal;
    const ask = async (tool: string, input: Json, summary: string) => (await requestApproval({
      project: String(this.options.loomProject ?? ""), agent: this.id, tool, input, summary, ...(signal ? { signal } : {}) })).behavior === "allow";
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const command = String(params.command ?? "");
        return { decision: await ask("shell", { command, cwd: params.cwd ?? null, reason: params.reason ?? null }, `shell: ${command}`.slice(0, 200)) ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval":
        return { decision: await ask("file_change", { reason: params.reason ?? null, grantRoot: params.grantRoot ?? null }, "apply file changes") ? "accept" : "decline" };
      case "execCommandApproval": {
        const command = Array.isArray(params.command) ? params.command.join(" ") : String(params.command ?? "");
        return { decision: await ask("shell", { command }, `shell: ${command}`.slice(0, 200)) ? "approved" : { denied: { rejection: "Denied in Loom." } } };
      }
      case "applyPatchApproval":
        return { decision: await ask("file_change", { reason: params.reason ?? null }, "apply file changes") ? "approved" : { denied: { rejection: "Denied in Loom." } } };
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" }; // an empty grant withholds the escalation
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      case "item/tool/requestUserInput":
        return { answers: {} };
      default:
        throw new Error(`Loom does not handle ${method}`);
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) {
      if (this._busy) throw new Error("native turn is still preparing; quiescence is not established");
      return;
    }
    turn.interrupted = true;
    if (turn.threadId && turn.turnId) await turn.rpc.request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId }, 5000).catch(() => {});
    else if (turn.child.pid && process.platform !== "win32") { try { process.kill(-turn.child.pid, "SIGINT"); } catch { /* gone */ } }
    // The turn settles once its process group has exited; an unproven stop
    // is an error, never a silent release.
    const settled = this.settled ?? Promise.resolve();
    const deadline = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 10_000).unref());
    if (await Promise.race([settled.then(() => "done" as const), deadline]) === "timeout")
      throw new NativeQuiescenceUnknown("codex did not stop after interruption; quiescence unknown");
  }
}
