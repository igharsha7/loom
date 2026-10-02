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

import { NativeQuiescenceUnknown } from "../core/continuity/contracts.js";
import { EventHub, type ProviderAdapter } from "./adapter.js";
import type {
  AdapterCapabilities, ApprovalDecision, InstanceId, ProviderKind, ProviderRuntimeEvent, ProviderSession, RequestId,
  RuntimeMode, SendTurnInput, ThreadId, TurnId, TurnStartResult, UserInputAnswers,
} from "./contracts.js";
import type { SessionDirectory, TurnLedger } from "./directory.js";
import { ProviderError, isProviderError } from "./errors.js";

export interface EnsureSessionInput {
  threadId: ThreadId;
  instanceId: InstanceId;
  /** Used when starting fresh or when the binding has none recorded. */
  cwd: string;
  runtimeMode: RuntimeMode;
  model?: string | null;
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
  /** Exact prefix retained by an idempotent native cut. */
  retainedTurnIds?: string[];
  nativeSessionId?: string;
  cwd: string;
  runtimeMode: RuntimeMode;
  model?: string;
}

const sessionKey = (threadId: string, instanceId: string) => `${threadId}\u0000${instanceId}`;

export class ProviderService {
  private readonly adapters = new Map<InstanceId, { adapter: ProviderAdapter; unsubscribe: () => void }>();
  private readonly hub: EventHub<ProviderRuntimeEvent>;
  private readonly starting = new Map<string, Promise<EnsuredSession>>();
  private readonly submittingLedgers = new Map<string, TurnLedger | null | undefined>();
  private stoppingAll = 0;
  private readonly stoppingInstances = new Set<string>();
  private readonly stoppingSessions = new Map<string, Promise<void>>();
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
    this.stoppingInstances.add(instanceId);
    try {
      await Promise.allSettled([...this.starting].filter(([k]) => k.endsWith(`\0${instanceId}`)).map(([, p]) => p));
      await entry.adapter.stopAll();
      this.adapters.delete(instanceId);
      entry.unsubscribe();
    }
    finally {
      this.stoppingInstances.delete(instanceId);
      for (const b of this.directory.list({ excludeStopped: true })) {
        if (b.instanceId === instanceId) this.directory.upsert({ ...b, status: entry.adapter.hasSession(b.threadId) ? "error" : "stopped" });
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
    if (this.stoppingAll || this.stoppingInstances.has(input.instanceId) || this.stoppingSessions.has(k))
      throw new ProviderError("validation", "ensureSession", "the native session is stopping", { mayHaveStarted: false });
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
    const stored = this.directory.get(input.threadId, input.instanceId);
    const binding = stored?.provider === adapter.provider ? stored : undefined;
    const cursor = binding?.resumeCursor ?? undefined;
    const cwd = binding?.runtimePayload?.cwd ?? input.cwd;
    const model = input.model === null ? undefined : input.model ?? binding?.runtimePayload?.model;
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
        if (isProviderError(error) || error instanceof NativeQuiescenceUnknown) throw error;
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
  async sendTurn(input: SendTurnInput & Omit<EnsureSessionInput, "threadId" | "instanceId"> & { cancelled?: () => boolean; beforeSubmit?: (session: ProviderSession) => void }): Promise<TurnStartResult & { session: EnsuredSession }> {
    if (!input.input.trim()) throw new ProviderError("validation", "sendTurn", "a turn needs input");
    const ensured = await this.ensureSession(input);
    if (input.cancelled?.()) throw new ProviderError("validation", "sendTurn", "interrupted before the turn started", { mayHaveStarted: false });
    try { input.beforeSubmit?.(ensured.session); }
    catch (error) { throw new ProviderError("validation", "sendTurn", error instanceof Error ? error.message : String(error), { mayHaveStarted: false, cause: error }); }
    const adapter = this.adapter(input.instanceId, "sendTurn");
    const k = sessionKey(input.threadId, input.instanceId);
    if (this.stoppingAll || this.stoppingInstances.has(input.instanceId) || this.stoppingSessions.has(k))
      throw new ProviderError("validation", "sendTurn", "the native session is stopping", { mayHaveStarted: false });
    const startedAt = Date.now();
    const original = this.directory.get(input.threadId, input.instanceId);
    // Acceptance may precede every native event. Persist uncertainty and its
    // activity time before submission, so rollback cannot treat it as idle.
    if (original) { this.submittingLedgers.set(k, original.turnLedger); this.directory.upsert({ ...original, turnLedger: null, lastSeenAt: startedAt }); }
    const before = new Set(original?.turnLedger?.turns.map(t => t.id));
    let result: TurnStartResult;
    try { result = await adapter.sendTurn({ threadId: input.threadId, instanceId: input.instanceId, input: input.input,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
      ...(input.clientTurnId ? { clientTurnId: input.clientTurnId } : {}) }); }
    catch (error) {
      if (original && isProviderError(error) && error.notSubmitted) this.directory.upsert(original);
      const binding = this.directory.get(input.threadId, input.instanceId);
      if (binding && !(isProviderError(error) && error.notSubmitted) && !binding.turnLedger?.turns.some(t => !before.has(t.id)))
        this.directory.upsert({ ...binding, turnLedger: null });
      this.submittingLedgers.delete(k);
      throw error;
    }
    this.submittingLedgers.delete(k);
    if (original) this.directory.upsert({ ...this.directory.get(input.threadId, input.instanceId)!, turnLedger: original.turnLedger });
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
    this.directory.touch(threadId, instanceId, Date.now());
    await adapter.compact(threadId);
    this.directory.touch(threadId, instanceId, Date.now());
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
      ...(typeof binding.resumeCursor === "string" ? { nativeSessionId: binding.resumeCursor } : {}),
      retainedTurnIds: ledger.turns.slice(0, ledger.turns.indexOf(first)).map(t => t.id),
      cwd: binding.runtimePayload?.cwd ?? cwd, runtimeMode: binding.runtimeMode, ...(binding.runtimePayload?.model ? { model: binding.runtimePayload.model } : {}) };
  }

  async validateRollback(step: RollbackStep): Promise<void> {
    if (step.beforeTurnId === null) return;
    const adapter = this.adapter(step.instanceId, "rollback");
    try {
      await this.ensureSession({ threadId: step.threadId, instanceId: step.instanceId, cwd: step.cwd, runtimeMode: step.runtimeMode, ...(step.model ? { model: step.model } : {}) });
    } catch (error) { if (isProviderError(error, "session_missing")) return; throw error; }
    const retained = await adapter.validateRollback?.(step.threadId, step.beforeTurnId);
    if (retained) step.retainedTurnIds = retained;
  }

  /**
   * Carry out a planned rollback. Dropping everything forgets the native
   * session (the next turn starts a new one); otherwise the session is resumed
   * if it isn't live and the provider rolls it back. A native session that is
   * already gone has nothing left to roll back.
   */
  async rollbackConversation(step: RollbackStep): Promise<void> {
    const adapter = this.adapter(step.instanceId, "rollback");
    const saved = this.directory.get(step.threadId, step.instanceId);
    // A completed rollback durably removed this boundary. Retrying its intent
    // must not apply a second native cut (including Codex's count fallback).
    if (saved?.resumeCursor == null || (step.beforeTurnId !== null && saved.turnLedger &&
      !saved.turnLedger.turns.some(t => t.id === step.beforeTurnId))) return;
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
    const result = await adapter.rollbackThread!(step.threadId, step.beforeTurnId, step.retainedTurnIds);
    // Nothing of the native conversation is left.
    if (result.resumeCursor === null) return forget();
    const b = this.directory.get(step.threadId, step.instanceId);
    if (!b) return;
    const ledger = b.turnLedger;
    const cut = ledger ? ledger.turns.findIndex(t => t.id === step.beforeTurnId) : -1;
    this.directory.upsert({ ...b, resumeCursor: result.resumeCursor, status: result.live ? "running" : "stopped",
      turnLedger: ledger ? { ...ledger, turns: (cut < 0 ? ledger.turns : ledger.turns.slice(0, cut)).map(t => ({ ...t, id: result.turnIds?.[t.id] ?? t.id })) } : null });
  }

  /** Stop one session. Its binding stays, marked stopped, so it can be resumed. */
  async stopSession(threadId: ThreadId, instanceId: InstanceId): Promise<void> {
    const k = sessionKey(threadId, instanceId), pending = this.stoppingSessions.get(k);
    if (pending) return pending;
    const adapter = this.adapter(instanceId, "stopSession");
    const stop = (async () => {
      await this.starting.get(k)?.catch(() => {});
      if (adapter.hasSession(threadId)) await adapter.stopSession(threadId);
      this.activeTurns.delete(k);
      const binding = this.directory.get(threadId, instanceId);
      if (binding && binding.status !== "stopped") this.directory.upsert({ ...binding, status: "stopped" });
    })().finally(() => this.stoppingSessions.delete(k));
    this.stoppingSessions.set(k, stop);
    return stop;
  }

  async stopAll(): Promise<void> {
    this.stoppingAll++;
    try {
      // Fence new starts first, then join existing starts and shared stops.
      await Promise.allSettled([...this.starting.values()]);
      const results = await Promise.allSettled(this.listSessions().map(s => this.stopSession(s.threadId, s.instanceId)));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
      this.activeTurns.clear();
      for (const b of this.directory.list({ excludeStopped: true })) this.directory.upsert({ ...b, status: "stopped" });
    } finally { this.stoppingAll--; }
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
    try {
      switch (event.type) {
        case "thread.started": {
          const binding = this.directory.get(event.threadId, event.instanceId);
          if (binding && event.payload.providerThreadId && binding.resumeCursor !== event.payload.providerThreadId)
            this.directory.upsert({ ...binding, resumeCursor: event.payload.providerThreadId });
          break;
        }
        case "turn.started":
          if (event.turnId) {
            this.activeTurns.set(k, event.turnId);
            const ledger = this.submittingLedgers.get(k), binding = this.directory.get(event.threadId, event.instanceId);
            if (binding && ledger) this.directory.upsert({ ...binding, turnLedger: ledger });
            this.submittingLedgers.delete(k);
            this.directory.recordTurn(event.threadId, event.instanceId, event.turnId, event.createdAt);
          }
          this.directory.touch(event.threadId, event.instanceId, event.createdAt);
          break;
        case "turn.completed":
        case "turn.aborted":
          if (event.turnId) this.finishedTurns.set(k, event.turnId);
          if (!event.turnId || this.activeTurns.get(k) === event.turnId) this.activeTurns.delete(k);
          this.directory.touch(event.threadId, event.instanceId, event.createdAt);
          break;
        case "runtime.error": {
          const binding = this.directory.get(event.threadId, event.instanceId);
          if (binding && /quiescence unknown/.test(event.payload.message)) this.directory.upsert({ ...binding, status: "error" });
          break;
        }
        case "session.exited": {
          this.activeTurns.delete(k);
          const binding = this.directory.get(event.threadId, event.instanceId);
          if (binding) this.directory.upsert({ ...binding, status: event.payload.exitKind === "error" ? "error" : "stopped", lastSeenAt: binding.lastSeenAt });
          break;
        }
        default:
          break;
      }
    } catch (error) { this.log("warn", "could not persist provider event", error); }
    finally { this.hub.publish(event); }
  }
}
