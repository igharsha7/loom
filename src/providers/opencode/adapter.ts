/**
 * OpenCode on the provider contract: one warm `opencode serve` per Loom agent,
 * one OpenCode session per chat.
 *
 *   POST /api/session                     → session id    (startSession)
 *   GET  /api/session/:id                 → still there?  (resume)
 *   POST /api/session/:id/model           → model, in place
 *   POST /api/session/:id/prompt {id}     → admitted      (sendTurn)
 *   GET  /api/session/active              → turn over when the session leaves it
 *   POST /api/session/:id/interrupt                       (interruptTurn)
 *   POST /api/session/:id/compact                         (compact)
 *   POST /api/session/:id/revert/{stage,commit}           (rollbackThread)
 *   POST /api/session/:id/{permission,question}/:rid/reply
 *   GET  /event                           → live events (SSE, every session)
 *
 * The turn id is the user message id, chosen here in OpenCode's own format and
 * sent with the prompt (as t3code does), so a turn is correlated before the
 * server answers and a rollback names the message to revert to.
 *
 * A turn is accepted when the prompt is admitted (the 200, or any event of the
 * turn that beats it), and it is over, with every tool it ran finished, when
 * `/api/session/active` no longer lists the session: OpenCode runs its tools
 * inside that session, so leaving the list is quiescence (writerSettlement
 * "adapter"). A session the server no longer has is `session_missing`, before
 * anything is sent.
 *
 * Shapes: opencode 1.18's `/doc` (checked on 1.18.34) and the event stream
 * upstream Loom recorded from 1.18.31. Event mapping and the message id format
 * follow t3code's provider/Layers/OpenCodeAdapter.ts (MIT, © T3 Tools Inc.).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { agentEnv, freePort } from "../../adapters/base.js";
import { EventHub, type ProviderAdapter } from "../adapter.js";
import type {
  AdapterCapabilities, ApprovalDecision, CanonicalItemType, CanonicalRequestType, InstanceId, ItemLifecyclePayload,
  ProviderRuntimeEvent, ProviderSession, RequestId, RollbackResult, RuntimeEventPayloads, RuntimeEventType, RuntimeMode,
  SendTurnInput, SessionStartInput, ThreadId, TurnId, TurnStartResult, UserInputAnswers, UserInputQuestion,
} from "../contracts.js";
import { ProviderError } from "../errors.js";
import { launched, spawnHarness, stopHarness, type HarnessProcess } from "../process.js";

type Json = Record<string, unknown>;

export interface OpenCodeAdapterOptions {
  /** The opencode binary, when it isn't `opencode` on PATH. */
  bin?: string;
  /** Use a server that is already running instead of starting one. */
  baseUrl?: string;
  /** Extra `opencode serve` args. */
  extraArgs?: string[];
  /** Default model, "providerID/modelID". Without one, a model the server can run. */
  model?: string;
  /** OpenCode agent for new sessions (e.g. "build"). */
  agent?: string;
  /** How often the end of a turn is checked (tests shorten it). */
  pollMs?: number;
  /** How long a turn may run before its outcome is reported unknown. */
  turnTimeoutMs?: number;
}

export const opencodeCapabilities: AdapterCapabilities = { sessionModelSwitch: "in-session", supportsConversationRollback: true,
  manualCompaction: true, planMode: "unsupported", compaction: { type: "request" }, writerSettlement: "adapter", fencing: "opaque" };

/** "providerID/modelID" → OpenCode's ModelRef. */
export function parseModelRef(model: string): { providerID: string; id: string } | null {
  const idx = model.indexOf("/");
  if (idx <= 0 || idx === model.length - 1) return null;
  return { providerID: model.slice(0, idx), id: model.slice(idx + 1) };
}

/**
 * The model when none is pinned: OpenCode's free house model if the server
 * offers it, else any free OpenCode-hosted model. Its own default is often one
 * its Console won't serve headless ("Model is unavailable", seen on 1.18.31).
 */
export function pickDefaultModel(ids: string[]): string | undefined {
  if (ids.includes("opencode/big-pickle")) return "opencode/big-pickle";
  return ids.find(id => id.startsWith("opencode/") && id.endsWith("-free"));
}

/**
 * Permissions for a server Loom starts, through OpenCode's inline config
 * variable; the user's opencode.json is never touched. Only full access
 * changes anything (see core/permissions.ts for why "ask" is refused).
 */
export function opencodePermissionEnv(mode: RuntimeMode): Record<string, string> {
  if (mode !== "full-access") return {};
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow" } }) };
}

let idCounter = 0;
/** OpenCode's ascending id (t3code's message id): 48-bit time+counter in hex, 14 base62 characters. */
export function opencodeId(prefix: "msg" | "ses"): string {
  idCounter = (idCounter + 1) % 0x1000;
  const time = BigInt.asUintN(48, BigInt(Date.now()) * 0x1000n + BigInt(idCounter)).toString(16).padStart(12, "0");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `${prefix}_${time}${Array.from(randomBytes(14), b => alphabet[b % alphabet.length]).join("")}`;
}

/** OpenCode tool name → canonical item type. */
export function opencodeItemType(tool: string): CanonicalItemType {
  const t = tool.toLowerCase();
  if (t === "bash" || t === "shell") return "command_execution";
  if (t === "edit" || t === "write" || t === "multiedit" || t === "patch" || t === "apply_patch") return "file_change";
  if (t === "task") return "collab_agent_tool_call";
  if (t === "websearch" || t === "codesearch") return "web_search";
  if (t.includes("_") && !["todowrite", "todoread"].includes(t)) return "mcp_tool_call";
  return "dynamic_tool_call";
}

const REQUEST_TYPES: Record<string, CanonicalRequestType> = {
  bash: "command_execution_approval", edit: "file_change_approval", write: "file_change_approval",
  read: "file_read_approval", external_directory: "permission_approval",
};
const APPROVAL_OPTIONS: Array<{ decision: ApprovalDecision; label: string }> = [
  { decision: "accept", label: "Allow" },
  { decision: "acceptForSession", label: "Always allow" },
  { decision: "decline", label: "Deny" },
];
/** t3code's toOpenCodePermissionReply. */
const permissionReply = (decision: ApprovalDecision) => decision === "accept" ? "once" : decision === "acceptForSession" ? "always" : "reject";

