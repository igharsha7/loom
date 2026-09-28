/**
 * Bridges provider approval requests to Loom's approval cards: a
 * `request.opened` event is put to a person through the daemon's broker
 * (core/approvals.ts), and the answer goes back to the provider through
 * ProviderService. A card still open when its turn or session ends is closed
 * as denied.
 *
 * t3code routes the same decision through orchestration commands
 * (`thread.approval.respond`); this is Loom's smaller equivalent until the
 * UI overhaul gives requests their own surface.
 */

import { requestApproval } from "../core/approvals.js";
import type { ApprovalDecision, ProviderRuntimeEvent } from "./contracts.js";
import type { ProviderService } from "./service.js";

const TOOL_BY_REQUEST: Record<string, string> = {
  command_execution_approval: "shell", exec_command_approval: "shell",
  file_change_approval: "file_change", apply_patch_approval: "file_change", file_read_approval: "file_read",
};

export class ApprovalBridge {
  private readonly open = new Map<string, AbortController>();
  private readonly unsubscribe: () => void;

  constructor(private readonly service: ProviderService, private readonly project: () => string,
    private readonly ask: typeof requestApproval = requestApproval) {
    this.unsubscribe = service.onEvent(event => this.observe(event));
  }

  close(): void {
    this.unsubscribe();
    for (const controller of this.open.values()) controller.abort();
    this.open.clear();
  }

  private observe(event: ProviderRuntimeEvent): void {
    const session = `${event.threadId}\u0000${event.instanceId}`;
    if (event.type === "request.opened" && event.requestId) {
      if (event.payload.requestType === "tool_user_input") return; // questions go through user-input
      const controller = new AbortController();
      const k = `${session}\u0000${event.requestId}`;
      this.open.set(k, controller);
      // `args` is either the tool's input, or `{ tool, input }` when the provider names the tool.
      const args = (event.payload.args ?? {}) as Record<string, unknown>;
      const named = typeof args.tool === "string";
      const tool = named ? args.tool as string : TOOL_BY_REQUEST[event.payload.requestType] ?? event.payload.requestType;
      const input = named && args.input && typeof args.input === "object" ? args.input : args;
      const sessionOption = (event.payload.options ?? []).some(o => o.decision === "acceptForSession");
      void this.ask({ project: this.project(), agent: event.instanceId, tool, input, ...(sessionOption ? { sessionOption } : {}),
        ...(event.payload.detail ? { summary: event.payload.detail } : {}), signal: controller.signal })
        .then(decision => {
          if (controller.signal.aborted) return;
          const answer: ApprovalDecision = decision.behavior !== "allow" ? "decline"
            : decision.scope === "session" && sessionOption ? "acceptForSession" : "accept";
          return this.service.respondToRequest(event.threadId, event.instanceId, event.requestId!, answer);
        })
        .catch(() => { /* the session is gone; its request went with it */ })
        .finally(() => this.open.delete(k));
      return;
    }
    if (event.type === "request.resolved" && event.requestId) {
      // Resolved elsewhere (the provider timed out or cancelled it): close the card.
      this.abort(`${session}\u0000${event.requestId}`);
      return;
    }
    if (event.type === "turn.completed" || event.type === "turn.aborted" || event.type === "session.exited") {
      for (const k of [...this.open.keys()]) if (k.startsWith(`${session}\u0000`)) this.abort(k);
    }
  }

  private abort(k: string): void {
    this.open.get(k)?.abort();
    this.open.delete(k);
  }
}
