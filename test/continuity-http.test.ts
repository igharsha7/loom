import path from "node:path";
import type { Express, Request, Response } from "express";
import { afterEach, expect, it } from "vitest";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { registerBrainRoutes } from "../src/daemon/routes/brain.js";
import { registerMessagesRoutes } from "../src/daemon/routes/messages.js";
import { makeProjectDir } from "./helpers.js";
import { ContextArtifacts } from "../src/core/continuity/artifacts.js";
import fs from "node:fs";

let runtime: ProjectRuntime | undefined;
afterEach(async () => { await runtime?.close(); runtime = undefined; });
async function routes() {
  const dir = makeProjectDir({ brain: { continuity: true, extractor: "off" }, agents: [{ id: "codex", kind: "codex" }] });
  runtime = await ProjectRuntime.open({ id: "project", name: "http", dir });
  const handlers = new Map<string, (req: Request, res: Response) => Promise<void>>(), order: string[] = [];
  const register = (method: string) => (route: string, handler: (req: Request, res: Response) => Promise<void>) => { order.push(route); handlers.set(`${method} ${route}`, handler); };
  const app = { get: register("GET"), post: register("POST"), patch: register("PATCH"), delete: register("DELETE") } as unknown as Express;
  registerBrainRoutes(app, handler => ((req: Request, res: Response) => handler(runtime!, req, res)));
  registerMessagesRoutes(app, handler => ((req: Request, res: Response) => handler(runtime!, req, res)));
  async function call(method: string, suffix: string, input: { body?: unknown; query?: object; params?: object } = {}) {
    const result = { status: 200, body: undefined as unknown };
    const res = { status(code: number) { result.status = code; return this; }, json(body: unknown) { result.body = body; return this; } } as Response;
    await handlers.get(suffix === "messages" ? "POST /api/projects/:id/messages" : `${method} /api/projects/:id/brain/continuity${suffix}`)!({ body: input.body,
      query: input.query ?? {}, params: { id: "project", ...input.params } } as Request, res);
    return result;
  }
  return { call, order, dir, brain: runtime.continuity! };
}
it("rejects coerced booleans and unknown submission keys before any native action", async () => {
  const { call, brain } = await routes();
  expect((await call("POST", "messages", { body: { text: "work", plan: "false", requestId: "bad" } })).status).toBe(400);
  expect((await call("POST", "messages", { body: { text: "work", requestId: "bad", unknown: true } })).status).toBe(400);
  expect(brain.store.request("bad")).toBeUndefined();
});
it("registers concrete routes before memory IDs and scopes original source reads", async () => {
  const { call, order, brain } = await routes();
  brain.capture({ id: "original", conversationId: "main", agentInstanceId: "codex", text: "small user decision", source: "user", model: null, plan: false, targetAddedTokens: 6000 });
  expect(order.indexOf("/api/projects/:id/brain/continuity")).toBeLessThan(order.indexOf("/api/projects/:id/brain/:mid"));
  expect((await call("GET", "/source/:eventId", { params: { eventId: "1" }, query: { chat: "main" } })).body).toMatchObject({ text: "small user decision" });
  expect((await call("GET", "/source/:eventId", { params: { eventId: "1" }, query: { chat: "private" } })).status).toBe(400);
  expect((await call("GET", "/source/:eventId", { params: { eventId: "1; DROP TABLE events" }, query: { chat: "main" } })).status).toBe(400);
});
it("diagnostics return summaries and packet text is loaded one packet at a time", async () => {
  const { call, brain, dir } = await routes();
  const { request } = brain.capture({ id: "request", conversationId: "main", agentInstanceId: "codex", text: "continue", source: "user", model: null, plan: false, targetAddedTokens: 6000 });
  const prepared = await brain.prepare(request, "codex", dir, {});
  const summary = await call("GET", "", { query: { requestId: request.id } });
  expect(summary.body).toMatchObject({ enabled: true, helpers: "disabled", receipts: [{ packet: { counts: { exactMessages: 0 } } }] });
  expect(JSON.stringify(summary.body)).not.toContain("<loom-context");
  const packet = await call("GET", "/packets/:packetId", { params: { packetId: prepared.packet.id } });
  expect(packet.body).toMatchObject({ rendered: { hash: prepared.rendered.hash, text: prepared.rendered.text } });
  expect((await call("GET", "/packets/:packetId", { params: { packetId: "missing" } })).status).toBe(404);
});
it("invalid checkpoint review and unsafe receipt replay are explicit HTTP errors", async () => {
  const { call, brain, dir } = await routes();
  expect((await call("POST", "/checkpoint", { body: { chat: "main", itemId: "x", eventIds: [1], reviewed: false } })).status).toBe(400);
  const { request } = brain.capture({ id: "request", conversationId: "main", agentInstanceId: "codex", text: "modify files", source: "user", model: null, plan: false, targetAddedTokens: 6000 });
  const prepared = await brain.prepare(request, "codex", dir, {}); const turn = await brain.submit(prepared); brain.settled(turn.runId);
  expect((await call("POST", "/requests/:requestId/resume", { params: { requestId: request.id }, body: { targetAddedTokens: 12000 } })).status).toBe(409);
  expect((await call("POST", "/reconcile", { body: { receiptId: prepared.receipt.id, evidence: "checked", quiescent: false } })).status).toBe(400);
  expect((await call("POST", "/reconcile", { body: { receiptId: prepared.receipt.id, evidence: "Native process terminated; checked workspace", quiescent: true } })).status).toBe(200);
});
it("finalizes hash-addressed source artifacts and rejects corruption, symlinks and traversal", async () => {
  const { dir } = await routes(), artifacts = new ContextArtifacts(dir);
  const ref = artifacts.put(JSON.stringify({ original: "tiny preference 😀" }));
  expect(artifacts.read(ref.hash)).toContain("tiny preference 😀");
  expect(artifacts.put(JSON.stringify({ original: "tiny preference 😀" }))).toEqual(ref);
  expect(() => artifacts.read("../../state.json")).toThrow(/hash/);
  fs.chmodSync(path.join(dir, ref.relativePath), 0o600);
  fs.writeFileSync(path.join(dir, ref.relativePath), "corrupted"); expect(() => artifacts.read(ref.hash)).toThrow(/integrity/);
  fs.unlinkSync(path.join(dir, ref.relativePath)); fs.symlinkSync(path.join(dir, ".loom", "config.json"), path.join(dir, ref.relativePath));
  expect(() => artifacts.read(ref.hash)).toThrow(/unsafe/);
});

it("bounds diagnostics inputs and exposes explicit index rebuild", async () => {
  const { call } = await routes();
  expect((await call("GET", "", { query: { requestId: "x".repeat(257) } })).status).toBe(400);
  expect((await call("POST", "/search/rebuild", { body: {} })).body).toMatchObject({ rebuilt: true });
  expect((await call("POST", "/search/rebuild", { body: { unknown: true } })).status).toBe(400);
});
