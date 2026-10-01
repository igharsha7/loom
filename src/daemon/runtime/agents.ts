import type { AdapterEvent, AnyAgent } from "../../types.js";

interface Entry {
  agent: AnyAgent;
  off: () => void;
  starting?: Promise<AnyAgent>;
  stopping?: Promise<void>;
}

/** Owns live instances, subscriptions and startup, never native resume IDs.
 * Replacement invalidates the old callback synchronously. The replacement can
 * be inspected immediately, but cannot start until its predecessor has stopped.
 */
export class RuntimeAgents {
  private readonly entries = new Map<string, Entry>();
  private readonly live = new Map<string, AnyAgent>();
  private readonly retired = new Map<string, Set<Entry>>();
  private closed = false;

  get agents(): ReadonlyMap<string, AnyAgent> { return this.live; }

  install(agent: AnyAgent, onEvent: (event: AdapterEvent) => void): void {
    if (this.closed) throw new Error("agent runtime is closed");
    void this.retire(agent.id).catch(() => {}); // startup retries any retained failed handles
    const entry: Entry = { agent, off: () => {} };
    this.entries.set(agent.id, entry);
    this.live.set(agent.id, agent);
    entry.off = agent.onEvent((event) => {
      if (!this.closed && this.entries.get(agent.id) === entry) onEvent(event);
    });
  }

  async start(id: string): Promise<AnyAgent> {
    const entry = this.entries.get(id);
    if (this.closed || !entry) throw new Error(`agent "${id}" is no longer active`);
    if (!entry.starting) {
      entry.starting = (async () => {
        await this.stopRetired(id);
        if (this.closed || this.entries.get(id) !== entry) throw new Error(`agent "${id}" was replaced`);
        await entry.agent.start();
        if (this.closed || this.entries.get(id) !== entry) throw new Error(`agent "${id}" was replaced`);
        return entry.agent;
      })();
      // A failed startup can be retried; successful startup is shared by callers.
      void entry.starting.catch(() => { entry.starting = undefined; });
    }
    return entry.starting;
  }

  retire(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return this.stopRetired(id);
    this.entries.delete(id);
    this.live.delete(id);
    entry.off();
    const retired = this.retired.get(id) ?? new Set<Entry>();
    retired.add(entry);
    this.retired.set(id, retired);
    return this.stopRetired(id);
  }

  private async stopRetired(id: string): Promise<void> {
    for (const entry of [...(this.retired.get(id) ?? [])]) {
      if (!entry.stopping) {
        const stopped = (async () => {
          // Startup must finish before its process can be stopped.
          await entry.starting?.catch(() => {});
          await entry.agent.stop();
          const retired = this.retired.get(id);
          retired?.delete(entry);
          if (!retired?.size) this.retired.delete(id);
        })();
        entry.stopping = stopped;
        void stopped.catch(() => { entry.stopping = undefined; });
      }
      await entry.stopping;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of this.entries.keys()) void this.retire(id).catch(() => {});
    await Promise.all([...this.retired.keys()].map(id => this.stopRetired(id)));
  }
}
