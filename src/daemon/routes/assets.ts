import type { Express } from 'express';
import fs from "node:fs";
import { createRequire } from "node:module";
import { APP_HTML, APP_MANIFEST } from "../app-page.js";
import { GEIST_WOFF2 } from "../geist-font.js";
import { BUILD_REV } from '../system.js';
/** Register assets routes in the order established by LoomDaemon.routes(). */
export function registerAssetsRoutes(app: Express): void {

  // Public: the phone app shell (its API calls are bearer-authed),
  // health, and the pairing claim (the pairing token IS the auth).
  app.get("/", (_req, res) => res.redirect("/app"));

  app.get("/app", (_req, res) => {
    // The telemetry backend's own UI, for the Observatory's trace deep links.
    // Stripped of quote/angle characters because it lands inside a JS string
    // literal in the shell. Empty when unset, and the page hides the links
    // rather than pointing them at a guessed port.
    const traceUi = (process.env.LOOM_TRACE_UI_URL || "").replace(/["'<>]/g, "");
    // Never cache the shell: a redeployed daemon must serve its own UI.
    res
      .type("html")
      .setHeader("Cache-Control", "no-store")
      .send(APP_HTML.replace("%%TRACE_UI_URL%%", traceUi).replace("%%BUILD_REV%%", BUILD_REV));
  });

  app.get("/app/manifest.webmanifest", (_req, res) => {
    res
      .type("application/manifest+json")
      .setHeader("Cache-Control", "no-store")
      .send(JSON.stringify(APP_MANIFEST));
  });

  // The UI sans (Geist, SIL OFL 1.1) — embedded so the app works offline
  // on the tailnet with no CDN. Immutable: cache hard.
  app.get("/app/fonts/geist.woff2", (_req, res) => {
    res
      .type("font/woff2")
      .setHeader("Cache-Control", "public, max-age=31536000, immutable")
      .send(GEIST_WOFF2);
  });

  // xterm.js and its addons, served straight from node_modules — the app has
  // no build step and must work offline on a tailnet, so no bundler, no CDN.
  // These are plain UMD files the browser loads with <script>.
  const vendor: Record<string, [string, string]> = {
    "xterm.js": ["@xterm/xterm/lib/xterm.js", "application/javascript"],
    "xterm.css": ["@xterm/xterm/css/xterm.css", "text/css"],
    "addon-fit.js": ["@xterm/addon-fit/lib/addon-fit.js", "application/javascript"],
    "addon-web-links.js": [
      "@xterm/addon-web-links/lib/addon-web-links.js",
      "application/javascript",
    ],
  };

  app.get("/app/vendor/:file", (req, res) => {
    const entry = vendor[String(req.params.file)];
    if (!entry) return void res.status(404).end();
    try {
      res
        .type(entry[1])
        .setHeader("Cache-Control", "public, max-age=31536000, immutable")
        .send(fs.readFileSync(createRequire(import.meta.url).resolve(entry[0])));
    } catch {
      res.status(404).end();
    }
  });
}
