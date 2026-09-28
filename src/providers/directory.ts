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
import type { InstanceId, ProviderKind, RuntimeMode, ThreadId } from "./contracts.js";

export type BindingStatus = "starting" | "running" | "stopped" | "error";

export interface ProviderBinding {
  threadId: ThreadId;
  instanceId: InstanceId;
  provider: ProviderKind;
  status: BindingStatus;
  /** The native thread/session id. */
  resumeCursor: unknown | null;
  /** What the session was started with, to restart it the same way. */
  runtimePayload: { cwd?: string; model?: string } | null;
  runtimeMode: RuntimeMode;
  /** Epoch ms of the last start, turn or activity. */
  lastSeenAt: number;
}

export interface SessionDirectory {
  get(threadId: ThreadId, instanceId: InstanceId): ProviderBinding | undefined;
  /** Insert or merge; `lastSeenAt` defaults to now. */
  upsert(binding: Omit<ProviderBinding, "lastSeenAt"> & { lastSeenAt?: number }): ProviderBinding;
  /** Mark activity without changing anything else. */
  touch(threadId: ThreadId, instanceId: InstanceId, at?: number): void;
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
    const row: ProviderBinding = { ...binding, lastSeenAt: binding.lastSeenAt ?? Date.now() };
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
    threadId: z.string().min(1), instanceId: z.string().min(1), provider: z.enum(["codex", "claude-code"]),
    status: z.enum(["starting", "running", "stopped", "error"]), resumeCursor: z.unknown().nullable(),
    runtimePayload: z.object({ cwd: z.string().optional(), model: z.string().optional() }).nullable(),
    runtimeMode: z.enum(["approval-required", "auto-accept-edits", "full-access"]), lastSeenAt: z.number(),
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
      for (const b of parsed.bindings) this.rows.set(key(b.threadId, b.instanceId), b as ProviderBinding);
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
