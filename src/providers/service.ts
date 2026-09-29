/**
 * ProviderService: the one entry point for driving provider sessions. It routes
 * a (chat, agent) pair to that agent's adapter, starts or recovers the session
 * (adopting a live one, or resuming from the persisted cursor), keeps the
 * session directory current, and fans every adapter's runtime events into one
 * stream.
 *
 * Ported from t3code's provider/Layers/ProviderService.ts (MIT, © T3 Tools
 * Inc.): startSession, recoverSessionForThread, resolveRoutableSession and the
 * capability checks, as plain async code. Loom differences:
 *  - Sessions are keyed by (thread, instance). A chat that switches agent keeps
 *    the other agent's session parked instead of t3code's
 *    stopStaleSessionsForThread; the reaper bounds how long it stays warm.
 *  - A lost native session is reported (`session_missing`) unless the caller
 *    asks for a fresh start, because Brain must move to a new epoch rather than
 *    send a delta to an empty session.
 */

import { EventHub, type ProviderAdapter } from "./adapter.js";
import type {
  AdapterCapabilities, ApprovalDecision, InstanceId, ProviderKind, ProviderRuntimeEvent, ProviderSession, RequestId,
  RuntimeMode, SendTurnInput, ThreadId, TurnId, TurnStartResult, UserInputAnswers,
} from "./contracts.js";
import type { SessionDirectory } from "./directory.js";
import { ProviderError, isProviderError } from "./errors.js";

export interface EnsureSessionInput {
  threadId: ThreadId;
  instanceId: InstanceId;
  /** Used when starting fresh or when the binding has none recorded. */
  cwd: string;
  runtimeMode: RuntimeMode;
  model?: string;
  /** Reasoning effort to start the session with, where the provider fixes it per session. */
  effort?: string;
  /**
   * What to do when the recorded native session can't be resumed:
   * "fail" (default) throws `session_missing`; "fresh" starts a new session.
   */
  onMissingSession?: "fail" | "fresh";
}

export interface EnsuredSession {
  session: ProviderSession;
  /** How the live session was obtained. */
  via: "live" | "resumed" | "fresh";
  /** True when a recorded native session was gone and a fresh one replaced it. */
  replacedLostSession: boolean;
}

/** A planned conversation rollback for one (chat, agent). */
export interface RollbackStep {
  threadId: ThreadId;
  instanceId: InstanceId;
  provider: ProviderKind;
  /** The first native turn to drop; null drops the whole native session. */
  beforeTurnId: TurnId | null;
  /** How many native turns go. */
  turns: number;
  cwd: string;
  runtimeMode: RuntimeMode;
  model?: string;
}

const sessionKey = (threadId: string, instanceId: string) => `${threadId}\u0000${instanceId}`;

export class ProviderService {
  private readonly adapters = new Map<InstanceId, { adapter: ProviderAdapter; unsubscribe: () => void }>();
  private readonly hub: EventHub<ProviderRuntimeEvent>;
  private readonly starting = new Map<string, Promise<EnsuredSession>>();
  private readonly activeTurns = new Map<string, TurnId>();
  /** The last turn each session finished; a turn can finish before sendTurn returns. */
  private readonly finishedTurns = new Map<string, TurnId>();

  constructor(
    readonly directory: SessionDirectory,
    private readonly log: (level: "info" | "warn", message: string, detail?: unknown) => void = () => {},
  ) {
    this.hub = new EventHub(error => this.log("warn", "provider event listener failed", error));
  }

