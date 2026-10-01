import type { Express } from 'express';
import type { WithRuntime } from './context.js';
import { RewindRefused } from '../runtime/turns.js';
/** Register history routes in the order established by LoomDaemon.routes(). */
export function registerHistoryRoutes(app: Express, withRuntime: WithRuntime): void {

  // Named routes: define and remove without hand-editing config.json.
  // Validated against the current roster before saving.
  app.put(
    "/api/projects/:id/routes/:name",
    withRuntime(async (rt, req, res) => {
      const steps = (req.body as { steps?: unknown } | undefined)?.steps;
      if (!Array.isArray(steps) || !steps.length) {
        return void res.status(400).json({ error: "missing steps" });
      }
      try {
        res.json({ routes: rt.saveRoute(String(req.params.name), steps as never) });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.delete(
    "/api/projects/:id/routes/:name",
    withRuntime(async (rt, req, res) => {
      try {
        res.json({ routes: rt.deleteRoute(String(req.params.name)) });
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  // Checkpoint and restore: brain + board + config, NOT the working tree
  // (git owns files) and NOT the event log (history is what happened).
  app.get(
    "/api/projects/:id/snapshot",
    withRuntime(async (rt, _req, res) => {
      res.json(rt.snapshot());
    }),
  );

  app.post(
    "/api/projects/:id/restore",
    withRuntime(async (rt, req, res) => {
      try {
        res.json(rt.restore(req.body as Parameters<typeof rt.restore>[0]));
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  /**
   * Rewind (#101): points the *working tree* can be put back to.
   *
   * The pair above is deliberately not ctx. That one restores brain, board
   * and config and leaves files to git; this one is the files, and leaves
   * brain, board and history alone. Both exist because they answer different
   * questions, and a single "restore" that did both would be a button nobody
   * could predict.
   */
  app.get(
    "/api/projects/:id/checkpoints",
    withRuntime(async (rt, _req, res) => {
      res.json({ checkpoints: await rt.checkpoints() });
    }),
  );

  // One file from a checkpoint: { path }.
  app.post(
    "/api/projects/:id/checkpoints/:cpId/rewind-file",
    withRuntime(async (rt, req, res) => {
      const file = String((req.body as { path?: unknown } | undefined)?.path ?? "");
      if (!file) return void res.status(400).json({ error: "which file? send { path }" });
      try {
        res.json(await rt.rewindFile(String(req.params.cpId), file));
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.post(
    "/api/projects/:id/checkpoints/:cpId/rewind",
    withRuntime(async (rt, req, res) => {
      // { conversation: false } puts the files back and leaves every conversation as it is.
      const conversation = (req.body as { conversation?: unknown } | undefined)?.conversation !== false;
      try {
        res.json(await rt.rewind(String(req.params.cpId), { conversation }));
      } catch (err) {
        const code = err instanceof RewindRefused ? err.code : undefined;
        res.status(code ? 409 : 400).json({ error: err instanceof Error ? err.message : String(err), ...(code ? { code } : {}) });
      }
    }),
  );

  // Hung sessions: busy far longer than any plausible turn. GET lists them;
  // POST reaps one — interrupt, stop, respawn from config, baton released if
  // the corpse held it.
  app.get(
    "/api/projects/:id/stale",
    withRuntime(async (rt, _req, res) => {
      res.json({ stale: rt.staleSessions() });
    }),
  );

  app.post(
    "/api/projects/:id/agents/:agentId/reap",
    withRuntime(async (rt, req, res) => {
      try {
        res.json(await rt.reapSession(String(req.params.agentId ?? "")));
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  // Re-run the last failed turn on a different agent, with the failure
  // attached as context so the second agent knows what was tried.
  app.post(
    "/api/projects/:id/retry",
    withRuntime(async (rt, req, res) => {
      const to = String((req.body as { agentId?: string } | undefined)?.agentId ?? "").trim();
      if (!to) return void res.status(400).json({ error: "missing agentId" });
      try {
        res.json(await rt.retryTurn(to));
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.get(
    "/api/projects/:id/subtasks",
    withRuntime(async (rt, _req, res) => {
      res.json({ subtasks: rt.liveSubtasks() });
    }),
  );
}
