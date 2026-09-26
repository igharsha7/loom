import { extractFromTurn, readExternalContent, type ExtractEngine } from "../../core/brain-extract.js";
import { compileBrief, retrieve, type Hit, type RetrieveOpts } from "../../core/brain-index.js";
import { Brain, CONFIDENCE_FLOOR } from "../../core/brain.js";
import { claudeText } from "../../core/claude-cli.js";
import { EventLog } from "../../core/eventlog.js";
import { logbook } from "../../core/logbook.js";
import {
  buildUnifiedMemory,
  hashContent,
  readNativeMemory,
  type ImportedBlock,
} from "../../core/memory.js";
import { SemanticIndex } from "../../core/semantic.js";
import { compileTieredBrief, retrieveTiered } from "../../core/team-memory.js";
import type {
  LoomEvent,
  ProjectConfig,
  ProjectInfo,
  UnifiedMemory
} from "../../types.js";
import { MAIN_CHAT } from "../../types.js";
import { TeamBrainHook } from '../runtime-support.js';

/** Dependencies owned by the project coordinator, read live for each operation. */
export interface RuntimeBriefingsHost {
  info: ProjectInfo;
  config: ProjectConfig;
  log: EventLog;
  teamBrain: TeamBrainHook | null;
  brain: Brain;
  activeSkillsBlock: () => string;
  turnChat: Map<string, string>;
}

/** Owns briefings state for exactly one open project. */
export class RuntimeBriefings {
  constructor(private readonly host: RuntimeBriefingsHost) { }

  /**
   * The dense retrieval channel, when this project opted in (brain.semantic).
   *
   * Null is the normal state, and null costs nothing: no model is loaded, no
   * vectors are written, and retrieval is the three lexical channels. Loading
   * happens in the background — the first brief after a cold start uses
   * whatever is ready, which is the honest thing for something that takes ten
   * seconds to warm up.
   */
  semantic: SemanticIndex | null = null;

  // -------------------------------------------------------------------------
  // Unified memory — "multiple memory in one"
  // -------------------------------------------------------------------------

  /** Freshly read every connected ADE's native memory from disk. */
  importedMemory(): ImportedBlock[] {
    return readNativeMemory(this.host.info.dir, this.host.config);
  }

  /** The merged brain: decisions + imported ADE memories + shared context. */
  unifiedMemory(): UnifiedMemory {
    return buildUnifiedMemory(this.host.info.name, this.host.log.list(), this.importedMemory());
  }

  /**
   * Phase 3: the brain brief for a handoff — the memories relevant to the work
   * in flight, compiled. Query is the recent conversation plus the files recent
   * turns touched; scoped to the incoming agent; low-confidence memories are
   * held back from injection (they stay visible in the Brain tab). Empty string
   * when there's nothing relevant, so callers append it unconditionally.
   */
  async retrieveBrief(events: LoomEvent[], agentId: string): Promise<string> {
    const query = events
      .filter((e) => e.kind === "message")
      .slice(-8)
      .map((e) => String(e.payload.text ?? ""))
      .join(" ");
    const files = [
      ...new Set(
        events
          .filter((e) => e.kind === "turn_diff")
          .flatMap((e) => {
            // turn_diff stores ChangedFile[] ({status, path}); older events or
            // other shapes may carry bare strings. Normalise to paths.
            const raw = (e.payload.files as Array<string | { path?: string }> | undefined) ?? [];
            return raw.map((f) => (typeof f === "string" ? f : (f?.path ?? ""))).filter(Boolean);
          }),
      ),
    ].slice(-20);
    if (!query.trim() && !files.length) return "";
    const brief = await this.brainBriefFor({
      ...(query.trim() ? { query } : {}),
      ...(files.length ? { files } : {}),
      agent: agentId,
      minConfidence: CONFIDENCE_FLOOR,
      limit: 14,
    });
    const team = files.length ? (this.host.teamBrain?.context(files) ?? "") : "";
    return [brief, team].filter(Boolean).join("\n\n");
  }

  /**
   * The memory brief for a query. Solo: this project's brain. Shared with a
   * team: canon, confirmed, own and teammates' proposals ranked together, each
   * line labelled with how sure to be (Loom Teams D42).
   */
  brainBrief(opts: RetrieveOpts): string {
    const pool = this.host.teamBrain?.pool(this.host.brain.all());
    if (!pool) return compileBrief(retrieve(this.host.brain, opts).map((h) => h.memory));
    return compileTieredBrief(retrieveTiered(pool, opts));
  }

  /**
   * The same brief, with the dense channel when this project has one.
   *
   * Embedding is real work (a millisecond, warm) and retrieval is sync, so the
   * vectors are computed here and handed in. Everything about this is
   * best-effort: no model, no network, a slow first load — the brief is the
   * one the three lexical channels produce, which is the brief Loom has always
   * produced.
   */
  async brainBriefFor(opts: RetrieveOpts): Promise<string> {
    const dense = await this.denseFor(opts.query ?? "");
    return this.brainBrief(dense ? { ...opts, dense } : opts);
  }

  /**
   * Retrieval exactly as a briefing sees it — including the dense channel.
   *
   * The Brain tab and `loom brain:search` use this: a search that scored
   * differently from the briefing it's meant to explain would be worse than
   * no search at all.
   */
  async searchBrain(opts: RetrieveOpts): Promise<Hit[]> {
    const dense = await this.denseFor(opts.query ?? "");
    return retrieve(this.host.brain, dense ? { ...opts, dense } : opts);
  }

