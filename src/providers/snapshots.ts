/**
 * Live provider snapshots: per agent, what its harness says right now about
 * its version, sign-in and models. Ported from t3code's managed provider
 * snapshots (provider/makeManagedServerProvider.ts):
 *
 * - refreshed when the project opens and when an agent's configuration
 *   changes;
 * - refreshed every 5 minutes, but only while someone is watching (a client
 *   is connected), as t3code gates on provider-status demand;
 * - refreshed on request (the picker's refresh, `POST …/providers/refresh`);
 * - every change is published, so clients update their model pickers without
 *   asking.
 *
 * A failed probe keeps the last models it had: a provider that is briefly
 * unreachable shouldn't empty the picker.
 */

import { digest } from "../core/continuity/contracts.js";
import { logbook } from "../core/logbook.js";
import { providerRegistry } from "./registry.js";
import type { ProviderAuth, ProviderModel } from "./probe.js";

export const PROVIDER_REFRESH_INTERVAL_MS = 5 * 60_000;

export interface ProviderSnapshot {
  agentId: string;
  kind: string;
  status: "checking" | "ready" | "unavailable" | "error";
  version: string | null;
  auth: ProviderAuth;
  models: ProviderModel[];
  /** "native": reported by the harness; otherwise Loom's fallback list. */
  modelSource: "native" | "cli" | "builtin" | "none";
  /** When the models were last reported by the harness itself. */
  modelsAt: number | null;
  checkedAt: number | null;
  error?: string;
}

export interface SnapshotTarget { id: string; kind: string; options: Record<string, unknown> }

export interface SnapshotHost {
  /** Enabled agents whose driver is registered. */
  targets(): SnapshotTarget[];
  cwd(agentId: string): string;
  /** Whether anyone is watching; periodic refreshes run only then. */
  hasDemand(): boolean;
}

/** Everything but the timestamps: equal content publishes nothing. */
const content = (s: ProviderSnapshot) => JSON.stringify({ ...s, checkedAt: undefined, modelsAt: undefined });

export class ProviderSnapshots {
  private readonly snapshots = new Map<string, ProviderSnapshot>();
  /** The configuration each snapshot was taken with. */
  private readonly configs = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<ProviderSnapshot | undefined>>();
  private readonly listeners = new Set<(snapshots: ProviderSnapshot[]) => void>();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly host: SnapshotHost, private readonly intervalMs = PROVIDER_REFRESH_INTERVAL_MS) {}

  start(): void {
    if (this.closed || this.timer) return;
    void this.sync({ force: true });
    this.timer = setInterval(() => { if (this.host.hasDemand()) void this.sync({ force: true }); }, this.intervalMs);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  list(): ProviderSnapshot[] { return [...this.snapshots.values()]; }
  get(agentId: string): ProviderSnapshot | undefined { return this.snapshots.get(agentId); }

  onChange(listener: (snapshots: ProviderSnapshot[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Bring every target up to date: new or reconfigured agents are probed,
   * removed ones dropped. With `force`, every agent is probed again.
   */
  async sync(options: { force?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    const targets = this.host.targets();
    const live = new Set(targets.map(t => t.id));
    let dropped = false;
    for (const id of [...this.snapshots.keys()]) if (!live.has(id)) { this.snapshots.delete(id); this.configs.delete(id); dropped = true; }
    if (dropped) this.publish();
    await Promise.all(targets.map(t => {
      const config = digest(JSON.stringify([t.kind, t.options]));
      return options.force || this.configs.get(t.id) !== config ? this.refresh(t.id) : undefined;
    }));
  }

  /** Probe one agent now. Concurrent calls for the same agent share one probe. */
  refresh(agentId: string): Promise<ProviderSnapshot | undefined> {
    const running = this.inFlight.get(agentId);
    if (running) return running;
    const probe = this.probe(agentId).finally(() => this.inFlight.delete(agentId));
    this.inFlight.set(agentId, probe);
    return probe;
  }

  private async probe(agentId: string): Promise<ProviderSnapshot | undefined> {
    const target = this.host.targets().find(t => t.id === agentId);
    const driver = target && providerRegistry.get(target.kind);
    if (!target || !driver || this.closed) return undefined;
    const config = digest(JSON.stringify([target.kind, target.options]));
    const previous = this.snapshots.get(agentId);
    const base: ProviderSnapshot = previous && this.configs.get(agentId) === config ? previous
      : { agentId, kind: target.kind, status: "checking", version: null, auth: { status: "unknown" }, models: [], modelSource: "none", modelsAt: null, checkedAt: null };
    this.configs.set(agentId, config);
    if (!previous || base !== previous) this.set(base);
    let next: ProviderSnapshot;
    try {
      const decoded = providerRegistry.decode(target.kind, target.options);
      const health = await driver.health(decoded);
      if (!health.available) {
        next = { ...base, status: "unavailable", version: health.version, checkedAt: Date.now(), ...(health.error ? { error: health.error } : {}) };
      } else {
        const probe = driver.probe ? await driver.probe(decoded, this.host.cwd(agentId)) : undefined;
        let models = base.models, modelSource = base.modelSource, modelsAt = base.modelsAt;
        if (probe?.models.length) ({ models, modelSource, modelsAt } = { models: probe.models, modelSource: probe.modelSource, modelsAt: Date.now() });
        else if (!models.length && driver.models) {
          const fallback = await driver.models(decoded);
          models = fallback.models.map(id => ({ id }));
          modelSource = fallback.source === "cli" ? "cli" : fallback.source === "builtin" ? "builtin" : "none";
        }
        const error = probe?.error;
        next = { agentId, kind: target.kind, status: error && !probe?.models.length ? "error" : "ready", version: health.version,
          auth: probe?.auth.status === "unknown" && base.auth.status !== "unknown" ? base.auth : probe?.auth ?? base.auth,
          models, modelSource, modelsAt, checkedAt: Date.now(), ...(error ? { error } : {}) };
      }
    } catch (error) {
      next = { ...base, status: "error", checkedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
    }
    // The agent may have been removed or reconfigured while the probe ran.
    if (this.closed || this.configs.get(agentId) !== config) return undefined;
    if (next.error && next.error !== previous?.error) logbook.info("providers", `${agentId}: ${next.error}`);
    this.set(next);
    return next;
  }

  private set(snapshot: ProviderSnapshot): void {
    const previous = this.snapshots.get(snapshot.agentId);
    this.snapshots.set(snapshot.agentId, snapshot);
    if (!previous || content(previous) !== content(snapshot)) this.publish();
  }

  private publish(): void {
    const all = this.list();
    for (const listener of this.listeners) {
      try { listener(all); } catch (error) { logbook.warn("providers", "snapshot listener failed", String(error)); }
    }
  }
}
