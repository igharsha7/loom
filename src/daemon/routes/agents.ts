import type { Express } from 'express';
import { listModelsForKind } from '../system.js';
import type { WithRuntime } from './context.js';
/** Register agents routes in the order established by LoomDaemon.routes(). */
export function registerAgentsRoutes(app: Express, withRuntime: WithRuntime): void {

  // Add an agent to a project. A roster used to be frozen at creation: install
  // a new ADE and your existing projects never heard of it.
  app.post(
    "/api/projects/:id/agents",
    withRuntime(async (rt, req, res) => {
      const { kind, id, role, options } = (req.body ?? {}) as {
        kind?: string;
        id?: string;
        role?: string;
        options?: Record<string, unknown>;
      };
      if (!kind?.trim()) return void res.status(400).json({ error: "missing kind" });
      try {
        res.json(rt.addAgent(kind.trim(), { id, role, ...(options ? { options } : {}) }));
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.delete(
    "/api/projects/:id/agents/:agentId",
    withRuntime(async (rt, req, res) => {
      try {
        res.json(rt.removeAgent(String(req.params.agentId)));
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  // Point an agent at a different model. Empty string clears the override.
  app.post(
    "/api/projects/:id/agents/:agentId/model",
    withRuntime(async (rt, req, res) => {
      const { model } = (req.body ?? {}) as { model?: string };
      try {
        const cfg = rt.setAgentModel(String(req.params.agentId), model ?? "");
        res.json({ agent: cfg });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  // The models this agent can run, and where the list came from.
  //
  // This comment used to promise "every real model this agent can run, asked
  // of the underlying tool — not a hardcoded list", and for two of the five
  // kinds that was a hardcoded list. Four are now genuinely asked (`opencode
  // models` alone reports ~500 across every provider it has, `codex debug
  // models` a JSON catalog); Claude Code has no way to answer and is served
  // from a remembered set. `source` says which, per response, so a caller can
  // report what actually happened instead of what we'd like to have happened.
  app.get(
    "/api/projects/:id/agents/:agentId/models",
    withRuntime(async (rt, req, res) => {
      const agent = rt.config.agents.find((a) => a.id === String(req.params.agentId));
      if (!agent) return void res.status(404).json({ error: "unknown agent" });
      const { models, source } = await listModelsForKind(agent.kind);
      res.json({ kind: agent.kind, count: models.length, models, source });
    }),
  );

  app.post(
    "/api/projects/:id/interrupt",
    withRuntime(async (rt, _req, res) => {
      res.json(await rt.interrupt());
    }),
  );
}
