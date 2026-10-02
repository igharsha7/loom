/**
 * Codex on the provider contract: one warm `codex app-server` per chat session.
 *
 *   initialize → thread/start | thread/resume          (startSession)
 *   turn/start → … notifications … → turn/completed    (sendTurn, many per process)
 *   turn/interrupt                                     (interruptTurn)
 *
 * The thread stays open between turns, so a follow-up costs one `turn/start`
 * rather than a process launch and a thread resume. Native notifications and
 * server requests are mapped onto the canonical runtime events; nothing above
 * this file reads a Codex message.
 *
 * Ported from t3code (MIT, © T3 Tools Inc.):
 *   apps/server/src/provider/Layers/CodexSessionRuntime.ts (session lifecycle,
 *   thread open/resume, turn params, approvals) and CodexAdapter.ts
 *   (mapToRuntimeEvents, toCanonicalItemType, normalizeCodexTokenUsage).
 * Protocol shapes follow `codex app-server generate-ts` (checked against
 * codex-cli 0.153.4).
 */

import { codexCapabilities } from "../drivers/capabilities.js";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { guardNativeOutput } from "../../adapters/base.js";
import { VERSION } from "../../version.js";
import { EventHub, type ProviderAdapter } from "../adapter.js";
import type {
  AdapterCapabilities, ApprovalDecision, CanonicalItemType, CanonicalRequestType, ContentStreamKind, InstanceId,
  ItemLifecyclePayload, ProviderRuntimeEvent, ProviderSession, RequestId, RollbackResult, RuntimeEventPayloads, RuntimeEventType,
  RuntimeItemStatus, RuntimeMode, RuntimeTurnState, SendTurnInput, SessionStartInput, ThreadId, TurnId, TurnStartResult,
  UserInputAnswers, UserInputQuestion,
} from "../contracts.js";
import { ProviderError } from "../errors.js";
import { launched, spawnHarness, stopHarness, type HarnessProcess } from "../process.js";
import { codexDeveloperInstructions } from "./instructions.js";
import { CodexRpc, type Json, type RpcError } from "./rpc.js";

export interface CodexAdapterOptions {
  /** Absolute path to the codex binary, when it's somewhere unusual. */
  bin?: string;
  /** Extra `codex app-server` args (e.g. `-c key=value`), escape hatch. */
  extraArgs?: string[];
  /** Overrides the sandbox the runtime mode implies. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Project MCP servers, as Codex `mcp_servers.<key>` config values, applied at thread open. */
  mcpConfig?: () => Record<string, Json> | undefined;
}

/** The CLI bundled inside the desktop app. */
const BUNDLED = [
  "/Applications/Codex.app/Contents/Resources/codex",
  `${process.env.HOME ?? ""}/Applications/Codex.app/Contents/Resources/codex`,
];

/** Where the codex CLI is: an explicit override, the app bundle, then PATH. */
export function codexBin(override?: string): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  for (const p of BUNDLED) if (fs.existsSync(p)) return p;
  return "codex";
}

const SIGNED_OUT = /\b(?:not\s+(?:logged|signed)\s+in|not\s+authenticated|authentication\s+required|login\s+required|please\s+log\s+in)\b/i;
/** t3code's RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS. */
const MISSING_THREAD = /not found|missing thread|no such thread|unknown thread|does not exist|no rollout found/i;

export function codexFailure(message: string, stderr = ""): string {
  if (SIGNED_OUT.test(`${message}\n${stderr}`)) return "codex not signed in — run `codex login` and try again";
  return message;
}

/**
 * Sandbox and approval policy for a runtime mode, as Loom's permission modes
 * have always meant them: full access asks nothing; auto-accept works inside
 * the workspace sandbox and never asks; approval-required is read-only and
 * every command or edit waits for a person. (t3code's auto-accept-edits uses
 * `on-request`; Loom's "auto" promises it never stops to ask.)
 */
export function codexThreadPolicy(mode: RuntimeMode, sandboxOverride?: CodexAdapterOptions["sandbox"]): { sandbox: string; approvalPolicy: string } {
  const sandbox = sandboxOverride ?? (mode === "full-access" ? "danger-full-access" : mode === "approval-required" ? "read-only" : "workspace-write");
  return { sandbox, approvalPolicy: mode === "approval-required" ? "untrusted" : "never" };
}

