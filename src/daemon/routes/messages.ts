import type { Express } from 'express';
import { recordRecent } from "../../core/prompts.js";
import type { WithRuntime } from './context.js';
import { ContinuityError, Id, Text, parseBounded } from "../../core/continuity/contracts.js";
import { z } from "zod";
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
      if (rt.continuity) {
        try { parseBounded(z.strictObject({ text: Text.min(1), agentId: Id.optional(), chat: Id.optional(),
          plan: z.boolean().optional(), requestId: Id.optional() }), req.body); }
        catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "invalid continuity request", code: "invalid" }); return; }
      }
      const { text, agentId, chat, plan, requestId } = (req.body ?? {}) as {
        text?: string;
        agentId?: string;
        chat?: string;
        plan?: boolean;
        requestId?: string;
      };
      if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
      let result;
      try { result = await rt.sendMessage(text, agentId, { ...(chat ? { chat } : {}), ...(plan ? { plan: true } : {}), ...(requestId ? { requestId } : {}) }); }
      catch (error) {
        if (!(error instanceof ContinuityError)) throw error;
        res.status(error.code === "invalid" ? 400 : error.code === "unsupported" ? 422 : 409).json({ error: error.message, code: error.code }); return;
      }
      recordRecent(text, { project: rt.info.name, mode: plan ? "plan" : "chat" });
      res.json(result);
    }),
  );
}
