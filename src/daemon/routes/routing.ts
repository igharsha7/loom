import type { Express } from 'express';
import type { WithRuntime } from './context.js';
/** Register routing routes in the order established by LoomDaemon.routes(). */
export function registerRoutingRoutes(app: Express, withRuntime: WithRuntime): void {

  app.post(
    "/api/projects/:id/route",
    withRuntime(async (rt, req, res) => {
      const { task, spec, router, maxHops } = (req.body ?? {}) as {
        task?: string;
        spec?:
        | string
        | Array<
          string | { step: string; role?: string; instruction?: string; onFail?: string; when?: string }
        >;
        router?: "rules" | "llm";
        maxHops?: number;
      };
      if (!task?.trim()) return void res.status(400).json({ error: "missing task" });
      const route = await rt.startRoute({
        task,
        ...(spec !== undefined ? { spec } : {}),
        ...(router ? { router } : {}),
        ...(maxHops ? { maxHops: Number(maxHops) } : {}),
      });
      res.json({ route });
    }),
  );

  app.get(
    "/api/projects/:id/route",
    withRuntime(async (rt, _req, res) => {
      res.json({ route: rt.routeState() });
    }),
  );

  app.get(
    "/api/projects/:id/costs",
    withRuntime(async (rt, _req, res) => {
      res.json({ costs: rt.costSummary() });
    }),
  );

  // The spend ledger as a daily series, per agent per day — "what did this
  // project cost me last week" and "which agent is eating the tokens" are
  // the same walk over the same events.
  app.get(
    "/api/projects/:id/costs/series",
    withRuntime(async (rt, req, res) => {
      const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
      res.json({ days, series: rt.costSeries(days) });
    }),
  );

  app.get(
    "/api/projects/:id/tree",
    withRuntime(async (rt, _req, res) => {
      res.json({ tree: await rt.workingTree() });
    }),
  );

  app.get(
    "/api/projects/:id/memory",
    withRuntime(async (rt, _req, res) => {
      res.json({ memory: rt.unifiedMemory() });
    }),
  );

  app.post(
    "/api/projects/:id/memory/import",
    withRuntime(async (rt, _req, res) => {
      res.json(rt.importMemories());
    }),
  );

  app.delete(
    "/api/projects/:id/route",
    withRuntime(async (rt, _req, res) => {
      res.json({ route: await rt.abortRoute() });
    }),
  );
}
