import type { EventKind, LoomEvent, NewEvent } from "../../types.js";
import { MAIN_CHAT } from "../../types.js";
import type { EventStore, ListOpts } from "./contracts.js";

export type SqliteModule = typeof import("node:sqlite");

export class SqliteStore implements EventStore {
  private db: InstanceType<SqliteModule["DatabaseSync"]>;

  constructor(sqlite: SqliteModule, file: string) {
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        agent_id TEXT,
        chat TEXT,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, id);
    `);
    // Migrate BEFORE indexing chat. A log written before chats existed already
    // has an `events` table, so CREATE TABLE IF NOT EXISTS is a no-op and the
    // column is still missing — indexing it here would throw "no such column"
    // and take the whole log down with it. Add the column, then index.
    // The log is append-only and those events are history: a NULL chat reads
    // as the main conversation rather than being rewritten.
    const cols = this.db.prepare("PRAGMA table_info(events)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "chat")) {
      this.db.exec("ALTER TABLE events ADD COLUMN chat TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_chat ON events(chat, id)");
  }

  append(e: Required<Omit<NewEvent, "agentId" | "chat">> & { agentId?: string; chat?: string }): LoomEvent {
    const stmt = this.db.prepare(
      "INSERT INTO events (ts, kind, agent_id, chat, payload) VALUES (?, ?, ?, ?, ?)",
    );
    const res = stmt.run(
      e.ts,
      e.kind,
      e.agentId ?? null,
      e.chat ?? null,
      JSON.stringify(e.payload),
    );
    return {
      id: Number(res.lastInsertRowid),
      ts: e.ts,
      kind: e.kind,
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(e.chat ? { chat: e.chat } : {}),
      payload: e.payload,
    };
  }

  list(opts: ListOpts = {}): LoomEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.since !== undefined) {
      clauses.push("id > ?");
      params.push(opts.since);
    }
    if (opts.kinds?.length) {
      clauses.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
      params.push(...opts.kinds);
    }
    if (opts.chat !== undefined) {
      if (opts.chat === MAIN_CHAT) {
        // pre-chat history has no id and belongs to the main conversation
        clauses.push("(chat = ? OR chat IS NULL)");
      } else {
        clauses.push("chat = ?");
      }
      params.push(opts.chat);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    // When limiting, we want the *most recent* N in ascending order.
    const sql = opts.limit
      ? `SELECT * FROM (SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`
      : `SELECT * FROM events ${where} ORDER BY id ASC`;
    if (opts.limit) params.push(opts.limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number | bigint;
      ts: number;
      kind: string;
      agent_id: string | null;
      chat: string | null;
      payload: string;
    }>;
    return rows.map((r) => ({
      id: Number(r.id),
      ts: r.ts,
      kind: r.kind as EventKind,
      ...(r.agent_id ? { agentId: r.agent_id } : {}),
      ...(r.chat ? { chat: r.chat } : {}),
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  }

  lastId(): number {
    const row = this.db.prepare("SELECT MAX(id) AS m FROM events").get() as
      | { m: number | bigint | null }
      | undefined;
    return row?.m ? Number(row.m) : 0;
  }

  close(): void {
    this.db.close();
  }
}

