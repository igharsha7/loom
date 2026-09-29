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

  // An agent's picture ({ avatar: data URL | null }).
  app.put(
    "/api/projects/:id/agents/:agentId/avatar",
    withRuntime(async (rt, req, res) => {
      const { avatar } = (req.body ?? {}) as { avatar?: unknown };
      try {
        const out = rt.setAgentAvatar(String(req.params.agentId), avatar === null || avatar === undefined ? null : String(avatar));
        if (!out) return void res.status(404).json({ error: "unknown agent" });
        res.json(out);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  // A model agent's sampling: temperature and max tokens (null clears).
  app.put(
    "/api/projects/:id/agents/:agentId/sampling",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as { temperature?: unknown; maxTokens?: unknown };
      const num = (v: unknown): number | null | undefined => (v === undefined ? undefined : v === null || v === "" ? null : Number(v));
      try {
        const cfg = rt.setAgentSampling(String(req.params.agentId), { temperature: num(b.temperature), maxTokens: num(b.maxTokens) });
        res.json({ id: cfg.id, options: cfg.options });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  // Is this agent ready? Installed, signed in, model listed — no prompt sent.
  app.post(
    "/api/projects/:id/agents/:agentId/check",
    withRuntime(async (rt, req, res) => {
      const out = await rt.checkAgent(String(req.params.agentId));
      if (!out) return void res.status(404).json({ error: "no such agent" });
      res.json(out);
    }),
  );

  // Standing instructions for one agent, sent ahead of every turn it takes.
  app.put(
    "/api/projects/:id/agents/:agentId/instructions",
    withRuntime(async (rt, req, res) => {
      const { instructions } = (req.body ?? {}) as { instructions?: unknown };
      if (typeof instructions !== "string") return void res.status(400).json({ error: "instructions must be text (empty clears them)" });
      const updated = rt.setAgentInstructions(String(req.params.agentId), instructions);
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