/** t3code's toCanonicalItemType, on Codex item type names. */
export function codexItemType(raw: unknown): CanonicalItemType {
  const type = String(raw ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._/-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!type) return "unknown";
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit")) return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

const REQUEST_TYPES: Record<string, CanonicalRequestType> = {
  "item/commandExecution/requestApproval": "command_execution_approval",
  "item/fileRead/requestApproval": "file_read_approval",
  "item/fileChange/requestApproval": "file_change_approval",
  applyPatchApproval: "apply_patch_approval",
  execCommandApproval: "exec_command_approval",
  "item/permissions/requestApproval": "permission_approval",
  "mcpServer/elicitation/request": "mcp_elicitation_approval",
  "item/tool/requestUserInput": "tool_user_input",
};

const DELTA_KINDS: Record<string, ContentStreamKind> = {
  "item/agentMessage/delta": "assistant_text",
  "item/reasoning/textDelta": "reasoning_text",
  "item/reasoning/summaryTextDelta": "reasoning_summary_text",
  "item/commandExecution/outputDelta": "command_output",
  "item/fileChange/outputDelta": "file_change_output",
};

const TURN_STATES: Record<string, RuntimeTurnState> = { completed: "completed", failed: "failed", interrupted: "interrupted", cancelled: "cancelled" };
const ITEM_STATUSES = new Set<RuntimeItemStatus>(["inProgress", "completed", "failed", "declined"]);

type Usage = { input: number; cached: number; output: number; reasoning: number };
const usageOf = (u: Json | undefined): Usage => ({ input: Number(u?.inputTokens ?? 0), cached: Number(u?.cachedInputTokens ?? 0),
  output: Number(u?.outputTokens ?? 0), reasoning: Number(u?.reasoningOutputTokens ?? 0) });

interface PendingRequest {
  method: string;
  requestType: CanonicalRequestType;
  turnId?: TurnId;
  params: Json;
  resolve: (decision: ApprovalDecision) => void;
}

interface PendingInput { turnId?: TurnId; resolve: (answers: UserInputAnswers) => void }

interface Session {
  info: ProviderSession;
  proc: HarnessProcess;
  rpc: CodexRpc;
  providerThreadId: string;
  pending: Map<RequestId, PendingRequest>;
  inputs: Map<RequestId, PendingInput>;
  asyncQuestions?: Set<string>;
  defaultModel?: string;
  /** Whether a turn ran in plan mode; the next default turn must say so to leave it. */
  planMode: boolean;
  /** Turns that already finished; a turn can finish before turn/start answers. */
  finished: Set<TurnId>;
  /** Native children hold settlement independently of their spawning tool call. */
  children: Map<string, boolean>;
  childTurns: Set<string>;
  /** Per turn: running usage at the first report, to compute the turn's own usage. */
  baseline: { total: Usage; first: Usage } | null;
  turnUsage: Usage | null;
  /** Tokens in context at the last report: what a compaction started from. */
  contextUsed?: number;
  compacting: boolean;
  stopping: boolean;
  /** Why the session is being torn down, when it is a failure (not a stop). */
  failure?: string;
}

export class CodexProviderAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly capabilities: AdapterCapabilities = codexCapabilities;
  private readonly sessions = new Map<ThreadId, Session>();
  private readonly hub = new EventHub<ProviderRuntimeEvent>();

  constructor(readonly instanceId: InstanceId, private readonly options: CodexAdapterOptions = {}) {}

  onEvent(listener: (event: ProviderRuntimeEvent) => void): () => void { return this.hub.subscribe(listener); }
  listSessions(): ProviderSession[] { return [...this.sessions.values()].map(s => ({ ...s.info })); }
  hasSession(threadId: ThreadId): boolean { return this.sessions.has(threadId); }

  private emit<K extends RuntimeEventType>(threadId: ThreadId, type: K, payload: RuntimeEventPayloads[K],
    extra: { turnId?: TurnId; itemId?: string; requestId?: RequestId; method?: string } = {}): void {
    this.hub.publish({ eventId: randomUUID(), provider: this.provider, instanceId: this.instanceId, threadId, createdAt: Date.now(),
      ...(extra.turnId ? { turnId: extra.turnId } : {}), ...(extra.itemId ? { itemId: extra.itemId } : {}),
      ...(extra.requestId ? { requestId: extra.requestId } : {}), type, payload } as ProviderRuntimeEvent);
  }

  // ---- sessions ------------------------------------------------------------

  async startSession(input: SessionStartInput): Promise<ProviderSession> {
    const existing = this.sessions.get(input.threadId);
    if (existing) await this.stopSession(input.threadId);
    const bin = codexBin(this.options.bin);
    let proc: HarnessProcess | undefined;
    const fail = (code: "transport" | "request" | "session_missing", message: string, cause?: unknown) => {
      const stderr = proc?.stderr().trim();
      return new ProviderError(code, "startSession", message, { provider: this.provider, instanceId: this.instanceId, threadId: input.threadId,
        mayHaveStarted: false, cause, ...(stderr ? { stderr } : {}) });
    };
    if (!bin) throw fail("transport", "codex CLI not found — install it or open Codex.app once");
    const extraArgs = this.options.extraArgs ?? [];
    if (!Array.isArray(extraArgs) || extraArgs.some(a => typeof a !== "string"))
      throw new ProviderError("validation", "startSession", "extraArgs must be a list of strings", { provider: this.provider, instanceId: this.instanceId, threadId: input.threadId });

    this.emit(input.threadId, "session.state.changed", { state: "starting" });
    proc = spawnHarness(bin, ["app-server", ...extraArgs], { cwd: input.cwd });
    try { await launched(proc.child); }
    catch (error) { throw fail("transport", `${bin}: ${(error as Error).message}`, error); }

    const now = Date.now();
    const session: Session = {
      info: { provider: this.provider, instanceId: this.instanceId, threadId: input.threadId, status: "connecting",
        runtimeMode: input.runtimeMode, cwd: input.cwd, processGroupId: proc.child.pid, createdAt: now, updatedAt: now,
        ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}) },
      proc, rpc: undefined as unknown as CodexRpc, providerThreadId: "", pending: new Map(), inputs: new Map(), planMode: false, finished: new Set(), children: new Map(), childTurns: new Set(),
      baseline: null, turnUsage: null, compacting: false, stopping: false,
    };
    session.rpc = new CodexRpc(proc.child, {
      notification: (method, params) => this.notification(session, method, params),
      request: (method, params) => this.serverRequest(session, method, params),
    });
    // An oversized record is dropped, not imported: stop reading and end the session.
    guardNativeOutput(proc.child, error => {
      session.rpc.close(error);
      session.failure = error.message;
      if (!session.info.activeTurnId) this.emit(input.threadId, "runtime.error", { message: error.message, class: "transport_error" });
      void this.stopSession(input.threadId).catch(() => {});
    });
    void proc.closed.then(({ code, quiescenceError }) => this.exited(session, code, quiescenceError));

    try {
      await session.rpc.request("initialize", { clientInfo: { name: "loom", title: "Loom", version: VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false } });
      session.rpc.notify("initialized");
      // Read the harness default independently of this chat's override.
      const config = await session.rpc.request("config/read", {}).catch(() => ({} as Json));
      const configured = (config.config as Json | undefined)?.model;
      if (typeof configured === "string" && configured) session.defaultModel = configured;
      else {
        const catalog = await session.rpc.request("model/list", {}).catch(() => ({} as Json));
        const defaultModel = (Array.isArray(catalog.data) ? catalog.data as Json[] : []).find(m => m.isDefault === true);
        if (typeof defaultModel?.model === "string") session.defaultModel = defaultModel.model;
      }
      const params = this.threadParams(input);
      const cursor = typeof input.resumeCursor === "string" && input.resumeCursor ? input.resumeCursor : undefined;
      let opened: Json;
      try {
        opened = cursor
          ? await session.rpc.request("thread/resume", { threadId: cursor, ...params, excludeTurns: true })
          : await session.rpc.request("thread/start", params);
      } catch (error) {
        const message = (error as Error).message;
        if (cursor && MISSING_THREAD.test(message)) throw fail("session_missing", `codex thread ${cursor} could not be resumed: ${message}`, error);
        throw fail("request", codexFailure(`codex could not open its thread: ${message}`, proc.stderr()), error);
      }
      const threadId = String((opened.thread as Json | undefined)?.id ?? cursor ?? "");
      if (!threadId) throw fail("request", "codex app-server returned no thread id");
      session.providerThreadId = threadId;
      session.info = { ...session.info, status: "ready", resumeCursor: threadId, updatedAt: Date.now(),
        ...(typeof opened.model === "string" && opened.model ? { model: opened.model } : {}),
        ...(typeof opened.cwd === "string" && opened.cwd ? { cwd: opened.cwd } : {}) };
    } catch (error) {
      session.stopping = true;
      try { await stopHarness(proc); }
      catch (containment) {
        this.sessions.set(input.threadId, session);
        this.containmentFailed(session, containment);
        throw containment;
      }
      if (error instanceof ProviderError) {
        const stderr = proc.stderr().trim();
        if (stderr && !error.details.stderr) error.details.stderr = stderr;
        throw error;
      }
      throw fail("transport", codexFailure(`codex app-server failed to start: ${(error as Error).message}`, proc.stderr()), error);
    }
    session.defaultModel ??= input.modelSelection?.model ? undefined : session.info.model;
    this.sessions.set(input.threadId, session);
    this.emit(input.threadId, "session.started", cursorPayload(input.resumeCursor));
    this.emit(input.threadId, "thread.started", { providerThreadId: session.providerThreadId });
    this.emit(input.threadId, "session.state.changed", { state: "ready" });
    return { ...session.info };
  }

  /** Thread settings from the runtime mode, applied on start and resume. */
  private threadParams(input: SessionStartInput): Json {
    const { sandbox, approvalPolicy } = codexThreadPolicy(input.runtimeMode, this.options.sandbox);
    const mcp = this.options.mcpConfig?.();
    return { cwd: input.cwd, sandbox, approvalPolicy, approvalsReviewer: "user",
      ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
      ...(mcp && Object.keys(mcp).length ? { config: mcp } : {}) };
  }

  private session(threadId: ThreadId, operation: string): Session {
    const s = this.sessions.get(threadId);
    if (!s || s.stopping) throw new ProviderError("not_found", operation, `no live codex session for chat "${threadId}"`,
      { provider: this.provider, instanceId: this.instanceId, threadId, mayHaveStarted: false });
    if (s.failure?.includes("quiescence unknown")) throw new ProviderError("validation", operation, s.failure);
    return s;
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const s = this.session(input.threadId, "sendTurn");
    if (s.info.activeTurnId) throw new ProviderError("validation", "sendTurn", "a codex turn is already running in this chat",
      { provider: this.provider, instanceId: this.instanceId, threadId: input.threadId, mayHaveStarted: false });
    const model = input.modelSelection?.model === null ? s.defaultModel : input.modelSelection?.model ?? s.info.model;
    if (input.modelSelection?.model === null && !model)
      throw new ProviderError("request", "sendTurn", "codex did not report its default model; cannot clear the chat override", { mayHaveStarted: false });
    const effort = input.modelSelection?.effort;
    s.baseline = null;
    s.turnUsage = null;
    // Plan mode is a collaboration mode (t3code's buildCodexCollaborationMode).
    // It lasts until a turn says otherwise, so the first default turn after a
    // plan turn carries the default mode; other turns carry none.
    const mode = input.interactionMode === "plan" ? "plan" : s.planMode ? "default" : undefined;
    const collaboration = mode ? { collaborationMode: { mode, settings: { model: model ?? "gpt-5-codex",
      reasoning_effort: effort ?? "medium", developer_instructions: codexDeveloperInstructions(mode) } } } : {};
    const answeredQuestions = [...s.asyncQuestions ?? []];
    let response: Json;
    try {
      response = await s.rpc.request("turn/start", { threadId: s.providerThreadId,
        input: [{ type: "text", text: input.input, text_elements: [] }],
        ...(input.clientTurnId ? { clientUserMessageId: input.clientTurnId } : {}),
        ...(model ? { model } : input.modelSelection?.model === null ? { model: null } : {}), ...(effort ? { effort } : {}), ...collaboration });
    } catch (error) {
      // An error *response* is a refusal: the server did not start the turn.
      // A dead process or a timeout is not — that outcome stays unknown.
      const refused = (error as RpcError).code !== undefined;
      throw new ProviderError(refused ? "request" : "transport", "sendTurn",
        codexFailure(refused ? `codex refused the turn: ${(error as Error).message}` : `${(error as Error).message}; native outcome is unknown`, s.proc.stderr()),
        { provider: this.provider, instanceId: this.instanceId, threadId: input.threadId, mayHaveStarted: !refused, cause: error,
          ...(s.proc.stderr().trim() ? { stderr: s.proc.stderr().trim() } : {}) });
    }
    for (const requestId of answeredQuestions) {
      s.asyncQuestions?.delete(requestId);
      this.emit(input.threadId, "user-input.resolved", { answers: {} }, { requestId });
    }
    if (mode) s.planMode = mode === "plan";
    const turnId = String((response.turn as Json | undefined)?.id ?? "");
    if (!turnId) throw new ProviderError("request", "sendTurn", "codex app-server returned no turn id",
      { provider: this.provider, instanceId: this.instanceId, threadId: input.threadId, mayHaveStarted: true });
    if (!s.finished.has(turnId)) s.info = { ...s.info, status: "running", activeTurnId: turnId, updatedAt: Date.now(), ...(model ? { model } : {}) };
    else if (model) s.info = { ...s.info, model };
    return { threadId: input.threadId, turnId, resumeCursor: s.providerThreadId };
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const s = this.sessions.get(threadId);
    if (!s) return;
    // Settle open approvals and questions first (t3code: the interrupt must not
    // queue behind a card nobody will answer).
    this.settlePending(s, "cancel");
    // A finished parent can still have native children writing. Contain the
    // entire process group rather than depend on child interrupt acknowledgements.
    if (s.children.size) { await this.stopSession(threadId); return; }
    const target = turnId ?? s.info.activeTurnId;
    if (!target || s.finished.has(target)) return;
    await s.rpc.request("turn/interrupt", { threadId: s.providerThreadId, turnId: target }, 5000);
  }

  async respondToRequest(threadId: ThreadId, requestId: RequestId, decision: ApprovalDecision): Promise<void> {
    const s = this.session(threadId, "respondToRequest");
    const pending = s.pending.get(requestId);
    if (!pending) throw new ProviderError("not_found", "respondToRequest", `no open codex request "${requestId}"`, { provider: this.provider, threadId });
    s.pending.delete(requestId);
    pending.resolve(decision);
    this.emit(threadId, "request.resolved", { requestType: pending.requestType, decision }, { requestId, ...(pending.turnId ? { turnId: pending.turnId } : {}) });
  }

  async respondToUserInput(threadId: ThreadId, requestId: RequestId, answers: UserInputAnswers): Promise<void> {
    const s = this.session(threadId, "respondToUserInput");
    const pending = s.inputs.get(requestId);
    if (!pending) throw new ProviderError("not_found", "respondToUserInput", `no open codex question "${requestId}"`, { provider: this.provider, threadId });
    s.inputs.delete(requestId);
    pending.resolve(answers);
    this.emit(threadId, "user-input.resolved", { answers }, { requestId, ...(pending.turnId ? { turnId: pending.turnId } : {}) });
  }

  async compact(threadId: ThreadId): Promise<void> {
    const s = this.session(threadId, "compact");
    await s.rpc.request("thread/compact/start", { threadId: s.providerThreadId });
  }

  /**
   * `thread/revert` replaces the thread's history with the turns before
   * `beforeTurnId` (t3code's rollbackCodexThread). A thread still on legacy
   * history refuses it; for that one the older `thread/rollback` drops a count
   * of turns from the end, counted on the thread as Codex reads it.
   */
  private async history(s: Session): Promise<Json[]> {
    const metadata = await s.rpc.request("thread/read", { threadId: s.providerThreadId, includeTurns: false });
    if ((metadata.thread as Json | undefined)?.historyMode !== "paginated") {
      const read = await s.rpc.request("thread/read", { threadId: s.providerThreadId, includeTurns: true });
      const turns = (read.thread as Json | undefined)?.turns;
      if (!Array.isArray(turns)) throw new Error("codex returned no thread history");
      return turns as Json[];
    }
    const turns: Json[] = [];
    const seen = new Set<string | null>();
    let cursor: string | null = null;
    do {
      if (seen.has(cursor)) throw new Error("codex history pagination repeated a cursor");
      seen.add(cursor);
      const page = await s.rpc.request("thread/turns/list", { threadId: s.providerThreadId, cursor, limit: 100, sortDirection: "asc", itemsView: "full" });
      if (!Array.isArray(page.data) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) throw new Error("codex returned invalid history pagination");
      turns.push(...page.data as Json[]);
      cursor = page.nextCursor as string | null;
    } while (cursor !== null);
    return turns;
  }

  async validateRollback(threadId: ThreadId, beforeTurnId: TurnId): Promise<string[]> {
    const s = this.session(threadId, "rollbackThread");
    const turns = await this.history(s);
    const cut = turns.findIndex(t => t.id === beforeTurnId);
    if (cut < 0)
      throw new ProviderError("request", "rollbackThread", "the turn isn't in codex's thread history, so the conversation can't be put back to before it");
    return turns.slice(0, cut).map(t => String(t.id));
  }

  async rollbackThread(threadId: ThreadId, beforeTurnId: TurnId, retainedTurnIds?: string[]): Promise<RollbackResult> {
    const s = this.session(threadId, "rollbackThread");
    const fail = (message: string, cause?: unknown) => new ProviderError("request", "rollbackThread", message,
      { provider: this.provider, instanceId: this.instanceId, threadId, cause });
    if (s.info.activeTurnId) throw new ProviderError("validation", "rollbackThread", "a codex turn is running in this chat",
      { provider: this.provider, instanceId: this.instanceId, threadId });
    // Verify before mutation. A lost acknowledgement can leave the native cut
    // complete while Loom's ledger still contains the removed boundary.
    const existing = await this.history(s);
    if (!existing.some(t => t.id === beforeTurnId)) {
      if (retainedTurnIds && JSON.stringify(existing.map(t => t.id)) === JSON.stringify(retainedTurnIds))
        return { resumeCursor: s.providerThreadId, live: true };
      throw fail(`codex history has no turn ${beforeTurnId} and does not match the retained prefix`);
    }
    try {
      await s.rpc.request("thread/revert", { threadId: s.providerThreadId, beforeTurnId });
    } catch (error) {
      if ((error as RpcError).code === undefined) throw fail(`codex did not answer the rollback: ${(error as Error).message}`, error);
      let turns: Json[];
      try {
        turns = await this.history(s);
      } catch (readError) {
        throw fail(`codex could not roll back its thread: ${(error as Error).message}`, readError);
      }
      const index = turns.findIndex(t => t.id === beforeTurnId);
      if (index < 0) throw fail(`codex could not roll back its thread (${(error as Error).message}), and its history has no turn ${beforeTurnId}`, error);
      try { await s.rpc.request("thread/rollback", { threadId: s.providerThreadId, numTurns: turns.length - index }); }
      catch (rollbackError) { throw fail(`codex could not roll back its thread: ${(rollbackError as Error).message}`, rollbackError); }
    }
    // The running totals restart from the rolled-back thread.
    s.baseline = null;
    s.turnUsage = null;
    s.finished.clear();
    return { resumeCursor: s.providerThreadId, live: true };
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const s = this.sessions.get(threadId);
    if (!s) return;
    s.stopping = true;
    this.settlePending(s, "cancel");
    try { await stopHarness(s.proc); }
    catch (error) { this.containmentFailed(s, error); throw error; }
    if (this.sessions.get(threadId) === s) this.sessions.delete(threadId);
    s.rpc.close(new Error("session stopped"));
    if (s.info.activeTurnId) {
      if (s.failure) this.emit(threadId, "turn.aborted", { reason: `${s.failure}; native outcome is unknown` }, { turnId: s.info.activeTurnId });
      else this.emit(threadId, "turn.completed", { state: "interrupted", stopReason: "session stopped" }, { turnId: s.info.activeTurnId });
    }
    s.info = { ...s.info, status: "closed", updatedAt: Date.now() };
    delete s.info.activeTurnId;
    this.emit(threadId, "session.exited", s.failure ? { reason: s.failure, exitKind: "error", recoverable: true } : { reason: "session stopped", exitKind: "graceful" });
  }

  private containmentFailed(s: Session, error: unknown): void {
    s.stopping = false;
    s.failure = `${error instanceof Error ? error.message : String(error)}; quiescence unknown`;
    s.info = { ...s.info, status: "error", updatedAt: Date.now() };
    if (s.info.activeTurnId) {
      this.emit(s.info.threadId, "turn.aborted", { reason: s.failure }, { turnId: s.info.activeTurnId });
      delete s.info.activeTurnId;
    }
    this.emit(s.info.threadId, "runtime.error", { message: s.failure, class: "transport_error" });
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.stopSession(id)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }

  /** The process went away on its own. */
  private exited(s: Session, code: number | null, quiescenceError?: Error): void {
    if (quiescenceError) { this.containmentFailed(s, quiescenceError); return; }
    s.rpc.close(new Error(`codex app-server exited${code === null ? "" : ` ${code}`}`));
    if (s.stopping) return; // stopSession reports it
    s.stopping = true;
    this.settlePending(s, "cancel");
    const threadId = s.info.threadId;
    if (this.sessions.get(threadId) === s) this.sessions.delete(threadId);
    const message = codexFailure(`codex app-server exited${code === null ? "" : ` with code ${code}`}`, s.proc.stderr());
    if (s.info.activeTurnId) {
      const stderr = s.proc.stderr().trim();
      this.emit(threadId, "turn.aborted", { reason: `${message} before the turn completed; native outcome is unknown`,
        ...(stderr ? { detail: { stderr } } : {}) }, { turnId: s.info.activeTurnId });
      delete s.info.activeTurnId;
    }
    s.info = { ...s.info, status: code === 0 ? "closed" : "error", updatedAt: Date.now() };
    this.emit(threadId, "session.exited", { reason: message, exitKind: code === 0 ? "graceful" : "error", recoverable: true });
    // The group may still hold tools the harness started.
    void stopHarness(s.proc).catch(() => {});
  }

  private settlePending(s: Session, decision: ApprovalDecision): void {
    for (const [requestId, input] of s.inputs) {
      s.inputs.delete(requestId);
      input.resolve({});
      this.emit(s.info.threadId, "user-input.resolved", { answers: {} }, { requestId, ...(input.turnId ? { turnId: input.turnId } : {}) });
    }
    for (const [requestId, pending] of s.pending) {
      s.pending.delete(requestId);
      pending.resolve(decision);
      this.emit(s.info.threadId, "request.resolved", { requestType: pending.requestType, decision }, { requestId, ...(pending.turnId ? { turnId: pending.turnId } : {}) });
    }
  }

  // ---- native → canonical --------------------------------------------------

  private notification(s: Session, method: string, params: Json): void {
    const nativeThread = typeof params.threadId === "string" ? params.threadId
      : typeof (params.thread as Json | undefined)?.id === "string" ? String((params.thread as Json).id) : undefined;
    if (s.providerThreadId && nativeThread && nativeThread !== s.providerThreadId) {
      this.childNotification(s, nativeThread, method, params);
      return;
    }
    const threadId = s.info.threadId;
    const turnId = typeof params.turnId === "string" ? params.turnId : s.info.activeTurnId;
    const at = { ...(turnId ? { turnId } : {}) };
    const deltaKind = DELTA_KINDS[method];
    if (deltaKind) {
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (delta) this.emit(threadId, "content.delta", { streamKind: deltaKind, delta,
        ...(typeof params.contentIndex === "number" ? { contentIndex: params.contentIndex } : {}) },
      { ...at, ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}) });
      return;
    }
    switch (method) {
      case "turn/started": {
        const id = String((params.turn as Json | undefined)?.id ?? "");
        if (!id) return;
        if (!s.finished.has(id)) s.info = { ...s.info, status: "running", activeTurnId: id, updatedAt: Date.now() };
        this.emit(threadId, "turn.started", s.info.model ? { model: s.info.model } : {}, { turnId: id });
        return;
      }
      case "turn/completed": {
        const turn = (params.turn ?? {}) as Json;
        const id = String(turn.id ?? s.info.activeTurnId ?? "");
        if (id) s.finished.add(id);
        if (s.info.activeTurnId === id || !id) {
          delete s.info.activeTurnId;
          s.info = { ...s.info, status: "ready", updatedAt: Date.now() };
        }
        this.settlePending(s, "cancel");
        const error = (turn.error ?? null) as Json | null;
        const u = s.turnUsage;
        this.emit(threadId, "turn.completed", { state: TURN_STATES[String(turn.status)] ?? "failed",
          ...(error?.message ? { errorMessage: codexFailure(String(error.message), s.proc.stderr()) } : {}),
          ...(s.info.model ? { model: s.info.model } : {}),
          // Codex's input already includes cached tokens, and its output already
          // includes reasoning (totalTokens = input + output), as t3code reads it.
          ...(u ? { tokenUsage: { usageStatus: "complete" as const, inputTokens: u.input, outputTokens: u.output,
            cachedInputTokens: u.cached, reasoningTokens: u.reasoning } } : {}) }, id ? { turnId: id } : {});
        return;
      }
      case "item/started":
      case "item/completed":
        this.item(s, method === "item/started" ? "item.started" : "item.completed", (params.item ?? {}) as Json, at);
        return;
      case "item/plan/delta":
        if (typeof params.delta === "string" && params.delta) this.emit(threadId, "turn.proposed.delta", { delta: params.delta }, at);
        return;
      case "turn/plan/updated": {
        const plan = Array.isArray(params.plan) ? params.plan as Json[] : [];
        this.emit(threadId, "turn.plan.updated", { ...(typeof params.explanation === "string" ? { explanation: params.explanation } : {}),
          plan: plan.map(p => ({ step: String(p.step ?? "step"), status: p.status === "completed" || p.status === "inProgress" ? p.status : "pending" as const })) }, at);
        return;
      }
      case "turn/diff/updated":
        if (typeof params.diff === "string") this.emit(threadId, "turn.diff.updated", { unifiedDiff: params.diff }, at);
        return;
      case "thread/tokenUsage/updated":
        this.tokenUsage(s, (params.tokenUsage ?? {}) as Json, at);
        return;
      case "thread/compacted": // deprecated form; the contextCompaction item carries it on current versions
        if (!s.compacting) this.emit(threadId, "thread.state.changed", { state: "compacted", trigger: "auto",
          ...(s.contextUsed ? { beforeTokens: s.contextUsed } : {}) }, at);
        return;
      case "account/rateLimits/updated":
        this.rateLimits(s, (params.rateLimits ?? {}) as Json);
        return;
      case "model/rerouted":
        if (typeof params.fromModel === "string" && typeof params.toModel === "string") {
          s.info = { ...s.info, model: params.toModel };
          this.emit(threadId, "model.rerouted", { fromModel: params.fromModel, toModel: params.toModel,
            ...(typeof params.reason === "string" ? { reason: params.reason } : {}) }, at);
        }
        return;
      case "configWarning":
      case "deprecationNotice":
        if (typeof params.summary === "string") this.emit(threadId, "config.warning", { summary: params.summary,
          ...(typeof params.details === "string" ? { details: params.details } : {}) }, at);
        return;
      case "error": {
        // A retried stream error is a warning; a final failure also arrives as
        // a failed turn/completed, which is what fails the turn.
        const error = (params.error ?? {}) as Json;
        this.emit(threadId, "runtime.warning", { message: String(error.message ?? "codex error"),
          ...(params.willRetry === true ? { retrying: true } : {}) }, at);
        return;
      }
      default:
        return;
    }
  }

  private childState(s: Session, id: string, running: boolean): void {
    const previous = s.children.get(id);
    s.children.set(id, running);
    if (previous === running || (!running && previous === undefined)) return;
    this.emit(s.info.threadId, running ? "item.started" : "item.completed",
      { itemType: "collab_agent_tool_call", status: running ? "inProgress" : "completed",
        title: "Codex child agent", data: { nativeChild: true } }, { itemId: `child:${id}` });
  }

  private childNotification(s: Session, id: string, method: string, params: Json): void {
    if (method === "turn/started") { s.childTurns.add(id); this.childState(s, id, true); }
    else if (method === "turn/completed" || method === "thread/closed") { s.childTurns.delete(id); this.childState(s, id, false); }
    else if (method === "thread/status/changed") {
      const status = (params.status as Json | undefined)?.type;
      if (status === "active") { s.childTurns.add(id); this.childState(s, id, true); }
      else if (status === "idle" || status === "notLoaded") { s.childTurns.delete(id); this.childState(s, id, false); }
    } else if (method === "item/started" || method === "item/completed") {
      const item = (params.item ?? {}) as Json;
      // Commands have their own settlement even after the child's turn ends.
      if (codexItemType(item.type) === "command_execution") {
        if (!s.children.has(id)) this.childState(s, id, true);
        this.item(s, method === "item/started" ? "item.started" : "item.completed",
          { ...item, id: `child:${id}:${String(item.id ?? "command")}` }, {});
      }
      this.rememberChildren(s, item);
    }
  }

  private rememberChildren(s: Session, item: Json): void {
    if (codexItemType(item.type) !== "collab_agent_tool_call") return;
    const states = (item.agentsStates ?? {}) as Record<string, Json>;
    const ids = new Set([...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String) : []), ...Object.keys(states)]);
    for (const id of ids) {
      if (id === s.providerThreadId) continue;
      const status = states[id]?.status;
      const terminal = status === "completed" || status === "errored" || status === "shutdown" || status === "notFound";
      // Snapshots cannot end a directly observed live child turn.
      if (terminal && s.childTurns.has(id)) continue;
      // A spawn snapshot may arrive after the child's own terminal notification.
      if (terminal || item.tool !== "spawnAgent" || !s.children.has(id)) this.childState(s, id, !terminal);
    }
  }

  private item(s: Session, type: "item.started" | "item.completed", item: Json, at: { turnId?: TurnId }): void {
    const threadId = s.info.threadId;
    this.rememberChildren(s, item);
    const itemType = codexItemType(item.type);
    const itemId = typeof item.id === "string" ? item.id : undefined;
    const extra = { ...at, ...(itemId ? { itemId } : {}) };
    if (itemType === "user_message") return;
    // An async question (t3code): the message asks, the turn ends, and the
    // person's next message is the answer.
    if (type === "item.completed" && itemType === "assistant_message" && item.delivery === "async" && Array.isArray(item.questions) && item.questions.length) {
      this.emit(threadId, "item.completed", { itemType, status: "completed", ...describeItem(itemType, item) }, extra);
      const requestId = `codex-async:${threadId}:${itemId ?? randomUUID()}`;
      (s.asyncQuestions ??= new Set()).add(requestId);
      this.emit(threadId, "user-input.requested", { responseMode: "message", questions: (item.questions as Json[]).map((q, index) => ({
        id: String(index), header: "Question", question: String(q.title ?? ""), allowCustomAnswer: true, multiSelect: false,
        options: (Array.isArray(q.options) ? q.options : []).map(label => ({ label: String(label), description: "" })) })) },
      { ...at, requestId });
      return;
    }
    if (itemType === "plan") {
      if (type === "item.completed" && typeof item.text === "string" && item.text.trim())
        this.emit(threadId, "turn.proposed.completed", { planMarkdown: item.text }, at);
      return;
    }
    if (itemType === "context_compaction" && type === "item.completed") {
      s.compacting = false;
      this.emit(threadId, "item.completed", { itemType, status: "completed" }, extra);
      // Codex reports the size after compaction on its next token update.
      this.emit(threadId, "thread.state.changed", { state: "compacted", trigger: "auto", ...(s.contextUsed ? { beforeTokens: s.contextUsed } : {}) }, at);
      return;
    }
    if (itemType === "context_compaction") s.compacting = true;
    const status = ITEM_STATUSES.has(item.status as RuntimeItemStatus) ? item.status as RuntimeItemStatus
      : type === "item.completed" ? "completed" : "inProgress";
    const payload: ItemLifecyclePayload = { itemType, status, ...describeItem(itemType, item) };
    this.emit(threadId, type, payload, extra);
  }

  private tokenUsage(s: Session, usage: Json, at: { turnId?: TurnId }): void {
    const total = usageOf(usage.total as Json), last = usageOf(usage.last as Json);
    const window = typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : undefined;
    // Turn usage: growth of the running total, seeded by the first response.
    s.baseline ??= { total, first: last };
    const b = s.baseline;
    s.turnUsage = { input: total.input - b.total.input + b.first.input, cached: total.cached - b.total.cached + b.first.cached,
      output: total.output - b.total.output + b.first.output, reasoning: total.reasoning - b.total.reasoning + b.first.reasoning };
    if (s.turnUsage.input < 0) s.turnUsage = last; // Codex reset its running total
    // t3code's normalizeCodexTokenUsage: `last` is the newest response; the context now holds its total.
    const used = Number((usage.last as Json | undefined)?.totalTokens ?? 0);
    if (used <= 0) return;
    s.contextUsed = used;
    const processed = Number((usage.total as Json | undefined)?.totalTokens ?? 0);
    this.emit(s.info.threadId, "thread.token-usage.updated", { usage: { usedTokens: used, ...(window ? { maxTokens: window } : {}),
      ...(processed > used ? { totalProcessedTokens: processed } : {}),
      inputTokens: last.input, cachedInputTokens: last.cached, outputTokens: last.output, reasoningOutputTokens: last.reasoning,
      compactsAutomatically: true } }, at);
  }

  private rateLimits(s: Session, snapshot: Json): void {
    const windows = (["primary", "secondary"] as const).flatMap(key => {
      const w = snapshot[key] as Json | null | undefined;
      if (!w || typeof w.usedPercent !== "number") return [];
      return [{ id: key, usedPercent: w.usedPercent, ...(typeof w.windowDurationMins === "number" ? { windowMinutes: w.windowDurationMins } : {}),
        ...(typeof w.resetsAt === "number" ? { resetsAt: w.resetsAt * 1000 } : {}) }];
    });
    if (windows.length || snapshot.rateLimitReachedType) this.emit(s.info.threadId, "account.rate-limits.updated", { windows,
      ...(typeof snapshot.rateLimitReachedType === "string" ? { reached: snapshot.rateLimitReachedType } : {}) });
  }

  /**
   * Server requests. Approvals become `request.opened` and wait for
   * respondToRequest (or the turn/session ending, which cancels them);
   * anything Loom can't answer yet is declined rather than left waiting.
   */
  private async serverRequest(s: Session, method: string, params: Json): Promise<Json> {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileRead/requestApproval":
      case "item/fileChange/requestApproval": {
        const decision = await this.ask(s, method, params);
        return { decision };
      }
      case "execCommandApproval":
      case "applyPatchApproval": {
        const decision = await this.ask(s, method, params);
        return { decision: decision === "accept" ? "approved" : decision === "acceptForSession" ? "approved_for_session"
          : { denied: { rejection: "Denied in Loom." } } };
      }
      case "item/permissions/requestApproval": {
        const decision = await this.ask(s, method, params);
        // Approving grants the requested profile; an empty grant withholds it.
        return { permissions: decision === "accept" || decision === "acceptForSession" ? params.permissions ?? {} : {},
          scope: decision === "acceptForSession" ? "session" : "turn" };
      }
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      case "item/tool/requestUserInput":
        return { answers: toCodexAnswers(await this.askUser(s, params)) };
      default:
        throw new Error(`Loom does not handle ${method}`);
    }
  }

  /** A structured question (`request_user_input`): waits for respondToUserInput. */
  private askUser(s: Session, params: Json): Promise<UserInputAnswers> {
    const questions = toUserInputQuestions(params.questions);
    if (s.stopping || !questions.length) return Promise.resolve({});
    const requestId = randomUUID();
    const turnId = typeof params.turnId === "string" ? params.turnId : s.info.activeTurnId;
    return new Promise(resolve => {
      s.inputs.set(requestId, { resolve, ...(turnId ? { turnId } : {}) });
      this.emit(s.info.threadId, "user-input.requested", { questions }, { requestId, ...(turnId ? { turnId } : {}),
        ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}) });
    });
  }

  private ask(s: Session, method: string, params: Json): Promise<ApprovalDecision> {
    if (s.stopping) return Promise.resolve("cancel");
    const requestType = REQUEST_TYPES[method] ?? "unknown";
    const requestId = randomUUID();
    const turnId = typeof params.turnId === "string" ? params.turnId : s.info.activeTurnId;
    return new Promise(resolve => {
      s.pending.set(requestId, { method, requestType, params, resolve, ...(turnId ? { turnId } : {}) });
      this.emit(s.info.threadId, "request.opened", { requestType, ...describeRequest(method, params),
        args: { ...requestArgs(method, params) }, options: APPROVAL_OPTIONS }, { requestId, ...(turnId ? { turnId } : {}),
        ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}) });
    });
  }
}

