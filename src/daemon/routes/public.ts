import type { Express } from 'express';
import crypto from "node:crypto";
import { approvalEndpoint } from "../../core/approvals.js";
import { findProject } from "../../core/registry.js";
import { VERSION } from "../../version.js";
import { BUILD_REV, isLoopback, isLoopbackHost } from '../system.js';
import type { RouteContext } from './context.js';
/** Register public routes in the order established by LoomDaemon.routes(). */
export function registerPublicRoutes(app: Express, ctx: Pick<RouteContext, "terminals" | "auth" | "askHuman" | "abandonApprovals">): void {

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      name: "loom",
      version: VERSION,
      rev: BUILD_REV,
      terminal: ctx.terminals.mode,
    });
  });

  app.post("/api/pair/claim", (req, res) => {
    const { token, name } = (req.body ?? {}) as { token?: string; name?: string };
    if (!token) return void res.status(400).json({ error: "missing token" });
    const claimed = ctx.auth.claim(token, name ?? "device");
    if (!claimed) return void res.status(403).json({ error: "invalid or expired pairing token" });
    res.json(claimed);
  });

  /**
   * The local admin console bootstraps here — before the bearer wall, gated by
   * the socket being loopback. A same-machine caller gets the admin token (it
   * lives in a config file they can already read), which is what lets the web
   * app served on localhost mint pairing codes and open phone access. Everyone
   * else — a phone on the tailnet, anything past localhost — is turned away and
   * pairs like any other device. Admin-ness stays a property of the *token*,
   * so a paired client is never an admin no matter where it connects from.
   */
  app.get("/api/bootstrap", (req, res) => {
    // Both must hold: the TCP peer is loopback (can't be spoofed by a header),
    // AND the Host is a loopback literal (defeats DNS rebinding, where the
    // socket is loopback but the browser sends the attacker's hostname).
    // A relayed request arrives from loopback too — it must never be local.
    if (req.headers["x-loom-via"] || !isLoopback(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
      return void res.status(403).json({ error: "not a local request" });
    }
    res.json({ token: ctx.auth.adminToken(), admin: true });
  });

  // An agent in "always ask" mode files a permission request here, through
  // Loom's MCP approval server (src/mcp/approve.ts), and the response waits
  // until a human decides. Guarded by the per-daemon approval secret, not a
  // client token: the MCP child can file requests and nothing else.
  app.post("/api/approvals/request", (req, res) => {
    const ep = approvalEndpoint();
    const given = String(req.headers["x-loom-approval"] ?? "");
    if (!ep || given.length !== ep.secret.length ||
      !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ep.secret))) {
      return void res.status(403).json({ error: "bad approval secret" });
    }
    const b = (req.body ?? {}) as { project?: string; agent?: string; tool?: string; input?: unknown };
    const info = b.project ? findProject(String(b.project)) : undefined;
    if (!info) return void res.status(400).json({ error: "unknown project" });
    void (async () => {
      const pending = await ctx.askHuman({
        project: info.id,
        agent: String(b.agent ?? "agent"),
        tool: String(b.tool ?? "tool"),
        input: b.input ?? {},
      }).catch((err) => ({ behavior: "deny" as const, message: String((err as Error).message) }));
      if (!res.writableEnded) res.json(pending);
    })();
    // An agent that hangs up has stopped waiting; don't hold the card open.
    req.on("close", () => ctx.abandonApprovals(info.id, String(b.agent ?? "agent")));
  });
}
