/**
 * Provider errors. Each says which operation failed and whether a native turn
 * could have started, which is what the caller (Brain above all) needs to know.
 *
 * Shaped after t3code's provider/Errors.ts (MIT, © T3 Tools Inc.).
 */

import type { InstanceId, ProviderKind, ThreadId } from "./contracts.js";

export type ProviderErrorCode =
  /** The input was wrong; nothing was sent. */
  | "validation"
  /** No instance, adapter or session to route to; nothing was sent. */
  | "not_found"
  /** The native session to resume is gone; nothing was sent. */
  | "session_missing"
  /** The adapter doesn't support this operation. */
  | "unsupported"
  /** The provider refused or failed the request. `mayHaveStarted` says whether a turn could exist. */
  | "request"
  /** The process or connection failed. */
  | "transport";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly operation: string,
    message: string,
    readonly details: { provider?: ProviderKind; instanceId?: InstanceId; threadId?: ThreadId;
      /** True when a native turn may exist despite the error (outcome unknown). */
      mayHaveStarted?: boolean; cause?: unknown;
      /** The harness's recent stderr, when it explains the failure. */
      stderr?: string } = {},
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Nothing reached the provider as a turn: safe to retry or rebuild. */
  get notSubmitted(): boolean {
    return this.code !== "request" && this.code !== "transport" ? true : this.details.mayHaveStarted === false;
  }
}

export const isProviderError = (error: unknown, code?: ProviderErrorCode): error is ProviderError =>
  error instanceof ProviderError && (code === undefined || error.code === code);