/** What a person may answer to a Codex approval. */
const APPROVAL_OPTIONS: Array<{ decision: ApprovalDecision; label: string }> = [
  { decision: "accept", label: "Allow" },
  { decision: "acceptForSession", label: "Allow for this session" },
  { decision: "decline", label: "Deny" },
];

/** t3code's toUserInputQuestions: a question needs an id, header, prompt and options. */
function toUserInputQuestions(raw: unknown): UserInputQuestion[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Json[]).flatMap(q => {
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const options = (Array.isArray(q.options) ? q.options as Json[] : [])
      .map(o => ({ label: text(o.label), description: text(o.description) })).filter(o => o.label);
    if (!text(q.id) || !text(q.question)) return [];
    return [{ id: text(q.id), header: text(q.header) || "Question", question: text(q.question), options,
      ...(q.isOther === true || !options.length ? { allowCustomAnswer: true } : {}), multiSelect: false }];
  });
}

/** Loom answers → Codex's `{ [questionId]: { answers: string[] } }` (t3code's toCodexUserInputAnswer). */
function toCodexAnswers(answers: UserInputAnswers): Json {
  const out: Json = {};
  for (const [id, value] of Object.entries(answers)) {
    if (typeof value === "string") out[id] = { answers: [value] };
    else if (Array.isArray(value)) out[id] = { answers: value.filter((v): v is string => typeof v === "string") };
    else if (value && typeof value === "object" && Array.isArray((value as { answers?: unknown }).answers)) out[id] = { answers: (value as { answers: unknown[] }).answers.map(String) };
  }
  return out;
}

