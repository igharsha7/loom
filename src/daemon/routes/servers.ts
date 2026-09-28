import type { Express } from 'express';
import { writeProjectConfig } from "../../core/registry.js";
import { suggestServers, urlFor } from "../../core/servers.js";
import { parseServerConfig } from '../system.js';
import type { WithRuntime } from './context.js';
/** Register servers routes in the order established by LoomDaemon.routes(). */
export function registerServersRoutes(app: Express, withRuntime: WithRuntime): void {

  /**
   * The project's dev servers: what's configured, and what each one is doing.
   *
   * "Running" means a port answered, not that a process exists — the
   * difference is the whole point of Loom knowing about them (core/servers.ts).
   */
  app.get(
    "/api/projects/:id/servers",
    withRuntime(async (rt, _req, res) => {
      res.json({ servers: rt.servers.list(), suggested: suggestServers(rt.info.dir) });
    }),
  );

  app.post(
    "/api/projects/:id/servers",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as { servers?: unknown };
      if (!Array.isArray(b.servers)) return void res.status(400).json({ error: "servers must be a list" });
      try {
        const servers = b.servers.map(parseServerConfig);
        writeProjectConfig(rt.info.dir, { ...rt.config, servers });
        rt.config.servers = servers;
        res.json({ servers: rt.servers.list() });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  for (const action of ["start", "stop", "restart"] as const) {
    app.post(
      `/api/projects/:id/servers/:name/${action}`,
      withRuntime(async (rt, req, res) => {
        try {
          const status = await rt.servers[action](String(req.params.name));
          res.json({ server: status });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
  }

  /**
   * Preview a server through Loom, so the page can report back.
   *
   * A dev server is a different origin, and one origin can't read another's
   * console. Loom stands in front of it instead (core/preview-proxy.ts) and
   * injects a script that posts what the page logs, fetches and throws. Each
   * server gets one proxy, started when first asked for.
   */
  app.post(
    "/api/projects/:id/servers/:name/preview",
    withRuntime(async (rt, req, res) => {
      try {
        const cfg = rt.servers.mustConfig(String(req.params.name));
        const target = urlFor(cfg);
        if (!target) return void res.status(400).json({ error: `server "${cfg.name}" has no port or url to preview` });
        const proxy = await rt.previewProxy(cfg.name, target);
        res.json({ url: `http://127.0.0.1:${proxy.port}`, target, bridged: true });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  /** A server's recent output — the log pane, and what an agent reads. */
  app.get(
    "/api/projects/:id/servers/:name/log",
    withRuntime(async (rt, req, res) => {
      try {
        rt.servers.mustConfig(String(req.params.name));
        const limit = req.query.limit ? Math.max(1, Number(req.query.limit)) : 200;
        res.json({ lines: rt.servers.log(String(req.params.name), limit) });
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
}
