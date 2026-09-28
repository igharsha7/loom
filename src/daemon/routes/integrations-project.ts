import type { Express } from 'express';
import { type Request, type Response } from "express";
import { addWorktree as gitAddWorktree, listWorktrees as gitListWorktrees, removeWorktree as gitRemoveWorktree } from "../../core/git.js";
import { findProject } from "../../core/registry.js";
import { linearCreateIssue, linearTeams, listLinearIssues } from "../linear.js";
import { ghProjectItems, ghProjects, prReview, prView, runGh, type PrReviewAction } from "../tasks.js";
/** Register integrations-project routes in the order established by LoomDaemon.routes(). */
export function registerIntegrationsProjectRoutes(app: Express): void {

  // Small async wrapper: resolve the project or 404, run the handler, and turn
  // any throw into a 500 with its message. The GitHub/Linear/worktree reads
  // below all share this shape.
  const projectRoute =
    (fn: (dir: string, req: Request, res: Response) => Promise<void>) =>
      (req: Request, res: Response) => {
        const info = findProject(String(req.params.id));
        if (!info) return void res.status(404).json({ error: "unknown project" });
        void fn(info.dir, req, res).catch((err: unknown) =>
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) }),
        );
      };

  // ---- GitHub Projects (v2) — the owner's boards, browsed in-app ----------
  app.get(
    "/api/projects/:id/gh/projects",
    projectRoute(async (dir, _req, res) => {
      res.json(await ghProjects(dir));
    }),
  );

  app.get(
    "/api/projects/:id/gh/projects/:num/items",
    projectRoute(async (dir, req, res) => {
      res.json(await ghProjectItems(dir, Number(req.params.num)));
    }),
  );

  // ---- Pull-request review — diff + approve / request-changes / comment ----
  app.get(
    "/api/projects/:id/prs/:num",
    projectRoute(async (dir, req, res) => {
      res.json(await prView(dir, Number(req.params.num)));
    }),
  );

  app.post(
    "/api/projects/:id/prs/:num/review",
    projectRoute(async (dir, req, res) => {
      const { action, body } = (req.body ?? {}) as { action?: string; body?: string };
      const allowed: PrReviewAction[] = ["approve", "request-changes", "comment"];
      if (!allowed.includes(action as PrReviewAction)) {
        return void res.status(400).json({ error: "action must be approve, request-changes, or comment" });
      }
      const result = await prReview(dir, Number(req.params.num), action as PrReviewAction, body ?? "");
      if ("available" in result) return void res.status(400).json({ error: result.detail });
      res.json(result);
    }),
  );

  // ---- Worktrees — open a checked-out branch from any task ----------------
  app.get(
    "/api/projects/:id/worktrees",
    projectRoute(async (dir, _req, res) => {
      res.json({ worktrees: await gitListWorktrees(dir) });
    }),
  );

  app.post(
    "/api/projects/:id/worktrees",
    projectRoute(async (dir, req, res) => {
      const b = (req.body ?? {}) as {
        pr?: number;
        issue?: number;
        branch?: string;
        newBranch?: string;
        base?: string;
      };
      if (b.pr) {
        const n = Number(b.pr);
        const wt = await gitAddWorktree(dir, { slug: "pr-" + n, detached: true });
        try {
          // gh handles fork PRs (adds the remote, fetches, makes the branch)
          await runGh(["pr", "checkout", String(n)], wt.path);
        } catch (err) {
          // don't strand an empty detached worktree if the checkout fails
          await gitRemoveWorktree(dir, wt.path, true).catch(() => { });
          throw err;
        }
        return void res.json({ path: wt.path, source: `PR #${n}` });
      }
      if (b.newBranch) {
        const wt = await gitAddWorktree(dir, {
          slug: b.newBranch,
          newBranch: String(b.newBranch),
          ...(b.base ? { base: String(b.base) } : {}),
        });
        return void res.json({ path: wt.path, branch: wt.branch });
      }
      if (b.branch) {
        const wt = await gitAddWorktree(dir, { slug: String(b.branch), branch: String(b.branch) });
        return void res.json({ path: wt.path, branch: wt.branch });
      }
      if (b.issue) {
        const slug = "issue-" + Number(b.issue);
        const wt = await gitAddWorktree(dir, { slug, newBranch: slug });
        return void res.json({ path: wt.path, branch: wt.branch, source: `issue #${Number(b.issue)}` });
      }
      res.status(400).json({ error: "say which: pr, issue, branch, or newBranch" });
    }),
  );

  app.delete(
    "/api/projects/:id/worktrees",
    projectRoute(async (dir, req, res) => {
      const wtPath = String((req.body ?? {}).path ?? req.query.path ?? "");
      if (!wtPath) return void res.status(400).json({ error: "which worktree? pass its path" });
      await gitRemoveWorktree(dir, wtPath, Boolean((req.body ?? {}).force));
      res.json({ removed: wtPath });
    }),
  );

  // ---- Linear — teams + create issue, through the user's own key ----------
  app.get(
    "/api/projects/:id/linear/teams",
    projectRoute(async (_dir, _req, res) => {
      res.json(await linearTeams());
    }),
  );

  app.get(
    "/api/projects/:id/linear/issues",
    projectRoute(async (_dir, req, res) => {
      res.json(await listLinearIssues(req.query.team ? String(req.query.team) : undefined));
    }),
  );

  app.post(
    "/api/projects/:id/linear/issues",
    projectRoute(async (_dir, req, res) => {
      const { teamId, title, description } = (req.body ?? {}) as {
        teamId?: string;
        title?: string;
        description?: string;
      };
      const result = await linearCreateIssue({
        teamId: teamId ?? "",
        title: title ?? "",
        ...(description ? { description } : {}),
      });
      if (result.available) return void res.json(result);
      res.status(400).json({ error: result.detail });
    }),
  );
}
