import type { Express } from 'express';
import type { WithRuntime } from './context.js';
/** Register agent-settings routes in the order established by LoomDaemon.routes(). */
export function registerAgentSettingsRoutes(app: Express, withRuntime: WithRuntime): void {

  // Rename an agent's role. It's free text — your project decides what jobs
  // exist, not us. Writes .loom/config.json, which is the source of truth.
  app.post(
    "/api/projects/:id/agents/:agentId/role",
    withRuntime(async (rt, req, res) => {
      const { role } = (req.body ?? {}) as { role?: string };
      if (typeof role !== "string") return void res.status(400).json({ error: "missing role" });
      const clean = role.trim().slice(0, 40);
      if (!clean) return void res.status(400).json({ error: "role cannot be empty" });
      const updated = rt.setAgentRole(String(req.params.agentId), clean);
      if (!updated) return void res.status(404).json({ error: "unknown agent" });
      res.json(updated);
    }),
  );

  // Switch an agent off (or back on) without removing it from the roster.
  // 409 rather than 400 for the refusals — holding the baton and being
  // mid-turn are both states that pass on their own, so the message names
  // what to do rather than calling the request malformed.
  app.put(
    "/api/projects/:id/agents/:agentId/enabled",
    withRuntime(async (rt, req, res) => {
      const { enabled } = (req.body ?? {}) as { enabled?: boolean };
      try {
        res.json(rt.setAgentEnabled(String(req.params.agentId), enabled !== false));
      } catch (e) {
        res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  /**
   * Lift an alert pause by hand.
   *
   * The loop lifts itself when the alert resolves or the recheck sees the
   * agent healthy again, and that is the normal path. This is the override
   * for when you know better than the alert — a flapping rule, a threshold
   * set too tight — because otherwise the only way out is editing state on
   * disk, and an operator with no button will go and do exactly that.
   */
  app.delete(
    "/api/projects/:id/quarantine/:agentId",
    withRuntime(async (rt, req, res) => {
      const agentId = String(req.params.agentId);
      const lifted = rt.unquarantine(agentId);
      if (!lifted) return void res.status(404).json({ error: `"${agentId}" is not paused` });
      rt.log.append({
        kind: "status",
        agentId,
        payload: { state: "alert_recovery", alert: lifted.reason, retried: false, via: "manual" },
      });
      res.json({ lifted: true, agentId, was: lifted, quarantine: rt.quarantined() });
    }),
  );
}
