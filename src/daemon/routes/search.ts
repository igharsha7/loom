import type { Express } from 'express';
import { searchChats, searchCode } from "../../core/search.js";
import type { WithRuntime } from './context.js';
/** Register search routes in the order established by LoomDaemon.routes(). */
export function registerSearchRoutes(app: Express, withRuntime: WithRuntime): void {

  // ---- search -----------------------------------------------------------
  // Finding a file by name was the whole of search, which is its least useful
  // half: you remember a line, not a filename. And the thread — where a
  // project's actual reasoning lives — wasn't searchable at all.
  app.get(
    "/api/projects/:id/grep",
    withRuntime(async (rt, req, res) => {
      res.json(await searchCode(rt.info.dir, String(req.query.q ?? "")));
    }),
  );

  app.get(
    "/api/projects/:id/chats/search",
    withRuntime(async (rt, req, res) => {
      res.json(
        searchChats(rt.log, String(req.query.q ?? ""), {
          ...(req.query.chat ? { chat: String(req.query.chat) } : {}),
        }),
      );
    }),
  );
}