const text = (v: unknown) => (typeof v === "string" ? v : "");
const messageInfo = (m: Json) => ((m.info ?? m) as Json);
const role = (m: Json) => String(messageInfo(m).type ?? messageInfo(m).role ?? "");

interface Usage { input: number; output: number; cached: number; reasoning: number; cost: number }
const tokensOf = (t: unknown): Omit<Usage, "cost"> | null => {
  if (!t || typeof t !== "object") return null;
  const tk = t as Record<string, unknown>, cache = (tk.cache ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { input: n(tk.input) + n(cache.read) + n(cache.write), output: n(tk.output) + n(tk.reasoning), cached: n(cache.read), reasoning: n(tk.reasoning) };
};

interface PendingRequest { requestType: CanonicalRequestType; turnId?: TurnId }
interface PendingQuestion { turnId?: TurnId; questions: UserInputQuestion[] }

interface Turn {
  id: TurnId;
  model?: string;
  /** Message ids in the session before the prompt. */
  baseline: Set<string>;
  accepted: boolean;
  interrupted: boolean;
  /** Assistant messages whose text was already reported. */
  reported: Set<string>;
  /** Streamed text per assistant message, for the completed item. */
  textByMessage: Map<string, string>;
  reasoningByMessage: Map<string, string>;
  /** Tools started, by call id. */
  tools: Map<string, { itemType: CanonicalItemType; tool: string; input: Json }>;
  files: Set<string>;
  usage: Usage | null;
  error?: string;
  /** Resolves the poll loop early (an idle event, a stop). */
  wake?: () => void;
}

interface Session {
  info: ProviderSession;
  nativeId: string;
  turn: Turn | null;
  /** Which turn each reply belongs to, so a late event never lands on the next turn. */
  owners: Map<string, Turn>;
  pending: Map<RequestId, PendingRequest>;
  questions: Map<RequestId, PendingQuestion>;
  compacting: boolean;
  contextUsed?: number;
  stopping: boolean;
  failure?: string;
}

export class OpenCodeProviderAdapter implements ProviderAdapter {
  readonly provider = "opencode" as const;
  readonly capabilities = opencodeCapabilities;
  private readonly sessions = new Map<ThreadId, Session>();
  private readonly byNative = new Map<string, Session>();
  private readonly hub = new EventHub<ProviderRuntimeEvent>();
  private server: { url: string; proc?: HarnessProcess; sse: AbortController; models: Map<string, number>; defaultModel?: string; mode: RuntimeMode; closing?: boolean } | null = null;
  private starting: Promise<NonNullable<OpenCodeProviderAdapter["server"]>> | null = null;

  constructor(readonly instanceId: InstanceId, private readonly options: OpenCodeAdapterOptions = {}) {}

  onEvent(listener: (event: ProviderRuntimeEvent) => void): () => void { return this.hub.subscribe(listener); }
  listSessions(): ProviderSession[] { return [...this.sessions.values()].map(s => ({ ...s.info })); }
  hasSession(threadId: ThreadId): boolean { return this.sessions.has(threadId); }

  private emit<K extends RuntimeEventType>(threadId: ThreadId, type: K, payload: RuntimeEventPayloads[K],
    extra: { turnId?: TurnId; itemId?: string; requestId?: RequestId } = {}): void {
    this.hub.publish({ eventId: randomUUID(), provider: this.provider, instanceId: this.instanceId, threadId, createdAt: Date.now(),
      ...(extra.turnId ? { turnId: extra.turnId } : {}), ...(extra.itemId ? { itemId: extra.itemId } : {}),
      ...(extra.requestId ? { requestId: extra.requestId } : {}), type, payload } as ProviderRuntimeEvent);
  }

  private error(code: ConstructorParameters<typeof ProviderError>[0], operation: string, message: string, threadId?: ThreadId,
    extra: { mayHaveStarted?: boolean; cause?: unknown } = {}): ProviderError {
    const stderr = this.server?.proc?.stderr().trim();
    return new ProviderError(code, operation, message, { provider: this.provider, instanceId: this.instanceId,
      ...(threadId ? { threadId } : {}), mayHaveStarted: extra.mayHaveStarted ?? false, ...(extra.cause ? { cause: extra.cause } : {}),
      ...(stderr ? { stderr } : {}) });
  }

  // ---- the server ----------------------------------------------------------

  private async request(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; body: Json }> {
    const server = this.server;
    if (!server) throw new Error("opencode server is not running");
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : init.method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });
    const raw = await res.text().catch(() => "");
    let body: Json = {};
    try { body = raw ? JSON.parse(raw) as Json : {}; } catch { body = { message: raw.slice(0, 300) }; }
    return { status: res.status, body };
  }

  private async call(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<Json> {
    const { status, body } = await this.request(path, init);
    if (status < 200 || status >= 300) throw new Error(`opencode answered ${status} for ${path}: ${String(body.message ?? JSON.stringify(body)).slice(0, 300)}`);
    return (body.data ?? body) as Json;
  }

  /** The server: the configured one, or one started here (shared by every chat of this agent). */
  private ensureServer(cwd: string, mode: RuntimeMode, threadId: ThreadId): Promise<NonNullable<OpenCodeProviderAdapter["server"]>> {
    if (this.server) return Promise.resolve(this.server);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const base = this.options.baseUrl?.replace(/\/$/, "");
      let proc: HarnessProcess | undefined;
      let url = base;
      if (!url) {
        const port = await freePort();
        url = `http://127.0.0.1:${port}`;
        proc = spawnHarness(this.options.bin ?? "opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1", ...(this.options.extraArgs ?? [])],
          { cwd, env: { ...agentEnv(), ...opencodePermissionEnv(mode) } });
        try { await launched(proc.child); }
        catch (error) { throw this.error("transport", "startSession", `opencode could not start: ${(error as Error).message} — install it (curl -fsSL https://opencode.ai/install | bash)`, threadId, { cause: error }); }
      }
      const server: NonNullable<OpenCodeProviderAdapter["server"]> = { url, ...(proc ? { proc } : {}), sse: new AbortController(), models: new Map<string, number>(), mode };
      this.server = server;
      try {
        const deadline = Date.now() + 30_000;
        for (;;) {
          if (proc && proc.child.exitCode !== null) throw new Error(`opencode serve exited with code ${proc.child.exitCode}`);
          const ok = await this.request("/api/health", { timeoutMs: 2000 }).then(r => r.status === 200, () => false);
          if (ok) break;
          if (Date.now() > deadline) throw new Error(`opencode server at ${url} did not answer /api/health`);
          await new Promise(r => setTimeout(r, 200));
        }
        const listed = await this.call("/api/model").catch(() => ({}));
        for (const m of Array.isArray(listed) ? listed as Json[] : []) {
          if (typeof m.providerID === "string" && typeof m.id === "string")
            server.models.set(`${m.providerID}/${m.id}`, Number((m.limit as Json | undefined)?.context ?? 0));
        }
        const pinned = this.options.model;
        if (pinned && server.models.size && !server.models.has(pinned)) {
          const ids = [...server.models.keys()];
          const stem = pinned.split("/").pop()!.split("-")[0]!.toLowerCase();
          const near = ids.filter(id => id.toLowerCase().includes(stem)).slice(0, 5);
          throw new Error(`opencode cannot run model "${pinned}". Close matches: ${near.join(", ") || "none"}. ` +
            `Free options: ${ids.filter(id => id.endsWith("-free")).slice(0, 3).join(", ") || "none"}.`);
        }
        server.defaultModel = pinned ?? pickDefaultModel([...server.models.keys()]);
      } catch (error) {
        this.server = null;
        if (proc) await stopHarness(proc, 0).catch(() => {});
        throw error instanceof ProviderError ? error : this.error("transport", "startSession", (error as Error).message, threadId, { cause: error });
      }
      this.listen(server);
      if (proc) void proc.closed.then(({ code }) => { if (this.server === server && !server.closing) this.serverGone(`opencode serve exited${code === null ? "" : ` with code ${code}`}`); });
      return server;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** Every session of a server that went away ends with it. */
  private serverGone(reason: string): void {
    const server = this.server;
    this.server = null;
    server?.sse.abort();
    for (const s of [...this.sessions.values()]) {
      s.stopping = true;
      this.settlePending(s, "cancel");
      this.forget(s);
      if (s.turn) {
        this.emit(s.info.threadId, "turn.aborted", { reason: `${reason} before the turn completed; native outcome is unknown` }, { turnId: s.turn.id });
        s.turn.wake?.();
        s.turn = null;
      }
      s.info = { ...s.info, status: "error", updatedAt: Date.now() };
      delete s.info.activeTurnId;
      this.emit(s.info.threadId, "session.exited", { reason, exitKind: "error", recoverable: true });
    }
  }

  private forget(s: Session): void {
    if (this.sessions.get(s.info.threadId) === s) this.sessions.delete(s.info.threadId);
    if (this.byNative.get(s.nativeId) === s) this.byNative.delete(s.nativeId);
  }

  /** The live event stream; reconnects until the server is closed. */
  private listen(server: NonNullable<OpenCodeProviderAdapter["server"]>): void {
    void (async () => {
      while (!server.sse.signal.aborted) {
        try {
          const res = await fetch(`${server.url}/event`, { signal: server.sse.signal, headers: { accept: "text/event-stream" } });
          if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
          let buffer = "";
          for await (const chunk of res.body) {
            buffer += Buffer.from(chunk as Uint8Array).toString("utf8");
            let idx: number;
            while ((idx = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (!line.startsWith("data:")) continue;
              let event: Json;
              try { event = JSON.parse(line.slice(5).trim()) as Json; } catch { continue; }
              try { this.event(event); } catch { /* one bad event never ends the stream */ }
            }
          }
        } catch {
          if (server.sse.signal.aborted) return;
        }
        await new Promise(r => setTimeout(r, 500));
      }
    })();
  }

  // ---- sessions ------------------------------------------------------------

  async startSession(input: SessionStartInput): Promise<ProviderSession> {
    if (this.sessions.has(input.threadId)) await this.stopSession(input.threadId);
    this.emit(input.threadId, "session.state.changed", { state: "starting" });
    const server = await this.ensureServer(input.cwd, input.runtimeMode, input.threadId);
    const cursor = typeof input.resumeCursor === "string" && input.resumeCursor ? input.resumeCursor : undefined;
    const wanted = input.modelSelection?.model ?? server.defaultModel;
    let nativeId: string, model: string | undefined;
    try {
      if (cursor) {
        const { status, body } = await this.request(`/api/session/${encodeURIComponent(cursor)}`);
        if (status === 404) throw this.error("session_missing", "startSession", `opencode no longer has session ${cursor}`, input.threadId);
        if (status !== 200) throw this.error("transport", "startSession", `opencode answered ${status} for session ${cursor}`, input.threadId);
        const ref = ((body.data ?? body) as Json).model as Json | undefined;
        nativeId = cursor;
        model = ref && typeof ref.providerID === "string" && typeof ref.id === "string" ? `${ref.providerID}/${ref.id}` : wanted;
      } else {
        const ref = wanted ? parseModelRef(wanted) : null;
        const created = await this.call("/api/session", { body: { ...(ref ? { model: ref } : {}),
          ...(this.options.agent ? { agent: this.options.agent } : {}), location: { directory: input.cwd } } });
        nativeId = String(created.id ?? "");
        if (!nativeId) throw this.error("request", "startSession", "opencode returned no session id", input.threadId);
        model = wanted;
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw this.error("transport", "startSession", `opencode could not open a session: ${(error as Error).message}`, input.threadId, { cause: error });
    }
    const now = Date.now();
    const s: Session = {
      info: { provider: this.provider, instanceId: this.instanceId, threadId: input.threadId, status: "ready", runtimeMode: input.runtimeMode,
        cwd: input.cwd, resumeCursor: nativeId, createdAt: now, updatedAt: now, ...(model ? { model } : {}),
        writerIdentity: { type: "opencode-session", value: { baseUrl: server.url, sessionId: nativeId,
          ...(server.proc?.child.pid ? { processGroupId: server.proc.child.pid } : {}) } },
        ...(server.proc?.child.pid ? { processGroupId: server.proc.child.pid } : {}) },
      nativeId, turn: null, owners: new Map(), pending: new Map(), questions: new Map(), compacting: false, stopping: false,
    };
    this.sessions.set(input.threadId, s);
    this.byNative.set(nativeId, s);
    this.emit(input.threadId, "session.started", cursor ? { resume: cursor } : {});
    this.emit(input.threadId, "thread.started", { providerThreadId: nativeId });
    this.emit(input.threadId, "session.state.changed", { state: "ready" });
    return { ...s.info };
  }

  private session(threadId: ThreadId, operation: string): Session {
    const s = this.sessions.get(threadId);
    if (!s || s.stopping) throw this.error("not_found", operation, `no live opencode session for chat "${threadId}"`, threadId);
    if (s.failure) throw this.error("validation", operation, s.failure, threadId);
    return s;
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const s = this.session(input.threadId, "sendTurn");
    if (s.turn) throw this.error("validation", "sendTurn", "an opencode turn is already running in this chat", input.threadId);
    const requested = input.modelSelection?.model === null ? this.server?.defaultModel : input.modelSelection?.model ?? s.info.model;
    if (requested && requested !== s.info.model) {
      const ref = parseModelRef(requested);
      if (!ref) throw this.error("validation", "sendTurn", `"${requested}" is not an opencode model (expected providerID/modelID)`, input.threadId);
      try { await this.call(`/api/session/${encodeURIComponent(s.nativeId)}/model`, { body: { model: ref } }); }
      catch (error) { throw this.error("request", "sendTurn", `opencode couldn't switch the session to ${requested}: ${(error as Error).message}`, input.threadId, { cause: error }); }
      s.info = { ...s.info, model: requested };
    }
    const baseline = new Set((await this.messages(s).catch(() => [] as Json[])).map(m => String(messageInfo(m).id)));
    const turnId = opencodeId("msg");
    const turn: Turn = { id: turnId, ...(s.info.model ? { model: s.info.model } : {}), baseline, accepted: false, interrupted: false,
      reported: new Set(), textByMessage: new Map(), reasoningByMessage: new Map(), tools: new Map(), files: new Set(), usage: null };
    s.turn = turn;
    s.info = { ...s.info, status: "running", activeTurnId: turnId, updatedAt: Date.now() };
    let admitted: { status: number; body: Json };
    try {
      admitted = await this.request(`/api/session/${encodeURIComponent(s.nativeId)}/prompt`, { body: { id: turnId, prompt: { text: input.input } }, timeoutMs: 30_000 });
    } catch (error) {
      // The request may have reached the server: unknown, never a refusal.
      void this.watch(s, turn);
      throw this.error("transport", "sendTurn", `opencode prompt request failed: ${(error as Error).message}; native outcome is unknown`, input.threadId, { mayHaveStarted: true, cause: error });
    }
    if (admitted.status < 200 || admitted.status >= 300) {
      if (!turn.accepted) {
        s.turn = null;
        s.info = { ...s.info, status: "ready", updatedAt: Date.now() };
        delete s.info.activeTurnId;
        throw this.error("request", "sendTurn", `opencode refused the prompt (${admitted.status}): ${String(admitted.body.message ?? "").slice(0, 300)}`, input.threadId);
      }
    }
    this.accept(s, turn);
    void this.watch(s, turn);
    return { threadId: input.threadId, turnId, resumeCursor: s.nativeId };
  }

  /** Native evidence the turn exists: the admission, or any of its events arriving first. */
  private accept(s: Session, turn: Turn): void {
    if (turn.accepted) return;
    turn.accepted = true;
    this.emit(s.info.threadId, "turn.started", turn.model ? { model: turn.model } : {}, { turnId: turn.id });
  }

  private async messages(s: Session): Promise<Json[]> {
    const data = await this.call(`/api/session/${encodeURIComponent(s.nativeId)}/message`);
    const list = Array.isArray(data) ? data as Json[] : [];
    return list.sort((a, b) => Number((messageInfo(a).time as Json | undefined)?.created ?? 0) - Number((messageInfo(b).time as Json | undefined)?.created ?? 0));
  }

  private async active(): Promise<Json | null> {
    try { return await this.call("/api/session/active", { timeoutMs: 5000 }); }
    catch { return null; }
  }

  /**
   * Wait for the turn to end: OpenCode no longer lists the session as active.
   * Until it has been seen running, an idle session counts only once a new
   * completed assistant message exists (the prompt may not have started).
   */
  private async watch(s: Session, turn: Turn): Promise<void> {
    const pollMs = this.options.pollMs ?? 500;
    const deadline = Date.now() + (this.options.turnTimeoutMs ?? 60 * 60_000);
    let sawRunning = false;
    while (s.turn === turn && !s.stopping) {
      if (Date.now() > deadline) {
        this.finishTurn(s, turn, { type: "turn.aborted", reason: "opencode was still working when the turn timed out; quiescence unknown" });
        return;
      }
      const active = await this.active();
      if (s.turn !== turn || s.stopping) return;
      if (active && Object.prototype.hasOwnProperty.call(active, s.nativeId)) { sawRunning = true; this.accept(s, turn); }
      else if (active) {
        const messages = await this.messages(s).catch(() => null);
        if (s.turn !== turn || s.stopping) return;
        const done = messages?.some(m => role(m) === "assistant" && !turn.baseline.has(String(messageInfo(m).id)) && (messageInfo(m).time as Json | undefined)?.completed);
        if (messages && (sawRunning || turn.interrupted || done)) { await this.complete(s, turn, messages); return; }
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, pollMs);
        turn.wake = () => { clearTimeout(timer); resolve(); };
      });
      turn.wake = undefined;
    }
  }

  /** The turn ended: report what the stream missed, then the outcome. */
  private async complete(s: Session, turn: Turn, messages: Json[]): Promise<void> {
    const replies = messages.filter(m => role(m) === "assistant" && !turn.baseline.has(String(messageInfo(m).id)));
    for (const m of replies) {
      const info = messageInfo(m), id = String(info.id);
      const parts = Array.isArray(info.content) ? info.content as Json[] : Array.isArray(m.parts) ? m.parts as Json[] : undefined;
      this.completeMessage(s, turn, id, parts?.filter(p => p.type === "text").map(p => text(p.text)).join(""));
      if (!turn.usage) {
        const tk = tokensOf(info.tokens);
        if (tk) turn.usage = { ...tk, cost: Number(info.cost ?? 0) || 0 };
      } else if (turn.usage.cost === 0 && typeof info.cost === "number") turn.usage.cost = info.cost;
      const ref = (info.model ?? {}) as Json;
      if (typeof info.modelID === "string") turn.model = typeof info.providerID === "string" ? `${info.providerID}/${info.modelID}` : info.modelID;
      else if (typeof ref.id === "string") turn.model = typeof ref.providerID === "string" ? `${ref.providerID}/${ref.id}` : ref.id;
    }
    const last = replies.at(-1) ? messageInfo(replies.at(-1)!) : undefined;
    const failure = last && (last.finish === "error" || last.error) ? text((last.error as Json | undefined)?.message) || "opencode turn failed" : turn.error;
    if (turn.interrupted) { this.finishTurn(s, turn, { type: "turn.completed", state: "interrupted" }); return; }
    if (!replies.length && !failure) { this.finishTurn(s, turn, { type: "turn.completed", state: "failed", error: "opencode finished without a reply" }); return; }
    this.finishTurn(s, turn, failure ? { type: "turn.completed", state: "failed", error: failure.slice(0, 500) } : { type: "turn.completed", state: "completed" });
  }

  private finishTurn(s: Session, turn: Turn, end: { type: "turn.completed"; state: "completed" | "failed" | "interrupted"; error?: string } | { type: "turn.aborted"; reason: string }): void {
    if (s.turn !== turn) return;
    this.accept(s, turn);
    // Tools still open when the session went idle ended with it.
    for (const [callId, tool] of turn.tools) this.emit(s.info.threadId, "item.completed", { itemType: tool.itemType, status: "failed",
      ...describeTool(tool.itemType, tool.tool, tool.input) }, { turnId: turn.id, itemId: callId });
    turn.tools.clear();
    s.turn = null;
    this.settlePending(s, "cancel");
    delete s.info.activeTurnId;
    s.info = { ...s.info, status: "ready", updatedAt: Date.now(), ...(turn.model ? { model: turn.model } : {}) };
    if (end.type === "turn.aborted") {
      s.failure = end.reason;
      this.emit(s.info.threadId, "turn.aborted", { reason: end.reason }, { turnId: turn.id });
      return;
    }
    const u = turn.usage;
    this.emit(s.info.threadId, "turn.completed", { state: end.state, ...(end.error ? { errorMessage: end.error } : {}),
      ...(turn.model ? { model: turn.model } : {}), ...(u && u.cost > 0 ? { totalCostUsd: u.cost } : {}),
      ...(u ? { tokenUsage: { usageStatus: "complete" as const, inputTokens: u.input, outputTokens: u.output, cachedInputTokens: u.cached, reasoningTokens: u.reasoning } } : {}) },
    { turnId: turn.id });
  }

  /** One assistant message's text and reasoning, reported once. */
  private completeMessage(s: Session, turn: Turn, messageId: string, fallback?: string): void {
    if (turn.reported.has(messageId)) return;
    const streamed = turn.textByMessage.get(messageId);
    const reasoning = turn.reasoningByMessage.get(messageId);
    if (reasoning?.trim()) this.emit(s.info.threadId, "item.completed", { itemType: "reasoning", status: "completed", detail: reasoning }, { turnId: turn.id, itemId: `${messageId}:reasoning` });
    const body = streamed ?? fallback;
    if (body === undefined) return;
    turn.reported.add(messageId);
    if (body.trim()) this.emit(s.info.threadId, "item.completed", { itemType: "assistant_message", status: "completed", detail: body }, { turnId: turn.id, itemId: `${messageId}:text` });
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const s = this.sessions.get(threadId);
    if (!s?.turn || (turnId && s.turn.id !== turnId)) return;
    s.turn.interrupted = true;
    this.settlePending(s, "cancel");
    await this.call(`/api/session/${encodeURIComponent(s.nativeId)}/interrupt`, { method: "POST", timeoutMs: 5000 });
    s.turn?.wake?.();
  }

  async respondToRequest(threadId: ThreadId, requestId: RequestId, decision: ApprovalDecision): Promise<void> {
    const s = this.session(threadId, "respondToRequest");
    const pending = s.pending.get(requestId);
    if (!pending) throw this.error("not_found", "respondToRequest", `no open opencode request "${requestId}"`, threadId);
    await this.call(`/api/session/${encodeURIComponent(s.nativeId)}/permission/${encodeURIComponent(requestId)}/reply`, { body: { reply: permissionReply(decision) } });
    s.pending.delete(requestId);
    this.emit(threadId, "request.resolved", { requestType: pending.requestType, decision }, { requestId, ...(pending.turnId ? { turnId: pending.turnId } : {}) });
  }

  async respondToUserInput(threadId: ThreadId, requestId: RequestId, answers: UserInputAnswers): Promise<void> {
    const s = this.session(threadId, "respondToUserInput");
    const pending = s.questions.get(requestId);
    if (!pending) throw this.error("not_found", "respondToUserInput", `no open opencode question "${requestId}"`, threadId);
    await this.call(`/api/session/${encodeURIComponent(s.nativeId)}/question/${encodeURIComponent(requestId)}/reply`, { body: { answers: toOpenCodeAnswers(pending.questions, answers) } });
    s.questions.delete(requestId);
    this.emit(threadId, "user-input.resolved", { answers }, { requestId, ...(pending.turnId ? { turnId: pending.turnId } : {}) });
  }

  async compact(threadId: ThreadId): Promise<void> {
    const s = this.session(threadId, "compact");
    await this.call(`/api/session/${encodeURIComponent(s.nativeId)}/compact`, { method: "POST" });
  }

  /** User messages in order: the turns this session holds, by id. */
  private async userTurns(s: Session): Promise<string[]> {
    return (await this.messages(s)).filter(m => role(m) === "user").map(m => String(messageInfo(m).id));
  }

  async validateRollback(threadId: ThreadId, beforeTurnId: TurnId): Promise<string[]> {
    const s = this.session(threadId, "rollbackThread");
    const turns = await this.userTurns(s);
    const cut = turns.indexOf(beforeTurnId);
    if (cut < 0) throw this.error("request", "rollbackThread", "the turn isn't in opencode's session, so the conversation can't be put back to before it", threadId);
    return turns.slice(0, cut);
  }

  /** Revert the session to before `beforeTurnId` (its user message), conversation only: Loom's checkpoints own the files. */
  async rollbackThread(threadId: ThreadId, beforeTurnId: TurnId, retainedTurnIds?: string[]): Promise<RollbackResult> {
    const s = this.session(threadId, "rollbackThread");
    if (s.turn) throw this.error("validation", "rollbackThread", "an opencode turn is running in this chat", threadId);
    const turns = await this.userTurns(s);
    if (!turns.includes(beforeTurnId)) {
      if (retainedTurnIds && JSON.stringify(turns) === JSON.stringify(retainedTurnIds)) return { resumeCursor: s.nativeId, live: true };
      throw this.error("request", "rollbackThread", `opencode's session has no turn ${beforeTurnId} and does not match the retained prefix`, threadId);
    }
    const base = `/api/session/${encodeURIComponent(s.nativeId)}/revert`;
    try {
      await this.call(`${base}/stage`, { body: { messageID: beforeTurnId, files: false } });
      await this.call(`${base}/commit`, { method: "POST" });
    } catch (error) {
      throw this.error("request", "rollbackThread", `opencode could not roll back its session: ${(error as Error).message}`, threadId, { cause: error });
    }
    return { resumeCursor: s.nativeId, live: true };
  }

  /**
   * Fence this chat's writers: interrupt its turn and wait until OpenCode no
   * longer lists the session as active. When that can't be proven, a server
   * Loom started is stopped (ending every chat on it); a server Loom doesn't
   * own leaves the session marked unknown.
   */
  async stopSession(threadId: ThreadId): Promise<void> {
    const s = this.sessions.get(threadId);
    if (!s) return;
    s.stopping = true;
    this.settlePending(s, "cancel");
    const server = this.server;
    let quiet = !server;
    if (server) {
      await this.request(`/api/session/${encodeURIComponent(s.nativeId)}/interrupt`, { method: "POST", timeoutMs: 5000 }).catch(() => null);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const active = await this.active();
        if (active && !Object.prototype.hasOwnProperty.call(active, s.nativeId)) { quiet = true; break; }
        await new Promise(r => setTimeout(r, 200));
      }
      if (!quiet && server.proc) { await this.stopServer(); return; }
    }
    if (!quiet) {
      s.stopping = false;
      s.failure = "opencode still lists the session as active after an interrupt; quiescence unknown";
      s.info = { ...s.info, status: "error", updatedAt: Date.now() };
      if (s.turn) { this.emit(threadId, "turn.aborted", { reason: s.failure }, { turnId: s.turn.id }); s.turn.wake?.(); s.turn = null; delete s.info.activeTurnId; }
      this.emit(threadId, "runtime.error", { message: s.failure, class: "transport_error" });
      throw this.error("transport", "stopSession", s.failure, threadId);
    }
    // A server Loom started serves only this agent's chats; with none left it
    // goes too, and its process group with it. Until that is done the session
    // stays, so a failed fence can be retried with Stop.
    if ([...this.sessions.values()].every(other => other === s) && this.server?.proc) {
      try { await this.stopServer(true); }
      catch (error) { s.stopping = false; throw error; }
    }
    this.forget(s);
    if (s.turn) {
      this.emit(threadId, "turn.completed", { state: "interrupted", stopReason: "session stopped" }, { turnId: s.turn.id });
      s.turn.wake?.();
      s.turn = null;
    }
    s.info = { ...s.info, status: "closed", updatedAt: Date.now() };
    delete s.info.activeTurnId;
    this.emit(threadId, "session.exited", { reason: "session stopped", exitKind: "graceful" });
  }

  /** End the server Loom started. `quiet`: its sessions are being stopped one by one, not lost. */
  private async stopServer(quiet = false): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closing = true;
    try { if (server.proc) await stopHarness(server.proc); }
    catch (error) { server.closing = false; throw error; }
    server.sse.abort();
    if (this.server === server) {
      if (quiet) this.server = null;
      else this.serverGone("opencode server stopped");
    }
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.stopSession(id)));
    if (this.server && !this.sessions.size) {
      if (this.server.proc) await this.stopServer();
      else { this.server.sse.abort(); this.server = null; }
    }
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }

  private settlePending(s: Session, decision: ApprovalDecision): void {
    for (const [requestId, q] of s.questions) {
      s.questions.delete(requestId);
      if (this.server) void this.request(`/api/session/${encodeURIComponent(s.nativeId)}/question/${encodeURIComponent(requestId)}/reject`, { method: "POST", timeoutMs: 5000 }).catch(() => {});
      this.emit(s.info.threadId, "user-input.resolved", { answers: {} }, { requestId, ...(q.turnId ? { turnId: q.turnId } : {}) });
    }
    for (const [requestId, pending] of s.pending) {
      s.pending.delete(requestId);
      if (this.server) void this.request(`/api/session/${encodeURIComponent(s.nativeId)}/permission/${encodeURIComponent(requestId)}/reply`, { body: { reply: "reject" }, timeoutMs: 5000 }).catch(() => {});
      this.emit(s.info.threadId, "request.resolved", { requestType: pending.requestType, decision }, { requestId, ...(pending.turnId ? { turnId: pending.turnId } : {}) });
    }
  }

  // ---- native → canonical --------------------------------------------------

  private event(evt: Json): void {
    const type = String(evt.type ?? "");
    // Payload wrapping varies across builds: {properties} or {data}.
    const p = (evt.properties ?? evt.data ?? evt) as Json;
    const part = p.part as Json | undefined;
    const nativeId = text(p.sessionID) || text(part?.sessionID) || text((p.info as Json | undefined)?.sessionID);
    const s = nativeId ? this.byNative.get(nativeId) : undefined;
    if (!s || s.stopping) return;
    const threadId = s.info.threadId;
    const reply = text(p.assistantMessageID);
    const owner = reply ? s.owners.get(reply) : undefined;
    // A reply of a turn already settled: what it had open was reported at its end.
    if (owner && owner !== s.turn) return;
    const turn = s.turn;
    if (reply && turn && !owner) {
      s.owners.set(reply, turn);
      if (s.owners.size > 256) s.owners.delete(s.owners.keys().next().value!);
    }
    const at = turn ? { turnId: turn.id } : {};
    // Any event of the session after the prompt went out proves it was admitted.
    if (turn && (type.startsWith("session.next.") || type === "message.part.updated")) this.accept(s, turn);
    switch (type) {
      case "session.next.text.delta":
      case "session.next.reasoning.delta": {
        if (!turn || typeof p.delta !== "string" || !p.delta) return;
        const reasoning = type.includes("reasoning");
        const messageId = text(p.assistantMessageID) || "reply";
        const buffers = reasoning ? turn.reasoningByMessage : turn.textByMessage;
        buffers.set(messageId, (buffers.get(messageId) ?? "") + p.delta);
        this.emit(threadId, "content.delta", { streamKind: reasoning ? "reasoning_text" : "assistant_text", delta: p.delta },
          { ...at, itemId: `${messageId}:${reasoning ? "reasoning" : "text"}` });
        return;
      }
      case "session.next.text.ended":
        if (turn && typeof p.text === "string") {
          const messageId = text(p.assistantMessageID) || "reply";
          // The ended text is authoritative for its part; deltas already shown stay as they are.
          if (!turn.textByMessage.has(messageId)) turn.textByMessage.set(messageId, p.text);
        }
        return;
      case "session.next.step.ended": {
        if (!turn) return;
        const tk = tokensOf(p.tokens);
        if (tk) {
          const u = turn.usage ?? { input: 0, output: 0, cached: 0, reasoning: 0, cost: 0 };
          turn.usage = { input: u.input + tk.input, output: u.output + tk.output, cached: u.cached + tk.cached, reasoning: u.reasoning + tk.reasoning,
            cost: u.cost + (typeof p.cost === "number" ? p.cost : 0) };
          // The context now holds this step's input and what it wrote.
          const used = tk.input + tk.output;
          if (used > 0) {
            s.contextUsed = used;
            const max = turn.model ? this.server?.models.get(turn.model) : undefined;
            this.emit(threadId, "thread.token-usage.updated", { usage: { usedTokens: used, ...(max ? { maxTokens: max } : {}),
              inputTokens: tk.input, cachedInputTokens: tk.cached, outputTokens: tk.output, reasoningOutputTokens: tk.reasoning, compactsAutomatically: true } }, at);
          }
        }
        const paths = Array.isArray(p.files) ? (p.files as unknown[]).map(String).filter(f => f && !turn.files.has(f)) : [];
        if (paths.length) {
          for (const f of paths) turn.files.add(f);
          this.emit(threadId, "item.completed", { itemType: "file_change", status: "completed", data: { changes: paths.map(path => ({ path, kind: "update" })) } },
            { ...at, itemId: `${text(p.assistantMessageID) || "step"}:files:${randomUUID()}` });
        }
        if (p.finish === "error") turn.error ??= "opencode step failed";
        return;
      }
      case "session.next.step.failed":
        if (turn) turn.error = text((p.error as Json | undefined)?.message) || "opencode step failed";
        return;
      case "session.next.tool.called": {
        if (!turn) return;
        const callId = text(p.callID) || randomUUID();
        const tool = text(p.tool) || "tool";
        const input = (p.input && typeof p.input === "object" ? p.input : {}) as Json;
        const itemType = opencodeItemType(tool);
        turn.tools.set(callId, { itemType, tool, input });
        this.emit(threadId, "item.started", { itemType, status: "inProgress", ...describeTool(itemType, tool, input) }, { ...at, itemId: callId });
        return;
      }
      case "session.next.tool.success":
      case "session.next.tool.failed": {
        if (!turn) return;
        const callId = text(p.callID);
        const call = turn.tools.get(callId);
        if (!call) return;
        turn.tools.delete(callId);
        const failed = type.endsWith("failed");
        const output = Array.isArray(p.content) ? (p.content as Json[]).map(c => text(c.text)).join("") : undefined;
        const described = describeTool(call.itemType, call.tool, call.input, output);
        if (call.itemType === "file_change") for (const c of (described.data as { changes?: Array<{ path: string }> } | undefined)?.changes ?? []) turn.files.add(c.path);
        this.emit(threadId, "item.completed", { itemType: call.itemType, status: failed ? "failed" : "completed", ...described,
          ...(failed ? { detail: `${described.detail ?? call.tool}: ${text((p.error as Json | undefined)?.message) || "failed"}`.slice(0, 300) } : {}) }, { ...at, itemId: callId });
        return;
      }
      case "session.next.compaction.started":
        s.compacting = true;
        this.emit(threadId, "item.started", { itemType: "context_compaction", status: "inProgress" }, { ...at, itemId: `compaction:${text(p.messageID)}` });
        return;
      case "session.next.compaction.ended":
      case "session.compacted": {
        if (!s.compacting && type === "session.compacted") return; // the ended event already said so
        const wasCompacting = s.compacting;
        s.compacting = false;
        if (wasCompacting) this.emit(threadId, "item.completed", { itemType: "context_compaction", status: "completed" }, { ...at, itemId: `compaction:${text(p.messageID)}` });
        this.emit(threadId, "thread.state.changed", { state: "compacted", trigger: p.reason === "manual" ? "manual" : "auto",
          ...(s.contextUsed ? { beforeTokens: s.contextUsed } : {}) }, at);
        return;
      }
      case "session.next.model.switched": {
        const ref = (p.model ?? {}) as Json;
        if (typeof ref.providerID === "string" && typeof ref.id === "string") {
          s.info = { ...s.info, model: `${ref.providerID}/${ref.id}` };
          if (turn) turn.model = s.info.model;
        }
        return;
      }
      case "session.next.retried": {
        const error = (p.error ?? {}) as Json;
        this.emit(threadId, "runtime.warning", { message: text(error.message) || "opencode is retrying", retrying: true }, at);
        return;
      }
      case "session.error": {
        const error = (p.error ?? {}) as Json;
        const message = text((error.data as Json | undefined)?.message) || text(error.name) || "opencode error";
        if (turn) turn.error = error.name === "MessageAbortedError" && turn.interrupted ? turn.error : message;
        else this.emit(threadId, "runtime.warning", { message }, at);
        return;
      }
      case "session.idle":
        turn?.wake?.();
        return;
      case "session.status":
        if ((p.status as Json | undefined)?.type === "idle") turn?.wake?.();
        return;
      case "permission.v2.asked":
      case "permission.asked": {
        const requestId = text(p.id);
        if (!requestId || s.pending.has(requestId)) return;
        const action = text(p.action) || text(p.permission) || "permission";
        const requestType = REQUEST_TYPES[action] ?? "permission_approval";
        const resources = Array.isArray(p.resources) ? (p.resources as unknown[]).map(String) : Array.isArray(p.patterns) ? (p.patterns as unknown[]).map(String) : [];
        s.pending.set(requestId, { requestType, ...(turn ? { turnId: turn.id } : {}) });
        this.emit(threadId, "request.opened", { requestType, detail: `${action}${resources.length ? `: ${resources.join(", ")}` : ""}`.slice(0, 200),
          args: { action, resources }, options: APPROVAL_OPTIONS }, { ...at, requestId,
          ...(text((p.source as Json | undefined)?.callID) ? { itemId: text((p.source as Json).callID) } : {}) });
        return;
      }
      case "permission.v2.replied":
      case "permission.replied": {
        const requestId = text(p.id) || text(p.requestID);
        const pending = s.pending.get(requestId);
        if (!pending) return;
        s.pending.delete(requestId);
        this.emit(threadId, "request.resolved", { requestType: pending.requestType, ...(typeof p.reply === "string" ? { decision: p.reply } : {}) }, { requestId, ...(pending.turnId ? { turnId: pending.turnId } : {}) });
        return;
      }
      case "question.v2.asked":
      case "question.asked": {
        const requestId = text(p.id);
        if (!requestId || s.questions.has(requestId)) return;
        const questions = toUserInputQuestions(p.questions);
        if (!questions.length) return;
        s.questions.set(requestId, { questions, ...(turn ? { turnId: turn.id } : {}) });
        this.emit(threadId, "user-input.requested", { questions }, { ...at, requestId });
        return;
      }
      case "question.v2.replied":
      case "question.v2.rejected":
      case "question.replied":
      case "question.rejected": {
        const requestId = text(p.id) || text(p.requestID);
        const q = s.questions.get(requestId);
        if (!q) return;
        s.questions.delete(requestId);
        this.emit(threadId, "user-input.resolved", { answers: {} }, { requestId, ...(q.turnId ? { turnId: q.turnId } : {}) });
        return;
      }
      default:
        return;
    }
  }
}

