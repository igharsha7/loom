/**
 * The provider session directory: which native session a (chat, agent) pair is
 * bound to, and what resumes it once its process is gone.
 *
 * Ported from t3code's provider/Services/ProviderSessionDirectory.ts (MIT,
 * © T3 Tools Inc.). Differences: keyed by (thread, instance) instead of thread
 * alone (Loom switches provider within a chat), and stored as one JSON file
 * under `.loom/providers/` rather than a SQLite table, because Loom's event log
 * has a JSONL fallback and this must work with either. Stopped bindings are
 * kept: their resume cursor is how a reaped or restarted session comes back.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InstanceId, ProviderKind, RuntimeMode, ThreadId, TurnId } from "./contracts.js";

export type BindingStatus = "starting" | "running" | "stopped" | "error";

/**
 * The native turns a session has run, so a rewind can name the first turn to
 * drop. It is complete from `since` on (every turn started since then is
 * listed); `fromStart` means it is complete for the whole native session.
 */
export interface TurnLedger {
  since: number;
  fromStart: boolean;
  turns: Array<{ id: TurnId; at: number }>;
}

/** Turns kept per binding; older ones fall off and `since` moves up. */
export const LEDGER_CAP = 500;

export interface ProviderBinding {
  threadId: ThreadId;
  instanceId: InstanceId;
  provider: ProviderKind;
  /** Absent on pre-registry bindings; those retain their original cursor ownership. */
  continuationKey?: string;
  status: BindingStatus;
  /** The native thread/session id. */
  resumeCursor: unknown | null;
  /** What the session was started with, to restart it the same way. */
  runtimePayload: { cwd?: string; model?: string; requestedModel?: string | null } | null;
  runtimeMode: RuntimeMode;
  /** Epoch ms of the last start, turn or activity. */
  lastSeenAt: number;
  /** Absent or null: turns of this native session are not known. */
  turnLedger?: TurnLedger | null;
}

export interface SessionDirectory {
  get(threadId: ThreadId, instanceId: InstanceId): ProviderBinding | undefined;
  /**
   * Insert or replace; `lastSeenAt` defaults to now. The turn ledger is kept
   * unless the binding gives one (null clears it).
   */
  upsert(binding: Omit<ProviderBinding, "lastSeenAt"> & { lastSeenAt?: number }): ProviderBinding;
  /** Mark activity without changing anything else. */
  touch(threadId: ThreadId, instanceId: InstanceId, at?: number): void;
  /** Add a started native turn to the binding's ledger. */
  recordTurn(threadId: ThreadId, instanceId: InstanceId, turnId: TurnId, at: number): void;
  list(options?: { excludeStopped?: boolean; threadId?: ThreadId }): ProviderBinding[];
  remove(threadId: ThreadId, instanceId: InstanceId): void;
}

const key = (threadId: string, instanceId: string) => `${threadId}\u0000${instanceId}`;

export class MemorySessionDirectory implements SessionDirectory {
  protected readonly rows = new Map<string, ProviderBinding>();

  get(threadId: ThreadId, instanceId: InstanceId): ProviderBinding | undefined {
    const row = this.rows.get(key(threadId, instanceId));
    return row ? { ...row } : undefined;
  }

  upsert(binding: Omit<ProviderBinding, "lastSeenAt"> & { lastSeenAt?: number }): ProviderBinding {
    const ledger = binding.turnLedger !== undefined ? binding.turnLedger : this.rows.get(key(binding.threadId, binding.instanceId))?.turnLedger;
    const row: ProviderBinding = { ...binding, lastSeenAt: binding.lastSeenAt ?? Date.now(), ...(ledger !== undefined ? { turnLedger: ledger } : {}) };
    if (ledger === undefined) delete row.turnLedger;
    this.rows.set(key(row.threadId, row.instanceId), row);
    this.changed();
    return { ...row };
  }

  touch(threadId: ThreadId, instanceId: InstanceId, at = Date.now()): void {
    const row = this.rows.get(key(threadId, instanceId));
    if (!row) return;
    row.lastSeenAt = Math.max(row.lastSeenAt, at);
    this.changed();
  }

  /** Record a native turn that started at `at`. */
  recordTurn(threadId: ThreadId, instanceId: InstanceId, turnId: TurnId, at: number): void {
    const row = this.rows.get(key(threadId, instanceId));
    if (!row) return;
    const ledger = row.turnLedger ?? { since: at, fromStart: false, turns: [] };
    // The canonical start can arrive before its RPC acknowledgement.
    if (ledger.turns.some(t => t.id === turnId)) return;
    const turns = [...ledger.turns, { id: turnId, at }];
    const kept = turns.slice(-LEDGER_CAP);
    row.turnLedger = kept.length < turns.length ? { since: kept[0]!.at, fromStart: false, turns: kept } : { ...ledger, turns };
    this.changed();
  }

  list(options: { excludeStopped?: boolean; threadId?: ThreadId } = {}): ProviderBinding[] {
    return [...this.rows.values()]
      .filter(r => (!options.excludeStopped || r.status !== "stopped") && (options.threadId === undefined || r.threadId === options.threadId))
      .map(r => ({ ...r }));
  }

  remove(threadId: ThreadId, instanceId: InstanceId): void {
    if (this.rows.delete(key(threadId, instanceId))) this.changed();
  }

  protected changed(): void {}
}

const BindingFile = z.object({
  version: z.literal(1),
  bindings: z.array(z.object({
    threadId: z.string().min(1), instanceId: z.string().min(1), provider: z.string().min(1).max(256),
    continuationKey: z.string().min(1).max(1024).optional(),
    status: z.enum(["starting", "running", "stopped", "error"]), resumeCursor: z.unknown().nullable(),
    runtimePayload: z.object({ cwd: z.string().optional(), model: z.string().optional(), requestedModel: z.string().nullable().optional() }).nullable(),
    runtimeMode: z.enum(["approval-required", "auto-accept-edits", "full-access"]), lastSeenAt: z.number(),
    turnLedger: z.object({ since: z.number(), fromStart: z.boolean(),
      turns: z.array(z.object({ id: z.string().min(1), at: z.number() })) }).nullable().optional(),
  })),
});

/**
 * The directory persisted to `<loomDir>/providers/sessions.json`, written
 * atomically (temp file + rename) on every change. A file that can't be read
 * is moved aside, never overwritten, and the directory starts empty: losing
 * resume cursors means a fresh native session, not a broken project.
 */
export class FileSessionDirectory extends MemorySessionDirectory {
  readonly file: string;
  constructor(loomDir: string, private readonly warn: (message: string) => void = () => {}) {
    super();
    this.file = path.join(loomDir, "providers", "sessions.json");
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      const parsed = BindingFile.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
      // A binding from before turn ledgers: nothing ran on it since it was written,
      // so its turns are known from now on.
      const now = Date.now();
      for (const b of parsed.bindings)
        this.rows.set(key(b.threadId, b.instanceId), { ...b, turnLedger: b.turnLedger === undefined ? { since: now, fromStart: false, turns: [] } : b.turnLedger } as ProviderBinding);
    } catch (error) {
      const aside = `${this.file}.unreadable.${randomUUID()}`;
      try { fs.renameSync(this.file, aside); } catch { /* reported below either way */ }
      this.warn(`provider session directory was unreadable and was moved to ${path.basename(aside)}: ${(error as Error).message}`);
    }
  }

  protected override changed(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, bindings: [...this.rows.values()] }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
