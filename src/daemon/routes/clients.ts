import type { Express } from 'express';
import { type Request } from "express";
import { bearerToken } from "../auth.js";
import { sendExpoPush } from "../push.js";
import type { RouteContext } from './context.js';
/** Register clients routes in the order established by LoomDaemon.routes(). */
export function registerClientsRoutes(app: Express, ctx: Pick<RouteContext, "auth" | "pushTokens">): void {

  app.get("/api/pair/clients", (_req, res) => {
    res.json({ clients: ctx.auth.clients() });
  });

  app.delete("/api/pair/clients/:clientId", (req, res) => {
    if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
      return void res.status(403).json({ error: "admin only" });
    }
    const revoked = ctx.auth.revoke(String(req.params.clientId));
    if (!revoked) return void res.status(404).json({ error: "unknown client" });
    res.json({ revoked: true });
  });

  // A paired device registers (or clears) its Expo push token.
  app.post("/api/push/register", (req, res) => {
    const me = ctx.auth.clientFor(bearerToken(req.headers.authorization));
    if (!me) return void res.status(403).json({ error: "device tokens only — pair first" });
    const { token, platform } = (req.body ?? {}) as { token?: string; platform?: string };
    if (!token?.trim()) return void res.status(400).json({ error: "missing token" });
    ctx.auth.setPushToken(me.id, token.trim(), platform);
    res.json({ registered: true });
  });

  app.delete("/api/push/register", (req, res) => {
    const me = ctx.auth.clientFor(bearerToken(req.headers.authorization));
    if (!me) return void res.status(403).json({ error: "device tokens only" });
    ctx.auth.setPushToken(me.id, null);
    res.json({ registered: false });
  });

  // Admin: fire a test push at every registered device.
  app.post("/api/push/test", (req, res) => {
    if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
      return void res.status(403).json({ error: "admin only" });
    }
    const tokens = ctx.pushTokens();
    void sendExpoPush(tokens, {
      title: "Loom",
      body: "test notification — pairing works ✓",
    });
    res.json({ sent: tokens.length });
  });
}
