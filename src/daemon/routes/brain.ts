import type { Express } from 'express';
import { findConflicts } from "../../core/brain-index.js";
import type { MemoryKind, MemoryPatch } from "../../core/brain.js";
import type { WithRuntime } from './context.js';
/** Register brain routes in the order established by LoomDaemon.routes(). */
export function registerBrainRoutes(app: Express, withRuntime: WithRuntime): void {

  app.post(
    "/api/projects/:id/decisions",
    withRuntime(async (rt, req, res) => {
      const { text } = (req.body ?? {}) as { text?: string };
      if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
      const event = rt.log.append({ kind: "decision", payload: { text } });
      // Also a memory. The decision event stays because the projection and
      // forty other things read it; the memory is the addressable copy — the
      // one that can be retrieved by what it's about, corrected, and
      // forgotten. Seeding the brain from the surface people already use
      // beats asking them to fill a second box.
      rt.brain.add({
        kind: "decision",
        text,
        provenance: { agentId: "user", eventId: event.id, ts: event.ts },
      });
      res.json({ event });
    }),
  );

  // --- the brain ---------------------------------------------------------

  app.get(
    "/api/projects/:id/brain",
    withRuntime(async (rt, req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const memories = rt.brain.list({
        ...(q.kind ? { kind: q.kind as MemoryKind } : {}),
        ...(q.chat ? { chat: q.chat } : {}),
        ...(q.includeExpired === "1" ? { includeExpired: true } : {}),
        ...(q.limit ? { limit: Math.min(500, Number(q.limit) || 100) } : {}),
      });
      res.json({ memories, stats: rt.brain.stats() });
    }),
  );

  app.get(
    "/api/projects/:id/brain/search",
    withRuntime(async (rt, req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const files = q.files ? q.files.split(",").filter(Boolean) : [];
      if (!q.q?.trim() && !files.length) {
        return void res.status(400).json({ error: "missing q or files" });
      }
      // searchBrain, not retrieve: a search that scored differently from
      // the briefing it exists to explain would be worse than no search.
      const hits = await rt.searchBrain({
        ...(q.q ? { query: q.q } : {}),
        ...(files.length ? { files } : {}),
        ...(q.chat ? { chat: q.chat } : {}),
        ...(q.agent ? { agent: q.agent } : {}),
        limit: Math.min(50, Number(q.limit) || 12),
        explain: q.explain === "1",
      });
      res.json({ hits });
    }),
  );

  app.post(
    "/api/projects/:id/brain",
    withRuntime(async (rt, req, res) => {
      const body = (req.body ?? {}) as {
        text?: string;
        kind?: MemoryKind;
        entities?: string[];
        confidence?: number;
        chat?: string;
      };
      if (!body.text?.trim()) return void res.status(400).json({ error: "missing text" });
      try {
        const { memory, created } = rt.brain.add({
          kind: body.kind ?? "fact",
          text: body.text,
          ...(body.entities ? { entities: body.entities } : {}),
          ...(body.chat ? { scope: { chat: body.chat } } : {}),
          ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
          provenance: { agentId: "user", eventId: rt.log.lastId(), ts: Date.now() },
        });
        res.json({ memory, created });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  // Likely contradictions between units, heuristically flagged for a human
  // to resolve — each flag names the signal that tripped it.
  app.get(
    "/api/projects/:id/brain/conflicts",
    withRuntime(async (rt, _req, res) => {
      res.json({ conflicts: findConflicts(rt.brain.all()) });
    }),
  );

  // The brain as a file. Export is the live memories — history stays where it
  // happened; what travels is what the project knows. Import dedupes by hash,
  // so bringing the same file in twice reports "known", not duplicates.
  app.get(
    "/api/projects/:id/brain/export",
    withRuntime(async (rt, _req, res) => {
      res.json(rt.brain.export(rt.info.name));
    }),
  );

  app.post(
    "/api/projects/:id/brain/import",
    withRuntime(async (rt, req, res) => {
      try {
        const out = rt.brain.import(req.body as Parameters<typeof rt.brain.import>[0], {
          agentId: "import",
          eventId: rt.log.lastId(),
          ts: Date.now(),
        });
        res.json(out);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.patch(
    "/api/projects/:id/brain/:mid",
    withRuntime(async (rt, req, res) => {
      try {
        res.json({ memory: rt.brain.update(String(req.params.mid), (req.body ?? {}) as MemoryPatch, "user") });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(/no such memory/.test(msg) ? 404 : 400).json({ error: msg });
      }
    }),
  );

  app.delete(
    "/api/projects/:id/brain/:mid",
    withRuntime(async (rt, req, res) => {
      const reason = String((req.query as Record<string, string>).reason ?? "").trim();
      if (!reason) return void res.status(400).json({ error: "forgetting needs a reason" });
      const forgot = rt.brain.forget(String(req.params.mid), reason, "user");
      if (!forgot) return void res.status(404).json({ error: "no such memory" });
      res.json({ forgot: true });
    }),
  );

  app.get(
    "/api/projects/:id/brain/:mid/history",
    withRuntime(async (rt, req, res) => {
      res.json({ history: rt.brain.history(String(req.params.mid)) });
    }),
  );
}
