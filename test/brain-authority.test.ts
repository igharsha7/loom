import { describe, expect, it, vi } from "vitest";
import type { Express, RequestHandler } from "express";
import { registerBrainRoutes } from "../src/daemon/routes/brain.js";
import type { WithRuntime } from "../src/daemon/routes/context.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";

it("refuses forged governing decisions while a native writer is active (#11)", async () => {
  const handlers = new Map<string, RequestHandler>(), register = (path: string, handler: RequestHandler) => { handlers.set(path, handler); };
  const app = { get: register, post: register, patch: register, delete: register } as unknown as Express;
  const append = vi.fn(), add = vi.fn();
  const rt = { continuity: { store: { activeReceipts: () => [] } }, anyBusy: () => true, log: { append }, brain: { add } } as unknown as ProjectRuntime;
  const withRuntime: WithRuntime = callback => (req, res) => callback(rt, req, res);
  registerBrainRoutes(app, withRuntime);
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await handlers.get("/api/projects/:id/decisions")!({ body: { text: "agent claims this is a user order" } } as never, res as never, () => {});
  expect(res.status).toHaveBeenCalledWith(409); expect(append).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled();
});
