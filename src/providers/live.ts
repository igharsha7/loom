/**
 * Live streamed text for clients, coalesced. A model streams many small deltas
 * a second; sending each as its own websocket frame costs more than it shows.
 * Deltas for the same item are joined and flushed at most every `intervalMs`
 * (t3code batches its client stream the same way).
 */

import type { LiveDelta, LiveItem } from "./ingestion.js";

/** What goes to clients: streamed text, or a tool's progress (`phase`). */
export type LiveFrame = LiveDelta | LiveItem;

export class LiveDeltaThrottle {
  private readonly pending = new Map<string, LiveDelta>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly flushTo: (frame: LiveFrame) => void, private readonly intervalMs = 50) {}

  /** A tool's progress goes out now, after the text streamed before it. */
  pushItem(item: LiveItem): void {
    this.flush();
    try { this.flushTo(item); } catch { /* a viewer's failure is not the stream's */ }
  }

  push(delta: LiveDelta): void {
    const key = [delta.agentId, delta.chat, delta.turnId ?? "", delta.itemId ?? "", delta.streamKind].join("\u0000");
    const queued = this.pending.get(key);
    if (queued) queued.delta += delta.delta;
    else this.pending.set(key, { ...delta });
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
  }

  /** Send everything queued now. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const delta of batch) {
      try { this.flushTo(delta); } catch { /* a viewer's failure is not the stream's */ }
    }
  }

  close(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pending.clear();
  }
}
