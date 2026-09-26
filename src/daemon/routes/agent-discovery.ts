import type { Express } from 'express';
import { ADES, detectAdes } from "../../core/ades.js";
import type { WithRuntime } from './context.js';
/** Register agent-discovery routes in the order established by LoomDaemon.routes(). */
export function registerAgentDiscoveryRoutes(app: Express, withRuntime: WithRuntime): void {

  // Which agents Loom can drive on this machine, and which are already in
  // this project. The UI needs both to offer you the difference.
  app.get(
    "/api/projects/:id/agents/available",
    withRuntime(async (rt, _req, res) => {
      const availability = await detectAdes();
      const counts = rt.instanceCounts();
      res.json({
        ades: ADES.map((a) => ({
          kind: a.kind,
          label: a.label,
          tier: a.tier,
          // Bridges are never "installed" — they're an app you launch with a
          // debug port, so presence is a live question, not a lookup.
          installed: a.tier === "adapter" ? Boolean(availability[a.kind]) : null,
          inProject: (counts[a.kind] ?? 0) > 0,
          // How many sessions of this kind are already here. `inProject` used
          // to be the whole answer and the rail hid anything already present,
          // which made a second Claude Code session unreachable from the UI
          // even though the roster could hold one. Adapters can be added
          // again; bridges are read-mostly and one is enough.
          instances: counts[a.kind] ?? 0,
          canAddAnother: a.tier === "adapter",
        })),
      });
    }),
  );
}
