/**
 * What each native harness last said about its context and its account:
 * tokens in context against the model's window, whether it is compacting right
 * now, and the provider's usage-limit windows.
 *
 * Adapters report these as status events (context_usage, compacting,
 * native_compacted, usage_limits). The thread renders the events themselves;
 * this keeps the latest reading so a project status can say it without the
 * client replaying the log. Limits belong to the provider account, not to an
 * agent, so two Codex agents share one reading.
 */

import type { AgentContextUsage, LoomEvent, ProviderLimits } from "../../types.js";

import { providerRegistry } from "../../providers/registry.js";
export const providerOf = (kind: string): string | undefined => providerRegistry.accountKey(kind);

export class NativeUsage {
  private readonly contexts = new Map<string, AgentContextUsage>();
  private readonly blocked = new Map<string, Set<string>>();
  private readonly limits = new Map<string, ProviderLimits>();

  /** Fold one adapter event in. Unrelated events are ignored. */
  observe(event: Pick<LoomEvent, "kind" | "agentId" | "payload" | "ts">, driverKind?: string): void {
    const agent = event.agentId;
    if (!agent) return;
    const p = event.payload as Record<string, unknown>;
    const at = typeof event.ts === "number" ? event.ts : Date.now();
    const current = this.contexts.get(agent);
    const turnOver = event.kind === "run_complete" || event.kind === "error" || (event.kind === "status" && p.state === "interrupted");
    if (turnOver) {
      if (current?.compacting) this.contexts.set(agent, { ...current, compacting: false });
      return;
    }
    if (event.kind !== "status") return;
    switch (p.state) {
      case "context_usage":
        if (typeof p.usedTokens !== "number") return;
        this.contexts.set(agent, { usedTokens: p.usedTokens,
          maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : current?.maxTokens ?? null,
          compacting: current?.compacting ?? false, compactedAt: current?.compactedAt ?? null, at });
        return;
      case "compacting":
        this.contexts.set(agent, { ...(current ?? { usedTokens: 0, maxTokens: null, compactedAt: null }), compacting: true, at });
        return;
      case "native_compacted":
        this.contexts.set(agent, { ...(current ?? { usedTokens: 0, maxTokens: null }),
          ...(typeof p.postTokens === "number" ? { usedTokens: p.postTokens } : {}), compacting: false, compactedAt: at, at });
        return;
      case "usage_limits": {
        if (typeof p.provider !== "string" || !Array.isArray(p.windows)) return;
        // A report can carry one window (Claude sends one per event): merge by id.
        const driver = providerRegistry.get(driverKind ?? (typeof p.driverKind === "string" ? p.driverKind : ""))
          ?? providerRegistry.list().find(d => d.limits.provider === p.provider);
        const account = JSON.stringify([driver?.kind ?? p.provider, typeof p.accountKey === "string" ? p.accountKey : p.provider]);
        const previous = this.limits.get(account);
        const windows = new Map((previous?.windows ?? []).map(w => [w.id, w]));
        for (const w of p.windows as ProviderLimits["windows"]) if (w && typeof w.id === "string") windows.set(w.id, w);
        const blocked = this.blocked.get(account) ?? new Set<string>();
        // Account snapshots supersede all reached reasons; window reports
        // only clear the windows they update. The driver declares that scope.
        if ((p.reachedScope ?? driver?.limits.reachedScope) === "account") blocked.clear();
        else for (const w of p.windows as ProviderLimits["windows"]) if (w.id !== p.reached) blocked.delete(w.id);
        if (typeof p.reached === "string") blocked.add(p.reached);
        this.blocked.set(account, blocked);
        this.limits.set(account, { provider: p.provider, windows: [...windows.values()],
          reached: blocked.values().next().value ?? null, at });
        return;
      }
      default:
        return;
    }
  }

  context(agentId: string): AgentContextUsage | null { return this.contexts.get(agentId) ?? null; }
  limitsFor(kind: string, accountKey?: string): ProviderLimits | null {
    const provider = accountKey ?? providerOf(kind);
    return provider ? this.limits.get(JSON.stringify([kind, provider])) ?? null : null;
  }
}
