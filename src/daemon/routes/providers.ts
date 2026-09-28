import type { Express } from 'express';
import { allModels, fetchModels, forgetProvider, listProviders, resolveProvider, setProvider } from "../../core/providers.js";
/** Register providers routes in the order established by LoomDaemon.routes(). */
export function registerProvidersRoutes(app: Express): void {

  /**
   * Is this Loom current? Version + build rev, and — when Loom itself is a git
   * checkout — how many commits its own tree is behind its remote. Honest about
   * the two different "updates" that matter: a newer daemon build waiting to be
   * restarted (rev), and newer code waiting to be pulled (behind).
   */
  /**
   * Providers: where a model agent's turns go.
   *
   * Machine-wide, not per-project, because a key is a property of this
   * machine. Nothing here returns a key — `hint` is the last four
   * characters, which tells two keys apart and uses neither.
   */
  app.get("/api/providers", (_req, res) => {
    res.json({ providers: listProviders() });
  });

  app.post("/api/providers/:id", (req, res) => {
    const body = (req.body ?? {}) as {
      key?: string;
      baseUrl?: string;
      label?: string;
      headers?: Record<string, string>;
    };
    try {
      setProvider(String(req.params.id), {
        ...(typeof body.key === "string" ? { key: body.key } : {}),
        ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
        ...(typeof body.label === "string" ? { label: body.label } : {}),
        ...(body.headers ? { headers: body.headers } : {}),
      });
    } catch (err) {
      return void res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
    res.json({ providers: listProviders() });
  });

  app.delete("/api/providers/:id", (req, res) => {
    const forgotten = forgetProvider(String(req.params.id));
    res.json({ forgotten, providers: listProviders() });
  });

  /** What every configured provider can run right now. */
  app.get("/api/models", (req, res) => {
    void (async () => {
      const q = req.query as Record<string, string | undefined>;
      const refresh = q.refresh === "1";
      if (q.provider) {
        const p = resolveProvider(q.provider);
        if (!p) return void res.status(404).json({ error: `no provider "${q.provider}"` });
        const got = await fetchModels(p, refresh ? { refresh: true } : {});
        return void res.json({
          models: got.models,
          cached: got.cached,
          errors: got.error ? [{ provider: p.id, error: got.error }] : [],
        });
      }
      const got = await allModels(refresh ? { refresh: true } : {});
      res.json({ models: got.models, errors: got.errors });
    })();
  });
}
