/**
 * Stops warm provider sessions nobody has used for a while. The binding and its
 * resume cursor stay, so the next turn resumes the native session.
 *
 * Ported from t3code's provider/Layers/ProviderSessionReaper.ts (MIT, © T3
 * Tools Inc.): 30 minutes of inactivity, a sweep every 5 minutes, and never a
 * session with a turn in progress.
 */

import type { ProviderService } from "./service.js";

export const DEFAULT_INACTIVITY_MS = 30 * 60 * 1000;
export const DEFAULT_SWEEP_MS = 5 * 60 * 1000;

export interface ReaperOptions {
  inactivityMs?: number;
  sweepMs?: number;
  /** Extra liveness: true keeps a session (e.g. background work the harness still runs). */
  busy?: (threadId: string, instanceId: string) => boolean;
  now?: () => number;
  log?: (level: "info" | "warn", message: string, detail?: unknown) => void;
}

export class SessionReaper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping: Promise<number> | null = null;
  readonly inactivityMs: number;
  readonly sweepMs: number;

  constructor(private readonly service: ProviderService, private readonly options: ReaperOptions = {}) {
    this.inactivityMs = Math.max(1, options.inactivityMs ?? DEFAULT_INACTIVITY_MS);
    this.sweepMs = Math.max(1, options.sweepMs ?? DEFAULT_SWEEP_MS);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.sweepMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Resolves with how many sessions were stopped. Overlapping calls share a pass. */
  sweep(): Promise<number> {
    this.sweeping ??= this.pass().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  private async pass(): Promise<number> {
    const now = (this.options.now ?? Date.now)();
    const live = new Set(this.service.listSessions().map(s => `${s.threadId}\u0000${s.instanceId}`));
    let reaped = 0;
    for (const binding of this.service.directory.list({ excludeStopped: true })) {
      if (!live.has(`${binding.threadId}\u0000${binding.instanceId}`)) continue;
      if (now - binding.lastSeenAt < this.inactivityMs) continue;
      if (this.service.activeTurn(binding.threadId, binding.instanceId)) continue;
      if (this.options.busy?.(binding.threadId, binding.instanceId)) continue;
      try {
        await this.service.stopSession(binding.threadId, binding.instanceId);
        reaped++;
        this.options.log?.("info", `stopped idle ${binding.provider} session for "${binding.instanceId}" in chat "${binding.threadId}"`);
      } catch (error) {
        this.options.log?.("warn", `could not stop idle session for "${binding.instanceId}" in chat "${binding.threadId}"`, error);
      }
    }
    return reaped;
  }
}
