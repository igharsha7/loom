import { providerRegistry } from "../../providers/registry.js";
import type { ProviderHealth } from "../../providers/driver.js";
export type NativeKind = string;
export const isNativeKind = (kind: string): boolean => providerRegistry.get(kind)?.continuity.supported === true;
export type HarnessHealth = ProviderHealth;
/** Health belongs to a driver: CLI version probes are a built-in implementation,
 * not an eligibility requirement for a server or ACP transport. */
export async function probeHarness(kind: string, options: Record<string, unknown>): Promise<HarnessHealth> {
  const driver = providerRegistry.get(kind);
  if (!driver) return { kind, available: false, version: null, tested: false, binary: null, fingerprint: null,
    error: `no native continuity protocol for ${kind}`, checkedAt: Date.now() };
  try { return await driver.health(providerRegistry.decode(kind, options)); }
  catch (error) { return { kind, available: false, version: null, tested: false, binary: null, fingerprint: null,
    error: error instanceof Error ? error.message : String(error), checkedAt: Date.now() }; }
}

export interface HarnessTarget { id: string; kind: string; options: Record<string, unknown>; health?: () => Promise<HarnessHealth> }

/**
 * Keeps each native harness's reachability current: a probe every interval,
 * and on demand before dispatch when the last result is older than that.
 */
export class HarnessMonitor {
  private readonly health = new Map<string, HarnessHealth>();
  private readonly inflight = new Map<string, Promise<HarnessHealth>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly targets: () => HarnessTarget[],
    private readonly onChange: (id: string, next: HarnessHealth, previous: HarnessHealth | undefined) => void = () => {},
    readonly intervalMs = 20_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), this.intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  get(id: string): HarnessHealth | undefined { return this.health.get(id); }
  report(): Record<string, HarnessHealth> { return Object.fromEntries(this.health); }

  async pollAll(): Promise<void> {
    const targets = this.targets().filter(t => isNativeKind(t.kind));
    const ids = new Set(targets.map(t => t.id));
    for (const id of [...this.health.keys()]) if (!ids.has(id)) this.health.delete(id);
    await Promise.all(targets.map(t => this.poll(t)));
  }

  /** A result no older than the poll interval; probes now when stale. */
  async ensure(id: string): Promise<HarnessHealth> {
    const cached = this.health.get(id);
    if (cached && Date.now() - cached.checkedAt < this.intervalMs) return cached;
    const target = this.targets().find(t => t.id === id);
    if (!target) return { kind: "unknown", available: false, version: null, tested: false, binary: null, fingerprint: null, error: `no agent "${id}"`, checkedAt: Date.now() };
    return this.poll(target);
  }

  private poll(target: HarnessTarget): Promise<HarnessHealth> {
    const pending = this.inflight.get(target.id);
    if (pending) return pending;
    const probe = (target.health ? target.health().catch(error => ({ kind: target.kind, available: false, version: null,
      tested: false, binary: null, fingerprint: null, error: error instanceof Error ? error.message : String(error), checkedAt: Date.now() }))
      : probeHarness(target.kind, target.options)).then(next => {
      const previous = this.health.get(target.id);
      this.health.set(target.id, next);
      if (!previous || previous.available !== next.available || previous.version !== next.version) this.onChange(target.id, next, previous);
      return next;
    }).finally(() => this.inflight.delete(target.id));
    this.inflight.set(target.id, probe);
    return probe;
  }
}