  /** Vectors for one query, or null when the channel isn't available. */
  async denseFor(query: string): Promise<RetrieveOpts["dense"] | null> {
    if (!this.semantic || !query.trim()) return null;
    try {
      const memories = this.host.brain.all();
      await this.semantic.sync(memories);
      const q = await this.semantic.query(query);
      if (!q) return null;
      const byId = this.semantic.byId(memories);
      return byId.size ? { query: q, byId } : null;
    } catch (err) {
      logbook.warn("brain", "the dense channel didn't answer", String(err), this.host.info.id);
      return null;
    }
  }

  /**
   * Pull each ADE's native memory into the shared log. Idempotent — a source
   * whose content hasn't changed since its last import is skipped, so this is
   * safe to call on connect, on demand, or on a timer.
   */
  importMemories(): { imported: number; sources: string[] } {
    const seen = new Map<string, string>(); // file -> last imported hash
    for (const e of this.host.log.list({ kinds: ["memory_import"] })) {
      seen.set(String(e.payload.file), String(e.payload.hash));
    }
    const sources: string[] = [];
    let imported = 0;
    for (const block of this.importedMemory()) {
      const hash = hashContent(block.content);
      if (seen.get(block.file) === hash) continue;
      this.host.log.append({
        kind: "memory_import",
        agentId: block.agentId,
        payload: { file: block.file, kind: block.kind, chars: block.content.length, hash },
      });
      sources.push(block.file);
      imported += 1;
    }
    return { imported, sources };
  }

  // -------------------------------------------------------------------------
  // Handoff
  // -------------------------------------------------------------------------

  /** Briefings are injected with the first turn after a handoff. */
  pendingBriefings = new Map<string, string>();

  consumePendingBriefing(agentId: string): string | undefined {
    const briefing = this.pendingBriefings.get(agentId);
    this.pendingBriefings.delete(agentId);
    return briefing;
  }

  /**
   * The narrow briefing a child gets.
   *
   * Deliberately not the parent's thread. A child exists to answer one question
   * and hand back an answer; giving it the whole conversation costs tokens for
   * context it was not asked to reason about, and invites it to wander into the
   * parent's job. It gets what it is for, who asked, the rules of the project,
   * and the memories that match its own task — not the parent's.
   */
  subtaskBriefing(parent: string, childId: string, task: string): string {
    const parts = [
      `[Loom subtask] You are "${childId}", running one scoped subtask for "${parent}" ` +
      `in project "${this.host.info.name}".`,
      `The subtask: ${task}`,
      "Do this one thing and report the result. Do not take over the wider task — " +
      `"${parent}" still owns the conversation and holds the baton.`,
    ];
    const skills = this.host.activeSkillsBlock();
    if (skills) parts.push(skills);
    // Retrieval scoped to the child's own task rather than the parent's thread.
    const brief = this.brainBrief({ query: task, agent: childId, limit: 6 });
    if (brief) parts.push(brief);
    return parts.filter(Boolean).join("\n\n");
  }

  /**
   * Phase 2: read a finished turn for durable memory.
   *
   * Fire-and-forget on purpose. A slow or missing extractor must never delay
   * anything — extractFromTurn already swallows engine failures, and this is
   * void-ed so even an unexpected throw can't escape into the event pipeline.
   * Off entirely when config says so; a no-op when Claude isn't available.
   */
  extractMemory(agentId: string, files: string[]): void {
    if (this.host.config.brain?.extractor === "off") return;
    const chat = this.host.turnChat.get(agentId) ?? MAIN_CHAT;
    const turn = this.gatherTurnText(chat);
    if (turn.length < 40) return; // nothing substantial to learn from
    const model = this.host.config.brain?.model ?? "haiku";
    const engine: ExtractEngine = (p) =>
      claudeText(`${p.system}\n\n${p.user}`, { model, timeoutMs: 60_000 });
    const recent = this.host.log.list({ limit: 80 }).filter((e) => (e.chat ?? MAIN_CHAT) === chat);
    void extractFromTurn(this.host.brain, turn, {
      engine,
      agentId,
      chat,
      ...(files.length ? { files } : {}),
      eventId: this.host.log.lastId(),
      ...(readExternalContent(recent) ? { untrusted: true } : {}),
    })
      .then((res) => {
        const learned = res.added.length + res.updated.length + res.forgotten.length;
        if (learned > 0) {
          this.host.log.append({
            kind: "status",
            payload: {
              state: "brain_extract",
              agentId,
              added: res.added.length,
              updated: res.updated.length,
              forgotten: res.forgotten.length,
            },
          });
        }
      })
      .catch(() => { });
  }

  /**
   * The transcript of the most recent turn in a chat: from the last human
   * message to now — the user's ask and what the agent did in reply.
   */
  gatherTurnText(chat: string): string {
    const events = this.host.log.list({ chat, limit: 40 });
    let start = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.kind === "message" && !events[i]!.agentId) {
        start = i;
        break;
      }
    }
    const lines: string[] = [];
    for (const e of events.slice(start)) {
      const p = e.payload;
      if (e.kind === "message") {
        lines.push(`${e.agentId ?? "user"}: ${String(p.text ?? "").slice(0, 2000)}`);
      } else if (e.kind === "tool_call") {
        lines.push(`[${e.agentId} used ${String(p.tool ?? "a tool")}] ${String(p.summary ?? "")}`.trim());
      } else if (e.kind === "file_edit") {
        lines.push(`[${e.agentId} edited ${String(p.path ?? "")}]`);
      } else if (e.kind === "decision") {
        lines.push(`decision: ${String(p.text ?? "")}`);
      }
    }
    return lines.join("\n").trim();
  }
}
