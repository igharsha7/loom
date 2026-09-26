import type { Express } from 'express';
import { recordRecent } from "../../core/prompts.js";
import type { WithRuntime } from './context.js';
/** Register messages routes in the order established by LoomDaemon.routes(). */
export function registerMessagesRoutes(app: Express, withRuntime: WithRuntime): void {

  app.get(
    "/api/projects/:id/events",
    withRuntime(async (rt, req, res) => {
      const since = req.query.since ? Number(req.query.since) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 200;
      // no ?chat= means the whole project — old clients keep seeing the
      // whole thread, which is what they've always shown
      const chat = req.query.chat ? String(req.query.chat) : undefined;
      res.json({ events: rt.log.list({ since, limit, ...(chat ? { chat } : {}) }) });
    }),
  );

  app.post(
    "/api/projects/:id/messages",
    withRuntime(async (rt, req, res) => {
      const { text, agentId, chat, plan } = (req.body ?? {}) as {
        text?: string;
        agentId?: string;
        chat?: string;
        plan?: boolean;
      };
      if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
      const result = await rt.sendMessage(text, agentId, { ...(chat ? { chat } : {}), ...(plan ? { plan: true } : {}) });
      recordRecent(text, { project: rt.info.name, mode: plan ? "plan" : "chat" });
      res.json(result);
    }),
  );
}
