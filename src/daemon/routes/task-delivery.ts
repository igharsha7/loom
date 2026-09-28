import type { Express } from 'express';
import { digest } from "../../core/digest.js";
import type { WithRuntime } from './context.js';
/** Register task-delivery routes in the order established by LoomDaemon.routes(). */
export function registerTaskDeliveryRoutes(app: Express, withRuntime: WithRuntime): void {

  /**
   * The PR a card would open: the branch, its commits, its files, and the
   * exact command. Looking, not doing — pushing publishes, so nothing here
   * happens without the click that follows.
   */
  app.get(
    "/api/projects/:id/tasks/:taskId/pr",
    withRuntime(async (rt, req, res) => {
      try {
        res.json(await rt.taskPrPlan(String(req.params.taskId)));
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.post(
    "/api/projects/:id/tasks/:taskId/pr",
    withRuntime(async (rt, req, res) => {
      try {
        res.json(await rt.openTaskPr(String(req.params.taskId)));
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  /**
   * What happened while you were away.
   *
   * `since` is the client's own idea of when it last looked — the daemon
   * doesn't track attention, and guessing at it would be worse than asking.
   */
  app.get(
    "/api/projects/:id/digest",
    withRuntime(async (rt, req, res) => {
      const since = req.query.since ? Number(req.query.since) : Date.now() - 12 * 3_600_000;
      const events = rt.log.list({ limit: 4000 });
      const label = (id: string) => rt.config.agents.find((a) => a.id === id)?.role ?? id;
      res.json(digest(events, Number.isFinite(since) ? since : 0, label));
    }),
  );
}
