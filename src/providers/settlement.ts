/** Proven absence of turn submission. A warm session may already exist. */
export class NativeDispatchRejected extends Error {
  constructor(message: string) { super(message); this.name = "NativeDispatchRejected"; }
}

/** The bound native session could not be resumed and no turn was started.
 * Safe to rebuild: the binding moves to a new epoch and reconstructs. */
export class NativeSessionMissing extends NativeDispatchRejected {
  constructor(message: string) { super(message); this.name = "NativeSessionMissing"; }
}

/** A native writer may still be active: a descendant, child agent or remote worker. */
export class NativeQuiescenceUnknown extends Error {
  constructor(message: string) { super(message); this.name = "NativeQuiescenceUnknown"; }
}

