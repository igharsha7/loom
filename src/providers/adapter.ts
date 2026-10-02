/**
 * The provider adapter contract. An adapter owns one provider's protocol and
 * its live sessions; everything above it (ProviderService, ingestion, Brain,
 * clients) sees only these operations and the canonical runtime events.
 *
 * Ported from t3code's provider/Services/ProviderAdapter.ts (MIT, © T3 Tools
 * Inc.) as a plain async interface. One difference: t3code keys sessions by
 * thread alone, because a thread never changes driver. Loom switches provider
 * within a chat, so each adapter instance serves one Loom agent and keys its
 * sessions by chat; the service routes (chat, agent) to the right adapter.
 */

import type {
  AdapterCapabilities, ApprovalDecision, InstanceId, ProviderKind, ProviderRuntimeEvent, ProviderSession,
  RequestId, RollbackResult, SendTurnInput, SessionStartInput, ThreadId, ThreadSnapshot, TurnId, TurnStartResult, UserInputAnswers,
} from "./contracts.js";

export type RuntimeEventListener = (event: ProviderRuntimeEvent) => void;

export interface ProviderAdapter {
  readonly provider: ProviderKind;
  /** The Loom agent this adapter serves. */
  readonly instanceId: InstanceId;
  readonly capabilities: AdapterCapabilities;

  /** Start a session, or resume one from `resumeCursor`. Resolves once the session is ready. */
  startSession(input: SessionStartInput): Promise<ProviderSession>;
  /** Allocate/submit a turn. Resolution alone is NOT delivery proof: a local
   * `turn.started { local: true }` only allocates correlation. Emit `turn.accepted`
   * after native evidence, or a native `turn.started` without `local`.
   * All turn/item events must keep their original turn id, including late output.
   * Refusal before submission must prove `notSubmitted`; uncertain submission
   * must never masquerade as refusal or completion. */
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  /** Request cancellation of this turn. An acknowledgement is NOT quiescence.
   * Terminal turn events report outcome; tracked command/child items must also
   * finish, or the caller must Stop/fence the session before releasing its lease.
   * Pending approval/question cards must have a cancellation path. */
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  respondToRequest(threadId: ThreadId, requestId: RequestId, decision: ApprovalDecision): Promise<void>;
  respondToUserInput(threadId: ThreadId, requestId: RequestId, answers: UserInputAnswers): Promise<void>;
  /** Start a compaction; completion arrives as `thread.state.changed: compacted`. */
  compact?(threadId: ThreadId): Promise<void>;
  readThread?(threadId: ThreadId): Promise<ThreadSnapshot>;
  /**
   * Drop `beforeTurnId` and every later turn from the live session's native
   * conversation. t3code counts turns back from the end; Loom names the first
   * turn to drop, because a chat's native turns and Loom's turns don't line up
   * one to one (compaction turns, a provider switch in between).
   */
  validateRollback?(threadId: ThreadId, beforeTurnId: TurnId): Promise<string[] | void>;
  rollbackThread?(threadId: ThreadId, beforeTurnId: TurnId, retainedTurnIds?: string[]): Promise<RollbackResult>;
  /** Fence every writer belonging to a session (commands, descendants and
   * remote workers). Resolve only after quiescence is proven. If proof fails,
   * reject with NativeQuiescenceUnknown and retain handles for a later Stop.
   * Do not emit a successful exit/terminal event merely because Stop was requested.
   * A process group is one implementation; an opaque server lease is another. */
  stopSession(threadId: ThreadId): Promise<void>;
  stopAll(): Promise<void>;
  listSessions(): ProviderSession[];
  hasSession(threadId: ThreadId): boolean;
  /** Subscribe to this adapter's canonical events. Returns an unsubscribe. */
  onEvent(listener: RuntimeEventListener): () => void;
}

/**
 * A synchronous fan-out for runtime events. A throwing listener is isolated so
 * one bad subscriber cannot stop the others from seeing the stream.
 */
export class EventHub<T> {
  private readonly listeners = new Set<(event: T) => void>();
  constructor(private readonly onListenerError: (error: unknown) => void = () => {}) {}

  subscribe(listener: (event: T) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(event: T): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch (error) { this.onListenerError(error); }
    }
  }

  get size(): number { return this.listeners.size; }
}