  // ---- registry ------------------------------------------------------------

  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.instanceId)) throw new ProviderError("validation", "register", `an adapter for "${adapter.instanceId}" is already registered`);
    const unsubscribe = adapter.onEvent(event => this.observe(event));
    this.adapters.set(adapter.instanceId, { adapter, unsubscribe });
  }

  /** Stop the instance's sessions and forget it. Bindings (and their cursors) stay. */
  async unregister(instanceId: InstanceId): Promise<void> {
    const entry = this.adapters.get(instanceId);
    if (!entry) return;
    this.adapters.delete(instanceId);
    try { await entry.adapter.stopAll(); }
    finally {
      entry.unsubscribe();
      for (const b of this.directory.list({ excludeStopped: true })) {
        if (b.instanceId === instanceId) this.directory.upsert({ ...b, status: "stopped" });
      }
    }
  }

  adapter(instanceId: InstanceId, operation = "route"): ProviderAdapter {
    const entry = this.adapters.get(instanceId);
    if (!entry) throw new ProviderError("not_found", operation, `no provider adapter for agent "${instanceId}"`, { instanceId });
    return entry.adapter;
  }

  capabilities(instanceId: InstanceId): AdapterCapabilities { return this.adapter(instanceId, "capabilities").capabilities; }
  instances(): InstanceId[] { return [...this.adapters.keys()]; }

  onEvent(listener: (event: ProviderRuntimeEvent) => void): () => void { return this.hub.subscribe(listener); }

  // ---- sessions ------------------------------------------------------------

  /**
   * A live session for (thread, instance): the running one, or one resumed from
   * the directory's cursor, or a fresh one. Concurrent callers share one start.
   */
  async ensureSession(input: EnsureSessionInput): Promise<EnsuredSession> {
    // Everything up to the first await runs synchronously, so a concurrent
    // caller always finds the start registered below.
    const adapter = this.adapter(input.instanceId, "ensureSession");
    const k = sessionKey(input.threadId, input.instanceId);
    if (adapter.hasSession(input.threadId)) {
      const session = adapter.listSessions().find(s => s.threadId === input.threadId);
      if (session) return { session, via: "live", replacedLostSession: false };
    }
    const pending = this.starting.get(k);
    if (pending) return pending;
    const start = this.start(adapter, input).finally(() => this.starting.delete(k));
    this.starting.set(k, start);
    return start;
  }

  private async start(adapter: ProviderAdapter, input: EnsureSessionInput): Promise<EnsuredSession> {
    const binding = this.directory.get(input.threadId, input.instanceId);
    const cursor = binding?.resumeCursor ?? undefined;
    const cwd = binding?.runtimePayload?.cwd ?? input.cwd;
    const model = input.model ?? binding?.runtimePayload?.model;
    const launch = async (resumeCursor: unknown) => {
      // A new native session: every turn it will ever have gets recorded.
      this.directory.upsert({ threadId: input.threadId, instanceId: input.instanceId, provider: adapter.provider,
        status: "starting", resumeCursor: resumeCursor ?? null, runtimePayload: { cwd, ...(model ? { model } : {}) },
        runtimeMode: input.runtimeMode, ...(resumeCursor === undefined ? { turnLedger: { since: Date.now(), fromStart: true, turns: [] } } : {}) });
      try {
        return await adapter.startSession({ threadId: input.threadId, instanceId: input.instanceId, cwd,
          runtimeMode: input.runtimeMode, ...(model || input.effort ? { modelSelection: { ...(model ? { model } : {}), ...(input.effort ? { effort: input.effort } : {}) } } : {}),
          ...(resumeCursor !== undefined ? { resumeCursor } : {}) });
      } catch (error) {
        this.directory.upsert({ threadId: input.threadId, instanceId: input.instanceId, provider: adapter.provider,
          status: "error", resumeCursor: resumeCursor ?? null, runtimePayload: { cwd, ...(model ? { model } : {}) }, runtimeMode: input.runtimeMode });
        // Starting a session never submits a turn, whatever went wrong.
        if (isProviderError(error)) throw error;
        throw new ProviderError("transport", "ensureSession", error instanceof Error ? error.message : String(error),
          { provider: adapter.provider, instanceId: input.instanceId, threadId: input.threadId, mayHaveStarted: false, cause: error });
      }
    };

    let session: ProviderSession;
    let via: EnsuredSession["via"] = cursor !== undefined ? "resumed" : "fresh";
    let replacedLostSession = false;
    try {
      session = await launch(cursor);
    } catch (error) {
      if (cursor === undefined || !isProviderError(error, "session_missing")) throw error;
      if (input.onMissingSession !== "fresh") throw error;
      this.log("info", `native session for "${input.instanceId}" in chat "${input.threadId}" is gone; starting a new one`);
      session = await launch(undefined);
      via = "fresh";
      replacedLostSession = true;
    }
    if (session.provider !== adapter.provider)
      throw new ProviderError("validation", "ensureSession", `adapter/provider mismatch: expected ${adapter.provider}, got ${session.provider}`);
    this.record(session);
    return { session, via, replacedLostSession };
  }

  /** Persist what resumes this session. */
  private record(session: ProviderSession, status: "running" | "stopped" | "error" = "running"): void {
    this.directory.upsert({ threadId: session.threadId, instanceId: session.instanceId, provider: session.provider, status,
      resumeCursor: session.resumeCursor ?? this.directory.get(session.threadId, session.instanceId)?.resumeCursor ?? null,
      runtimePayload: { cwd: session.cwd, ...(session.model ? { model: session.model } : {}) }, runtimeMode: session.runtimeMode });
  }

  /** Start a turn on a live session (starting or resuming one first). */
  async sendTurn(input: SendTurnInput & Omit<EnsureSessionInput, "threadId" | "instanceId">): Promise<TurnStartResult & { session: EnsuredSession }> {
    if (!input.input.trim()) throw new ProviderError("validation", "sendTurn", "a turn needs input");
    const ensured = await this.ensureSession(input);
    const adapter = this.adapter(input.instanceId, "sendTurn");
    const startedAt = Date.now();
    const result = await adapter.sendTurn({ threadId: input.threadId, instanceId: input.instanceId, input: input.input,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
      ...(input.clientTurnId ? { clientTurnId: input.clientTurnId } : {}) });
    const k = sessionKey(input.threadId, input.instanceId);
    if (this.finishedTurns.get(k) !== result.turnId) this.activeTurns.set(k, result.turnId);
    const binding = this.directory.get(input.threadId, input.instanceId);
    if (binding) this.directory.upsert({ ...binding, status: "running", ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {}) });
    this.directory.recordTurn(input.threadId, input.instanceId, result.turnId, startedAt);
    return { ...result, session: ensured };
  }

  activeTurn(threadId: ThreadId, instanceId: InstanceId): TurnId | undefined {
    return this.activeTurns.get(sessionKey(threadId, instanceId));
  }

  /** Interrupt the running turn. A session that isn't live has nothing to interrupt. */
  async interruptTurn(threadId: ThreadId, instanceId: InstanceId, turnId?: TurnId): Promise<void> {
    const adapter = this.adapter(instanceId, "interruptTurn");
    if (!adapter.hasSession(threadId)) return;
    await adapter.interruptTurn(threadId, turnId ?? this.activeTurn(threadId, instanceId));
  }

  async respondToRequest(threadId: ThreadId, instanceId: InstanceId, requestId: RequestId, decision: ApprovalDecision): Promise<void> {
    await this.live(threadId, instanceId, "respondToRequest").respondToRequest(threadId, requestId, decision);
  }

  async respondToUserInput(threadId: ThreadId, instanceId: InstanceId, requestId: RequestId, answers: UserInputAnswers): Promise<void> {
    await this.live(threadId, instanceId, "respondToUserInput").respondToUserInput(threadId, requestId, answers);
  }

  async compact(threadId: ThreadId, instanceId: InstanceId): Promise<void> {
    const adapter = this.live(threadId, instanceId, "compact");
    if (!adapter.capabilities.manualCompaction || !adapter.compact)
      throw new ProviderError("unsupported", "compact", `${adapter.provider} does not support starting a compaction`, { provider: adapter.provider });
    await adapter.compact(threadId);
  }

  /**
   * What putting (thread, instance)'s conversation back to `cutoff` (epoch ms)
   * takes: nothing (no turn started since), dropping the whole native session,
   * or a native rollback before the first turn started since. Throws, before
   * anything changes, when it can't be done: the turns since the cutoff aren't
   * known, or the provider can't roll back (t3code's
   * assertConversationRollbackSupported, checked before files are touched).
   */
  planRollback(threadId: ThreadId, instanceId: InstanceId, cutoff: number, cwd: string): RollbackStep | null {
    const binding = this.directory.get(threadId, instanceId);
    if (!binding || binding.resumeCursor === null || binding.resumeCursor === undefined) return null;
    const adapter = this.adapter(instanceId, "rollback");
    const ledger = binding.turnLedger;
    if (!ledger || (!ledger.fromStart && ledger.since > cutoff)) {
      // Nothing has touched the binding since the cutoff, so no turn ran.
      if (binding.lastSeenAt < cutoff) return null;
      throw new ProviderError("unsupported", "rollback", `the turns ${adapter.provider} ran in this chat since then aren't on record, so its conversation can't be put back with the files`,
        { provider: adapter.provider, instanceId, threadId });
    }
    const after = ledger.turns.filter(t => t.at >= cutoff);
    const first = after[0];
    if (!first) return null;
    const everything = ledger.fromStart && ledger.turns[0]?.id === first.id;
    if (!everything && (!adapter.capabilities.supportsConversationRollback || !adapter.rollbackThread))
      throw new ProviderError("unsupported", "rollback", `${adapter.provider} cannot roll back its conversation`, { provider: adapter.provider, instanceId, threadId });
    return { threadId, instanceId, provider: adapter.provider, beforeTurnId: everything ? null : first.id, turns: after.length,
      cwd: binding.runtimePayload?.cwd ?? cwd, runtimeMode: binding.runtimeMode, ...(binding.runtimePayload?.model ? { model: binding.runtimePayload.model } : {}) };
  }

  /**
   * Carry out a planned rollback. Dropping everything forgets the native
   * session (the next turn starts a new one); otherwise the session is resumed
   * if it isn't live and the provider rolls it back. A native session that is
   * already gone has nothing left to roll back.
   */
  async rollbackConversation(step: RollbackStep): Promise<void> {
    const adapter = this.adapter(step.instanceId, "rollback");
    if (this.activeTurn(step.threadId, step.instanceId))
      throw new ProviderError("validation", "rollback", `a ${adapter.provider} turn is running in this chat`, { provider: adapter.provider, instanceId: step.instanceId, threadId: step.threadId });
    const forget = async () => {
      await this.stopSession(step.threadId, step.instanceId);
      const b = this.directory.get(step.threadId, step.instanceId);
      if (b) this.directory.upsert({ ...b, status: "stopped", resumeCursor: null, turnLedger: null });
    };
    if (step.beforeTurnId === null) return forget();
    try {
      await this.ensureSession({ threadId: step.threadId, instanceId: step.instanceId, cwd: step.cwd, runtimeMode: step.runtimeMode,
        ...(step.model ? { model: step.model } : {}), onMissingSession: "fail" });
    } catch (error) {
      if (isProviderError(error, "session_missing")) return forget();
      throw error;
    }
    const result = await adapter.rollbackThread!(step.threadId, step.beforeTurnId);
    // Nothing of the native conversation is left.
    if (result.resumeCursor === null) return forget();
    const b = this.directory.get(step.threadId, step.instanceId);
    if (!b) return;
    const ledger = b.turnLedger;
    const cut = ledger ? ledger.turns.findIndex(t => t.id === step.beforeTurnId) : -1;
    this.directory.upsert({ ...b, resumeCursor: result.resumeCursor, status: result.live ? "running" : "stopped",
      turnLedger: ledger ? { ...ledger, turns: cut < 0 ? ledger.turns : ledger.turns.slice(0, cut) } : null });
  }

  /** Stop one session. Its binding stays, marked stopped, so it can be resumed. */
  async stopSession(threadId: ThreadId, instanceId: InstanceId): Promise<void> {
    const adapter = this.adapter(instanceId, "stopSession");
    if (adapter.hasSession(threadId)) await adapter.stopSession(threadId);
    this.activeTurns.delete(sessionKey(threadId, instanceId));
    const binding = this.directory.get(threadId, instanceId);
    if (binding && binding.status !== "stopped") this.directory.upsert({ ...binding, status: "stopped" });
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.adapters.values()].map(({ adapter }) => adapter.stopAll()));
    this.activeTurns.clear();
    for (const b of this.directory.list({ excludeStopped: true })) this.directory.upsert({ ...b, status: "stopped" });
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }

  listSessions(): ProviderSession[] {
    return [...this.adapters.values()].flatMap(({ adapter }) => adapter.listSessions());
  }

  private live(threadId: ThreadId, instanceId: InstanceId, operation: string): ProviderAdapter {
    const adapter = this.adapter(instanceId, operation);
    if (!adapter.hasSession(threadId))
      throw new ProviderError("not_found", operation, `no live ${adapter.provider} session for chat "${threadId}"`, { instanceId, threadId });
    return adapter;
  }

  // ---- events --------------------------------------------------------------

  /** Keep the directory and turn state current, then publish. */
  private observe(event: ProviderRuntimeEvent): void {
    const k = sessionKey(event.threadId, event.instanceId);
    switch (event.type) {
      case "thread.started": {
        const binding = this.directory.get(event.threadId, event.instanceId);
        if (binding && event.payload.providerThreadId && binding.resumeCursor !== event.payload.providerThreadId)
          this.directory.upsert({ ...binding, resumeCursor: event.payload.providerThreadId });
        break;
      }
      case "turn.started":
        if (event.turnId) this.activeTurns.set(k, event.turnId);
        this.directory.touch(event.threadId, event.instanceId, event.createdAt);
        break;
      case "turn.completed":
      case "turn.aborted":
        if (event.turnId) this.finishedTurns.set(k, event.turnId);
        if (!event.turnId || this.activeTurns.get(k) === event.turnId) this.activeTurns.delete(k);
        this.directory.touch(event.threadId, event.instanceId, event.createdAt);
        break;
      case "session.exited": {
        this.activeTurns.delete(k);
        const binding = this.directory.get(event.threadId, event.instanceId);
        if (binding) this.directory.upsert({ ...binding, status: event.payload.exitKind === "error" ? "error" : "stopped", lastSeenAt: binding.lastSeenAt });
        break;
      }
      default:
        break;
    }
    this.hub.publish(event);
  }
}
