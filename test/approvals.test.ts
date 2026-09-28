/**
 * "Always ask", end to end minus the model: an adapter asks the daemon
 * (core/approvals.ts `requestApproval`, the same call the Claude adapter's
 * canUseTool and the Codex adapter's app-server approvals make), the request
 * shows up in the project as an `approval` event and in GET /approvals, a
 * human answers over REST, and the answer comes back to the adapter.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requestApproval } from "../src/core/approvals.js";
import { permissionFor, permissionMenu } from "../src/core/permissions.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let base: string;
let token: string;
let projectId: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-approvals");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { port } = await daemon.listen();
  base = `http://127.0.0.1:${port}`;
  const cfg = readDaemonConfig()!;
  token = cfg.adminToken;
  projectId = (await new DaemonClient(cfg).addProject(makeProjectDir({ name: "asky" }))).project.id;
});

afterAll(async () => {
  await daemon.close();
});

const api = (p: string, init: RequestInit = {}) =>
  fetch(base + p, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

/** The one pending approval's id, once it appears. */
async function pendingId(): Promise<string> {
  let id = "";
  await waitUntil(async () => {
    const list = (await api(`/api/projects/${projectId}/approvals`)).body.approvals as Array<{ id: string }>;
    id = list[0]?.id ?? "";
    return Boolean(id);
  });
  return id;
}

describe("permission modes", () => {
  it("defaults each agent to today's behaviour and offers three modes", () => {
    expect(permissionFor("claude-code")).toBe("auto");
    expect(permissionFor("antigravity-cli")).toBe("bypass");
    expect(permissionFor("codex", { permissions: "ask" })).toBe("ask");
    expect(permissionFor("codex", { permissions: "nonsense" })).toBe("auto");
    expect(permissionMenu("claude-code")!.map((m) => m.mode)).toEqual(["bypass", "auto", "ask"]);
    expect(permissionMenu("claude-code")![2]!.ask).toBe("approvals");
    expect(permissionMenu("codex")![2]!.ask).toBe("approvals");
    expect(permissionMenu("echo")).toBeNull();
    // measured-broken cells are marked, and never selected
    expect(permissionMenu("opencode")![2]!.unsupported).toBeTruthy();
    expect(permissionMenu("antigravity-cli")![1]!.unsupported).toBeTruthy();
    expect(permissionFor("opencode", { permissions: "ask" })).toBe("auto");
  });

  it("sets an agent's mode, persists it, and shows it in status", async () => {
    const r = await api(`/api/projects/${projectId}/agents/execbot/permissions`, {
      method: "POST",
      body: JSON.stringify({ permissions: "ask" }),
    });
    expect(r.status).toBe(200);
    const bad = await api(`/api/projects/${projectId}/agents/execbot/permissions`, {
      method: "POST",
      body: JSON.stringify({ permissions: "yolo" }),
    });
    expect(bad.status).toBe(400);
    const st = await api(`/api/projects/${projectId}`);
    const agents = (st.body.project as { agents: Array<{ id: string; permissions: string }> }).agents;
    expect(agents.find((a) => a.id === "execbot")!.permissions).toBe("ask");
    const profiles = await api("/api/permissions");
    expect(Object.keys(profiles.body.profiles as object)).toContain("antigravity-cli");
  });
});

describe("approvals from inside the daemon", () => {
  it("a request waits for a human, and allow flows back to the agent", async () => {
    const pending = requestApproval({ project: projectId, agent: "plannerbot", tool: "Bash", input: { command: "npm test" }, summary: "Bash: npm test" });
    let approvalId = "";
    await waitUntil(async () => {
      const r = await api(`/api/projects/${projectId}/approvals`);
      const list = r.body.approvals as Array<{ id: string; tool: string; agent: string }>;
      if (list[0]) approvalId = list[0].id;
      return list.length === 1 && list[0]!.tool === "Bash" && list[0]!.agent === "plannerbot";
    });
    const ev = await api(`/api/projects/${projectId}/events?limit=50`);
    const requested = (ev.body.events as Array<{ kind: string; payload: { phase: string; input: string } }>).find(
      (e) => e.kind === "approval" && e.payload.phase === "requested",
    );
    expect(requested!.payload.input).toBe("Bash: npm test");

    expect((await api(`/api/projects/${projectId}/approvals/${approvalId}`, { method: "POST", body: JSON.stringify({ decision: "allow" }) })).status).toBe(200);
    expect(await pending).toEqual({ behavior: "allow" });
    // answered once is answered
    expect((await api(`/api/projects/${projectId}/approvals/${approvalId}`, { method: "POST", body: JSON.stringify({ decision: "deny" }) })).status).toBe(404);
  });

  it("deny carries the human's reason back", async () => {
    const pending = requestApproval({ project: projectId, agent: "plannerbot", tool: "Write", input: { file_path: "x" } });
    const id = await pendingId();
    await api(`/api/projects/${projectId}/approvals/${id}`, { method: "POST", body: JSON.stringify({ decision: "deny", message: "not that file" }) });
    expect(await pending).toEqual({ behavior: "deny", message: "not that file" });
  });

  it("a turn that ends closes its open cards as denied", async () => {
    const stop = new AbortController();
    const pending = requestApproval({ project: projectId, agent: "plannerbot", tool: "Bash", input: {}, signal: stop.signal });
    await pendingId();
    stop.abort();
    expect(await pending).toMatchObject({ behavior: "deny", message: "The agent stopped waiting." });
    expect(((await api(`/api/projects/${projectId}/approvals`)).body.approvals as unknown[])).toHaveLength(0);
    // an already-ended turn never opens one
    expect(await requestApproval({ project: projectId, agent: "plannerbot", tool: "Bash", input: {}, signal: stop.signal })).toMatchObject({ behavior: "deny" });
    expect(((await api(`/api/projects/${projectId}/approvals`)).body.approvals as unknown[])).toHaveLength(0);
  });

  it("no longer serves the old MCP approval endpoint", async () => {
    const r = await fetch(`${base}/api/approvals/request`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-loom-approval": "anything" },
      body: JSON.stringify({ project: projectId, tool: "Bash", input: {} }),
    });
    expect(r.status).not.toBe(200);
    expect(r.status).not.toBe(403);
  });
});
