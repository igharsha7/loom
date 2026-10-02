import { builtInDrivers } from "./builtInDrivers.js";
import type { AnyProviderDriver, ProviderEnvironment, ProviderInstance, WriterRecovery } from "./driver.js";
import { NativeDispatchRejected } from "./settlement.js";
import { fenceLocal } from "./drivers/local.js";

export class ProviderRegistry {
  private readonly active = new Map<string, { kind: string; instance?: ProviderInstance }>();
  private readonly drivers = new Map<string, AnyProviderDriver>();
  constructor(drivers: readonly AnyProviderDriver[] = []) { for (const driver of drivers) this.register(driver); }
  register(driver: AnyProviderDriver): void {
    if (!driver.kind || this.drivers.has(driver.kind)) throw new Error(`duplicate or empty provider driver: ${driver.kind}`);
    this.drivers.set(driver.kind, driver);
  }
  get(kind: string): AnyProviderDriver | undefined { return this.drivers.get(kind); }
  require(kind: string): AnyProviderDriver {
    const driver = this.get(kind);
    if (!driver) throw new Error(`provider driver "${kind}" is unavailable; its saved bindings are preserved`);
    return driver;
  }
  list(): AnyProviderDriver[] { return [...this.drivers.values()]; }
  decode(kind: string, options: Record<string, unknown>): any {
    const driver = this.require(kind);
    return driver.configSchema.parse({ ...driver.defaultConfig(), ...options });
  }
  accountKey(kind: string, options: Record<string, unknown> = {}): string | undefined {
    const driver = this.get(kind);
    if (!driver) return undefined;
    try { return driver.accountKey(this.decode(kind, options)); }
    catch { return undefined; } // unavailable or invalid configs remain inspectable in status
  }
  async create(kind: string, instanceId: string, options: Record<string, unknown>, environment: ProviderEnvironment): Promise<ProviderInstance> {
    const driver = this.require(kind);
    let config: unknown;
    try { config = this.decode(kind, options); }
    catch (error) { throw new NativeDispatchRejected(`invalid ${kind} configuration: ${error instanceof Error ? error.message : String(error)}`); }
    const key = JSON.stringify([environment.cwd, instanceId]);
    if (this.active.has(key) || !driver.metadata.supportsMultipleInstances && [...this.active.values()].some(v => v.kind === kind))
      throw new NativeDispatchRejected(`provider instance "${instanceId}" is already materialized or ${kind} permits only one instance`);
    this.active.set(key, { kind });
    try {
      const instance = await driver.create({ instanceId, config, environment });
      const expected = driver.continuationIdentity(instanceId, config);
      if (instance.driverKind !== kind || instance.adapter.provider !== kind || instance.instanceId !== instanceId || instance.adapter.instanceId !== instanceId ||
        instance.continuationIdentity.driverKind !== expected.driverKind || instance.continuationIdentity.continuationKey !== expected.continuationKey ||
        instance.accountKey !== driver.accountKey(config)) {
        await instance.dispose();
        throw new Error("driver returned an instance with mismatched ownership");
      }
      let disposed = false;
      const materialized: ProviderInstance = { ...instance, async dispose() {
        if (disposed) return;
        await instance.dispose(); // failed fencing retains ownership and remains retryable
        disposed = true;
        registry.active.delete(key);
      } };
      const registry = this;
      this.active.set(key, { kind, instance: materialized });
      return materialized;
    } catch (error) { this.active.delete(key); throw error; }
  }
  instances(): ProviderInstance[] { return [...this.active.values()].flatMap(v => v.instance ? [v.instance] : []); }
  /** Old journals retain their original process identity; new journals carry opaque driver records. */
  async fenceRecovery(record: { writer?: WriterRecovery; processGroupId?: number; processIdentity?: string }): Promise<boolean> {
    if (record.writer) return this.get(record.writer.driverKind)?.fence(record.writer.identity) ?? false;
    return fenceLocal({ type: "process-group", value: record });
  }
}
export const providerRegistry = new ProviderRegistry(builtInDrivers);
