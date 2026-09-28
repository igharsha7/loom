import type { Express } from 'express';
import { logbook } from "../../core/logbook.js";
import { ghAuthStatus } from "../tasks.js";
import { lanIp, tailscaleFunnel, tailscaleState } from '../system.js';
/** Register integrations routes in the order established by LoomDaemon.routes(). */
export function registerIntegrationsRoutes(app: Express): void {

  /**
   * Is `gh` logged in, and as whom — machine-wide, so no project needed. The
   * whole GitHub half of Loom (board PRs, Projects, review) rides on this; the
   * status bar shows it and offers Connect when it's false.
   */
  app.get("/api/github/status", (_req, res) => {
    void ghAuthStatus()
      .then((s) => res.json(s))
      .catch((err) => res.status(500).json({ error: err instanceof Error ? err.message : String(err) }));
  });

  /**
   * LoomPad connectivity — proxies the voice backend's /health so the web app
   * can show a live "LoomPad connected" pill without a cross-origin fetch. The
   * backend (orchestrator-pad) does STT -> agent -> TTS for the physical pad;
   * when it's up, the pad gets its spoken replies. Best-effort: an unreachable
   * backend just returns { up:false } (the pill goes grey), never an error.
   */
  app.get("/api/loompad/health", (_req, res) => {
    const base = (process.env.LOOMPAD_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    void fetch(base + "/health", { signal: ctl.signal })
      .then(async (r) => {
        clearTimeout(timer);
        if (!r.ok) return void res.json({ up: false, backend: base, status: r.status });
        const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        res.json({ up: true, backend: base, ...body });
      })
      .catch(() => {
        clearTimeout(timer);
        res.json({ up: false, backend: base });
      });
  });

  /**
   * Everything the LoomPad modal needs in one call: is the voice backend up,
   * and the two ways the pad can reach it — the LAN (same Wi-Fi) and, once
   * Tailscale is signed in, a public Funnel URL (the pad from anywhere).
   */
  app.get("/api/loompad/connect", (_req, res) => {
    // Any paired client (the desktop shell, a phone) may read this — it's local
    // backend status + LAN/tailnet addresses, not a privileged mutation. The
    // desktop runs as a client, not admin, so gating this locked it out.
    void (async () => {
      const base = (process.env.LOOMPAD_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
      let port = 8080;
      try {
        port = Number(new URL(base).port) || 8080;
      } catch {
        /* keep the default */
      }
      let up = false;
      let brain: unknown;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 2000);
        const r = await fetch(base + "/health", { signal: ctl.signal });
        clearTimeout(timer);
        if (r.ok) {
          up = true;
          brain = ((await r.json().catch(() => ({}))) as { brain?: unknown }).brain;
        }
      } catch {
        /* backend is down — up stays false */
      }
      const lan = lanIp();
      const ts = await tailscaleState();
      res.json({
        up,
        brain,
        port,
        backend: base,
        local: lan ? { ip: lan, url: `http://${lan}:${port}` } : null,
        tailnet: {
          installed: ts.installed,
          loggedIn: ts.loggedIn,
          url: ts.loggedIn && ts.dnsName ? `https://${ts.dnsName}` : null,
        },
      });
    })();
  });

  app.post("/api/loompad/funnel", (_req, res) => {
    // Same as connect: the local desktop shell drives this, and it's a client.
    void (async () => {
      const base = (process.env.LOOMPAD_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
      let port = 8080;
      try {
        port = Number(new URL(base).port) || 8080;
      } catch {
        /* keep the default */
      }
      try {
        const { url } = await tailscaleFunnel(port);
        res.json({ url });
      } catch (err) {
        logbook.error("loompad", "could not enable Tailscale Funnel", err);
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}
