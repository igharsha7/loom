/**
 * Append-only per-project event log — Loom's source of truth.
 *
 * Primary store: node:sqlite (built into Node >= 22.5, zero native deps).
 * Fallback store: JSONL (if node:sqlite is unavailable, or LOOM_STORE=jsonl).
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { LoomEvent, NewEvent } from "../types.js";
import type { EventJournal, EventStore, ListOpts } from "./events/contracts.js";
import { JsonlStore } from "./events/jsonl-store.js";
import { SqliteStore, type SqliteModule } from "./events/sqlite-store.js";
export type { EventReader, EventJournal, EventStore, ListOpts } from "./events/contracts.js";

export class EventLog implements EventJournal {
  private closed = false;
  private store: EventStore;
  private emitter = new EventEmitter();

  private constructor(store: EventStore) {
    this.store = store;
    this.emitter.setMaxListeners(100);
  }

  /** Open (or create) the log inside a project's .loom directory. */
  static async open(loomDir: string): Promise<EventLog> {
    fs.mkdirSync(loomDir, { recursive: true });
    if (process.env.LOOM_STORE !== "jsonl") {
      let sqlite: SqliteModule;
      try {
        sqlite = await import("node:sqlite");
      } catch {
        // No node:sqlite in this runtime — the JSONL store is the whole point
        // of the fallback. This is the ONLY thing it catches.
        return new EventLog(new JsonlStore(path.join(loomDir, "log.jsonl")));
      }
      // Deliberately outside the catch. If node:sqlite exists but the log won't
      // open — corrupt file, failed migration, bad permissions — falling back
      // would silently start an EMPTY jsonl log beside a database full of your
      // history, and write new events there. Losing the thread is worse than
      // failing loudly, so this throws.
      return new EventLog(new SqliteStore(sqlite, path.join(loomDir, "log.db")));
    }
    return new EventLog(new JsonlStore(path.join(loomDir, "log.jsonl")));
  }

  append(e: NewEvent): LoomEvent {
    if (this.closed) throw new Error("event log is closed");
    const ev = this.store.append({
      ts: e.ts ?? Date.now(),
      kind: e.kind,
      // Match durable JSON semantics and detach from caller-owned objects.
      payload: JSON.parse(JSON.stringify(e.payload)) as Record<string, unknown>,
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(e.chat ? { chat: e.chat } : {}),
    });
    this.emitter.emit("event", ev);
    return ev;
  }

  list(opts?: ListOpts): LoomEvent[] {
    if (this.closed) throw new Error("event log is closed");
    return this.store.list(opts);
  }

  lastId(): number {
    if (this.closed) throw new Error("event log is closed");
    return this.store.lastId();
  }

  /** Live subscription to appended events; returns unsubscribe. */
  onEvent(cb: (e: LoomEvent) => void): () => void {
    if (this.closed) throw new Error("event log is closed");
    const listener = (event: LoomEvent) => {
      try {
        cb(structuredClone(event));
      } catch (error) {
        // The event is already durable. A failed observer must not make the
        // writer retry it or prevent the other observers from receiving it.
        process.emitWarning(`event subscriber failed: ${String(error)}`, { code: "LOOM_EVENT_SUBSCRIBER" });
      }
    };
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emitter.removeAllListeners();
    this.store.close();
  }
}
