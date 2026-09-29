import type { Express } from 'express';
import { findProject, readProjectState, writeProjectState, type BoardTask } from "../../core/registry.js";
import { buildBoard } from "../board.js";
import { listTasks } from "../tasks.js";
import type { RouteContext, WithRuntime } from './context.js';
/** Register board routes in the order established by LoomDaemon.routes(). */
export function registerBoardRoutes(app: Express, ctx: Pick<RouteContext, "runtime">, withRuntime: WithRuntime): void {

  // The board: live agents (from us) + pull requests (from gh), sorted into
  // working → needs you → in review → ready. See board.ts.
  app.get("/api/projects/:id/board", async (req, res) => {
    const info = findProject(String(req.params.id));
    if (!info) return void res.status(404).json({ error: "unknown project" });
    try {
      const rt = await ctx.runtime(info.id);
      const status = await rt.status();
      const blocked = status.blockedAgent ? [status.blockedAgent] : [];
      const search = req.query.search ? String(req.query.search) : undefined;
      res.json({
        ...(await buildBoard(info.dir, status.agents, blocked, {
          tasks: rt.boardTasks(),
          ...(search ? { search } : {}),
        })),
        limits: readProjectState(info.dir).boardLimits ?? {},
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Work-in-progress limit for one board column ({ column, limit }; 0/null clears).
  app.put(
    "/api/projects/:id/board/limits",
    withRuntime(async (rt, req, res) => {
      const { column, limit } = (req.body ?? {}) as { column?: unknown; limit?: unknown };
      const col = String(column ?? "");
      if (!["working", "needs-you", "in-review", "ready"].includes(col)) return void res.status(400).json({ error: "column is working, needs-you, in-review or ready" });
      const n = limit === null || limit === "" || limit === undefined ? 0 : Number(limit);
      if (!Number.isInteger(n) || n < 0 || n > 99) return void res.status(400).json({ error: "a limit is a whole number from 1 to 99 (0 clears it)" });
      const state = readProjectState(rt.info.dir);
      const limits = { ...(state.boardLimits ?? {}) };
      if (n) limits[col] = n;
      else delete limits[col];
      state.boardLimits = limits;
      writeProjectState(rt.info.dir, state);
      res.json({ limits });
    }),
  );

  // Cards you write yourself. Unlike an agent or a PR, these are ours, so a
  // drag really moves them — the column IS the state.
  // List the cards you wrote. POST existed without GET — a client that
  // wanted to render or script over its own tasks had to scrape the whole
  // board payload for own:true rows.
  app.get(
    "/api/projects/:id/board/tasks",
    withRuntime(async (rt, _req, res) => {
      res.json({ tasks: readProjectState(rt.info.dir).tasks ?? [] });
    }),
  );

  app.post(
    "/api/projects/:id/board/tasks",
    withRuntime(async (rt, req, res) => {
      const { title, column, agent, blockedBy, priority, due } = (req.body ?? {}) as {
        title?: string;
        column?: string;
        agent?: string;
        blockedBy?: string[];
        priority?: string | null;
        due?: string | null;
      };
      if (!title?.trim()) return void res.status(400).json({ error: "missing title" });
      try {
        res.json({
          task: rt.createTask({
            title,
            ...(column ? { column } : {}),
            ...(agent ? { agent } : {}),
            ...(Array.isArray(blockedBy) ? { blockedBy } : {}),
            ...(priority !== undefined ? { priority } : {}),
            ...(due !== undefined ? { due } : {}),
          }),
        });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.post(
    "/api/projects/:id/board/tasks/:taskId",
    withRuntime(async (rt, req, res) => {
      const { title, column, agent, blockedBy, priority, due } = (req.body ?? {}) as {
        title?: string;
        column?: string;
        agent?: string;
        blockedBy?: string[];
        priority?: string | null;
        due?: string | null;
      };
      try {
        const task = rt.updateTask(String(req.params.taskId), {
          ...(title !== undefined ? { title } : {}),
          ...(column !== undefined ? { column } : {}),
          ...(agent !== undefined ? { agent } : {}),
          ...(blockedBy !== undefined ? { blockedBy } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(due !== undefined ? { due } : {}),
        });
        if (!task) return void res.status(404).json({ error: "unknown task" });
        res.json({ task });
      } catch (err) {
        // The cycle refusal: A→B→A makes both unbecomable forever.
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  // What's still in the way of a card. Empty means dispatchable.
  app.get(
    "/api/projects/:id/board/tasks/:taskId/blockers",
    withRuntime(async (rt, req, res) => {
      res.json({ blockers: rt.taskBlockers(String(req.params.taskId)) });
    }),
  );

  // A card becomes a turn: its title goes to its agent as a prompt. This is
  // where blocked-by has teeth — an agent picking up work whose prerequisite
  // isn't done produces work that gets thrown away, so a blocked card is
  // refused here with the blockers named.
  app.post(
    "/api/projects/:id/board/tasks/:taskId/dispatch",
    withRuntime(async (rt, req, res) => {
      const id = String(req.params.taskId);
      const state = readProjectState(rt.info.dir);
      const task = (state.tasks ?? []).find((t: BoardTask) => t.id === id);
      if (!task) return void res.status(404).json({ error: "unknown task" });
      const blockers = rt.taskBlockers(id);
      if (blockers.length) {
        return void res.status(409).json({
          error: "blocked",
          blockers,
          message: `blocked by ${blockers.map((b) => `"${b.title}"`).join(", ")}`,
        });
      }
      const agentId =
        task.agent ?? (req.body as { agentId?: string } | undefined)?.agentId;
      try {
        const out = await rt.sendMessage(task.title, agentId);
        rt.updateTask(id, { column: "working", agent: out.agentId });
        res.json({ dispatched: true, agentId: out.agentId });
      } catch (err) {
        res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.delete(
    "/api/projects/:id/board/tasks/:taskId",
    withRuntime(async (rt, req, res) => {
      if (!rt.deleteTask(String(req.params.taskId))) {
        return void res.status(404).json({ error: "unknown task" });
      }
      res.json({ deleted: true });
    }),
  );

  // Issues / PRs for the project's GitHub remote, read through the user's
  // own gh CLI (see tasks.ts) — Loom holds no token of its own.
  app.get("/api/projects/:id/tasks", async (req, res) => {
    const info = findProject(String(req.params.id));
    if (!info) return void res.status(404).json({ error: "unknown project" });
    const kind = String(req.query.kind ?? "issue") === "pr" ? "pr" : "issue";
    res.json(
      await listTasks(info.dir, {
        kind,
        ...(req.query.search ? { search: String(req.query.search) } : {}),
      }),
    );
  });
}