const cursorPayload = (cursor: unknown): { resume?: unknown } => (cursor !== undefined ? { resume: cursor } : {});

/** Title, detail and normalized data for a Codex item. */
function describeItem(itemType: CanonicalItemType, item: Json): Omit<ItemLifecyclePayload, "itemType" | "status"> {
  switch (itemType) {
    case "assistant_message":
      return typeof item.text === "string" ? { detail: item.text } : {};
    case "reasoning": {
      const parts = [...((item.summary as unknown[]) ?? []), ...((item.content as unknown[]) ?? [])].map(String);
      const text = parts.join("\n").trim();
      return text ? { detail: text } : {};
    }
    case "command_execution": {
      const command = String(item.command ?? "");
      return { detail: command, data: { command, ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
        ...(typeof item.aggregatedOutput === "string" ? { output: item.aggregatedOutput } : {}) } };
    }
    case "file_change": {
      const changes = ((item.changes as Array<{ path?: string; kind?: { type?: string } }> | undefined) ?? [])
        .filter(c => c.path).map(c => ({ path: String(c.path), kind: c.kind?.type ?? "update" }));
      return { data: { changes } };
    }
    case "mcp_tool_call":
      return { detail: `mcp: ${String(item.tool ?? "")}`, data: { tool: String(item.tool ?? "mcp"),
        ...(item.arguments && typeof item.arguments === "object" ? { input: item.arguments as Record<string, unknown> } : {}) } };
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return { detail: String(item.tool ?? itemType), data: { tool: String(item.tool ?? itemType) } };
    case "web_search":
      return { detail: `search: ${String(item.query ?? "")}`.slice(0, 160), data: { tool: "web_search" } };
    case "image_view":
      return { data: { tool: "image_view" } };
    case "error":
      return typeof item.message === "string" ? { detail: item.message } : {};
    default:
      return {};
  }
}

function describeRequest(method: string, params: Json): { detail?: string } {
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const d = text(params.command) ?? text(params.reason);
      return d ? { detail: `shell: ${d}`.slice(0, 200) } : {};
    }
    case "execCommandApproval": {
      const command = Array.isArray(params.command) ? params.command.join(" ") : text(params.command);
      return command ? { detail: `shell: ${command}`.slice(0, 200) } : {};
    }
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      // The reason rides in the card's input; the summary says what is asked.
      return { detail: "apply file changes" };
    case "item/permissions/requestApproval":
      return { detail: text(params.reason) ?? "grant additional permissions" };
    default:
      return {};
  }
}

/** What the approval card shows as the tool's input. */
function requestArgs(method: string, params: Json): Record<string, unknown> {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { command: params.command ?? null, cwd: params.cwd ?? null, reason: params.reason ?? null };
    case "execCommandApproval":
      return { command: Array.isArray(params.command) ? params.command.join(" ") : params.command ?? null };
    case "item/fileChange/requestApproval":
      return { reason: params.reason ?? null, grantRoot: params.grantRoot ?? null };
    case "applyPatchApproval":
      return { reason: params.reason ?? null };
    default:
      return { ...params };
  }
}
