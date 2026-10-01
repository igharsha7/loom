import type { Express, Request, Response } from "express";
import { expect, it, vi } from "vitest";
import { registerHistoryRoutes } from "../src/daemon/routes/history.js";
import type { WithRuntime } from "../src/daemon/routes/context.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";

it("passes the literal rewind-file path through the HTTP handler (finding #11)", async () => {
  type Handler = Parameters<WithRuntime>[0];
  const handlers = new Map<string, Handler>();
  const register = (route: string, handler: Handler) => handlers.set(route, handler);
  const app = { get: register, post: register, put: register, delete: register } as unknown as Express;
  registerHistoryRoutes(app, (handler => handler) as unknown as WithRuntime);
  const rewindFile = vi.fn().mockResolvedValue({ path: " report.txt" });
  const rt = { rewindFile } as unknown as ProjectRuntime;
  const json = vi.fn(), status = vi.fn();
  const res = { json, status } as unknown as Response;
  status.mockReturnValue(res);
  await handlers.get("/api/projects/:id/checkpoints/:cpId/rewind-file")!(rt,
    { body: { path: " report.txt" }, params: { cpId: "c123" } } as unknown as Request, res);
  expect(rewindFile).toHaveBeenCalledExactlyOnceWith("c123", " report.txt");
  expect(status).not.toHaveBeenCalled(); expect(json).toHaveBeenCalledWith({ path: " report.txt" });
});

it("returns successful files-only recovery through HTTP without advertising restored files", async () => {
  type Handler = Parameters<WithRuntime>[0];
  const handlers = new Map<string, Handler>();
  const register = (route: string, handler: Handler) => handlers.set(route, handler);
  registerHistoryRoutes({ get: register, post: register, put: register, delete: register } as unknown as Express,
    (handler => handler) as unknown as WithRuntime);
  const result = { recoveryReleased: true, message: "rewind recovery released; the original checkout no longer exists, so no files were restored", changed: [], conversation: [] };
  const rewind = vi.fn().mockResolvedValue(result), json = vi.fn(), status = vi.fn();
  const res = { json, status } as unknown as Response; status.mockReturnValue(res);
  await handlers.get("/api/projects/:id/checkpoints/:cpId/rewind")!({ rewind } as unknown as ProjectRuntime,
    { body: { conversation: false }, params: { cpId: "c123" } } as unknown as Request, res);
  expect(rewind).toHaveBeenCalledExactlyOnceWith("c123", { conversation: false });
  expect(status).not.toHaveBeenCalled(); expect(json).toHaveBeenCalledExactlyOnceWith(result);
});
