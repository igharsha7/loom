/**
 * Approvals — "always ask", made real.
 *
 * Every agent that can ask asks from inside the daemon: the Claude adapter's
 * `canUseTool` callback, the Codex adapter's app-server approval requests,
 * and a model agent's tool loop all call `requestApproval`. The daemon shows
 * the request in the thread; you allow or deny; the answer flows back and the
 * agent carries on or stops.
 */

export interface ApprovalDecision {
  behavior: "allow" | "deny";
  /** "session": allow this kind of call for the rest of the agent's session, where the agent supports it. */
  scope?: "once" | "session";
  updatedInput?: Record<string, unknown>;
  message?: string;
}

// ---------------------------------------------------------------------------
// Asking from inside the daemon
// ---------------------------------------------------------------------------
//
// The daemon registers a broker when it starts listening. Until it does, and
// in a bare adapter with no daemon at all (a script, a test), there is nobody
// to ask — and the answer to "may I write this file" with nobody to ask is
// no. A tool that silently proceeds because the UI wasn't wired up would be
// the worst failure mode this file could have.

export interface ApprovalRequest {
  project: string;
  agent: string;
  tool: string;
  input: unknown;
  /** Shown in the card instead of raw JSON, when the tool can say it better. */
  summary?: string;
  /** Aborted when the asking turn ends; the card is then denied and closed. */
  signal?: AbortSignal;
  /** The agent can take "allow for this session". */
  sessionOption?: boolean;
}

export type ApprovalBroker = (req: ApprovalRequest) => Promise<ApprovalDecision>;

let broker: ApprovalBroker | null = null;

export function setApprovalBroker(fn: ApprovalBroker | null): void {
  broker = fn;
}

export function hasApprovalBroker(): boolean {
  return broker !== null;
}

/** Ask the human. Denies when there is no human to ask. */
export async function requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
  if (!broker) {
    return { behavior: "deny", message: "there's nobody to ask — no daemon is running this project" };
  }
  try {
    return await broker(req);
  } catch (err) {
    return { behavior: "deny", message: `the approval didn't complete: ${String((err as Error).message)}` };
  }
}
