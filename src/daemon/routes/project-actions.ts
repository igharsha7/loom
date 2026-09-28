import type { Express } from 'express';
import { renameProject } from "../../core/registry.js";
import type { WithRuntime } from './context.js';
/** Register project-actions routes in the order established by LoomDaemon.routes(). */
export function registerProjectActionsRoutes(app: Express, withRuntime: WithRuntime): void {

  // Rename a project. The registry key stays the id; only the label moves —
  // renames must never orphan scoped tokens, board branches or memory.
  app.patch(
    "/api/projects/:id",
    withRuntime(async (rt, req, res) => {
      const name = String((req.body as { name?: string } | undefined)?.name ?? "").trim().slice(0, 60);
      if (!name) return void res.status(400).json({ error: "missing name" });
      if (!renameProject(rt.info.id, name)) {
        return void res.status(404).json({ error: "no such project" });
      }
      rt.info.name = name;
      res.json({ project: { id: rt.info.id, name } });
    }),
  );

  // Search the thread. The event log answers "what did we say about X"
  // without scrolling — bounded scan of message/decision text, newest first.
  app.get(
    "/api/projects/:id/events/search",
    withRuntime(async (rt, req, res) => {
      const q = String(req.query.q ?? "").trim().toLowerCase();
      if (!q) return void res.status(400).json({ error: "missing q" });
      const limit = Math.min(50, Number(req.query.limit) || 20);
      const hits = rt.log
        .list({ kinds: ["message", "decision", "needs_input"] })
        .filter((e) => String(e.payload.text ?? e.payload.question ?? "").toLowerCase().includes(q))
        .slice(-limit)
        .reverse();
      res.json({ hits });
    }),
  );

  // Fan a subtask out to a child agent. The parent keeps the baton, so this is
  // not "send to someone else" — it's one turn borrowing another pair of hands.
  app.post(
    "/api/projects/:id/subtasks",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as {
        parent?: string;
        agentId?: string;
        task?: string;
        chat?: string;
      };
      if (!b.parent?.trim()) return void res.status(400).json({ error: "missing parent" });
      if (!b.agentId?.trim()) return void res.status(400).json({ error: "missing agentId" });
      if (!b.task?.trim()) return void res.status(400).json({ error: "missing task" });
      try {
        const out = await rt.spawnSubAgent(b.parent.trim(), {
          agentId: b.agentId.trim(),
          task: b.task,
          ...(b.chat ? { chat: b.chat } : {}),
        });
        res.json(out);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
}
