import type { Express } from 'express';
import { type Request } from "express";
import { readCloudSettings, writeCloudSettings } from "../relay.js";
import type { RouteContext } from './context.js';
/** Register cloud routes in the order established by LoomDaemon.routes(). */
export function registerCloudRoutes(app: Express, ctx: Pick<RouteContext, "cloudStatus" | "startCloud" | "stopCloud">): void {

  // ---- Loom Cloud: reach this daemon from any network (daemon/relay.ts) ----
  app.get("/api/cloud", (_req, res) => {
    res.json(ctx.cloudStatus());
  });

  app.post("/api/cloud/:action", (req, res) => {
    if (!(req as Request & { isAdmin?: boolean }).isAdmin) {
      return void res.status(403).json({ error: "admin only" });
    }
    const action = String(req.params.action);
    void (async () => {
      try {
        if (action === "enable") {
          const b = (req.body ?? {}) as { supabaseUrl?: string; anonKey?: string };
          if (b.supabaseUrl || b.anonKey) {
            const s = readCloudSettings();
            if (b.supabaseUrl) s.supabaseUrl = String(b.supabaseUrl).trim();
            if (b.anonKey) s.anonKey = String(b.anonKey).trim();
            writeCloudSettings(s);
          }
          await ctx.startCloud();
        } else if (action === "disable") await ctx.stopCloud();
        else if (action === "rotate") {
          // New channel + key: every phone paired through the cloud must re-pair.
          const was = readCloudSettings().enabled;
          await ctx.stopCloud({ rotate: true });
          if (was) await ctx.startCloud();
        } else return void res.status(404).json({ error: `unknown action "${action}"` });
        res.json(ctx.cloudStatus());
      } catch (err) {
        res.status(400).json({ ...ctx.cloudStatus(), error: (err as Error).message });
      }
    })();
  });
}