/** Title, detail and normalized data for an OpenCode tool call. */
function describeTool(itemType: CanonicalItemType, tool: string, input: Json, output?: string): Omit<ItemLifecyclePayload, "itemType" | "status"> {
  const title = text(input.description) || text(input.command) || text(input.filePath) || text(input.path) || text(input.pattern) || tool;
  switch (itemType) {
    case "command_execution": {
      const command = text(input.command) || title;
      return { title: text(input.description) || undefined, detail: command, data: { command, ...(typeof input.workdir === "string" ? { cwd: input.workdir } : {}),
        exitCode: null, ...(output !== undefined ? { output } : {}) } };
    }
    case "file_change": {
      const path = text(input.filePath) || text(input.path);
      return { title: tool, detail: path || tool, data: { changes: path ? [{ path, kind: tool === "write" ? "add" : "update" }] : [] } };
    }
    default:
      return { title: tool, detail: title.slice(0, 200), data: { tool, input } };
  }
}

/** OpenCode's questions → Loom's; the id is the question's position. */
function toUserInputQuestions(raw: unknown): UserInputQuestion[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Json[]).flatMap((q, index) => {
    const question = text(q.question).trim();
    if (!question) return [];
    const options = (Array.isArray(q.options) ? q.options as unknown[] : [])
      .map(o => typeof o === "string" ? { label: o, description: "" } : { label: text((o as Json).label), description: text((o as Json).description) })
      .filter(o => o.label);
    return [{ id: String(index), header: text(q.header) || "Question", question, options,
      ...(q.custom !== false || !options.length ? { allowCustomAnswer: true } : {}), multiSelect: q.multiple === true }];
  });
}

/** Loom's answers → OpenCode's: one list of strings per question, in order (t3code's toOpenCodeQuestionAnswers). */
export function toOpenCodeAnswers(questions: UserInputQuestion[], answers: UserInputAnswers): string[][] {
  return questions.map(q => {
    const raw = answers[q.id] ?? answers[q.header] ?? answers[q.question];
    if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
    if (raw && typeof raw === "object" && Array.isArray((raw as { answers?: unknown }).answers)) return (raw as { answers: unknown[] }).answers.map(String);
    if (typeof raw === "string") return raw.trim() ? [raw] : [];
    return [];
  });
}
