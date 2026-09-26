import type { Express } from 'express';
import { type Request } from "express";
import { bearerToken } from "../auth.js";
import type { RouteContext } from './context.js';
/** Register team routes in the order established by LoomDaemon.routes(). */
export function registerTeamRoutes(app: Express, ctx: Pick<RouteContext, "auth" | "team" | "runtimes">): void {

  // ---- Loom Teams: this daemon on a Team Hub (daemon/team.ts) -------------
  // Reading the team view is for any full client; changing membership,
  // keys or sign-in is admin-only — it's this machine's identity.
  app.get("/api/team", (req, res) => {
    if (ctx.auth.allowedProjects(bearerToken(req.headers.authorization) ?? "")) {
      return void res.status(403).json({ error: "team view needs a full (unscoped) client" });
    }
    res.json(ctx.team.status());
  });

  app.post("/api/team/:action", (req, res) => {
    if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
      return void res.status(403).json({ error: "admin only" });
    }
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const action = String(req.params.action);
    void (async () => {
      try {
        let out: unknown = { ok: true };
        if (action === "signin") {
          // no hub = the hosted one; `token` is a hosted refresh token from a CLI that ran the browser sign-in
          await ctx.team.signIn(b.hub ?? "", {
            ...(b.github ? { github: b.github } : {}),
            ...(b.secret ? { secret: b.secret } : {}),
            ...(b.token ? { token: b.token } : {}),
          });
          await ctx.team.connect();
        } else if (action === "create") out = await ctx.team.createTeam(String(b.name ?? ""));
        else if (action === "invite") out = await ctx.team.invite(b.teamId || undefined);
        else if (action === "join") {
          if (!b.link) throw new Error("missing invite link");
          out = await ctx.team.join(b.link, { ...(b.github ? { github: b.github } : {}), ...(b.secret ? { secret: b.secret } : {}) });
        } else if (action === "leave") await ctx.team.leave(b.teamId || undefined);
        else if (action === "remove") {
          if (!b.userId) throw new Error("missing userId");
          out = await ctx.team.removeMember(b.userId, b.teamId || undefined);
        } else if (action === "rotate") out = await ctx.team.rotate(b.teamId || undefined);
        else if (action === "beat") out = { sessions: await ctx.team.beat() };
        else if (action === "poll-github") out = { added: await ctx.team.pollGitHub() };
        else if (action === "webhook") {
          // Phase 6 (D83): the team's GitHub webhook — payload URL + secret, optionally installed on the repo
          const q = (req.body ?? {}) as Record<string, unknown>;
          const rt = q.projectId ? ctx.runtimes.get(String(q.projectId)) : undefined;
          out = await ctx.team.webhook({
            ...(b.teamId ? { teamId: b.teamId } : {}),
            ...(b.repo ? { repo: b.repo } : {}),
            ...(q.install ? { install: true } : {}),
            ...(q.rotate ? { rotate: true } : {}),
            ...(rt ? { rt } : {}),
          });
        }
        else return void res.status(404).json({ error: `unknown team action "${action}"` });
        res.json({ result: out, team: ctx.team.status() });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    })();
  });

  // ---- this daemon as a runner (Phase 5): admin only — it's this machine ----
  app.get("/api/runner", (req, res) => {
    if (!(req as Request & { isAdmin?: boolean }).isAdmin) return void res.status(403).json({ error: "admin only" });
    res.json(ctx.team.runner?.status() ?? { running: false, config: ctx.team.runnerConfig() });
  });

  app.post("/api/runner/:action", (req, res) => {
    if (!(req as Request & { isAdmin?: boolean }).isAdmin) return void res.status(403).json({ error: "admin only" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    void (async () => {
      try {
        const action = String(req.params.action);
        let out: unknown = { ok: true };
        if (action === "pair") out = { link: ctx.team.pairRunnerLink() };
        else if (action === "join") {
          out = await ctx.team.joinAsRunner(String(b.link ?? ""), {
            ...(b.github ? { github: String(b.github) } : {}),
            ...(b.secret ? { secret: String(b.secret) } : {}),
            ...(b.token ? { token: String(b.token) } : {}),
            ...(b.shared !== undefined ? { shared: Boolean(b.shared) } : {}),
          });
        } else if (action === "start") out = await ctx.team.startRunner({ ...(b.shared !== undefined ? { shared: Boolean(b.shared) } : {}), ...(b.capacity ? { capacity: Number(b.capacity) } : {}) });
        else if (action === "stop") await ctx.team.stopRunner();
        else if (action === "revoke") await ctx.team.revokeRunner(String(b.deviceId ?? ""));
        else return void res.status(404).json({ error: `unknown runner action "${action}"` });
        res.json({ result: out });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    })();
  });
}
