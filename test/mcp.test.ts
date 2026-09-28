/**
 * MCP servers, end to end: what gets into the generated config, what the CLIs
 * are actually told, and whether "connected" means anything.
 *
 * The claim under test is the one that was false before: a project's configured
 * MCP servers reach the agent. So the adapters are driven with fake binaries
 * that record their argv — the same instrument the adapter tests use — because
 * the question is what Loom PUTS on the command line, and a real CLI would
 * only answer it slowly and at a price.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { mcpKey, probeMcpServer, resolveMcpServers, writeMcpSession } from "../src/core/mcp.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { McpServerConfig, McpTurnConfig } from "../src/types.js";
import { makeProjectDir, waitUntil } from "./helpers.js";
import { callsOf, fakeClaude, fakeCodex, rpcOf } from "./native-fakes.js";

/** The MCP servers a fake claude was handed (the SDK passes them as `--mcp-config <json>`). */
const claudeMcpOf = (bin: string): Record<string, unknown> | null => {
  const argv = callsOf(bin).at(-1)!;
  const i = argv.indexOf("--mcp-config");
  return i < 0 ? null : (JSON.parse(argv[i + 1]!) as { mcpServers: Record<string, unknown> }).mcpServers;
};

const CONFIGURED: McpServerConfig[] = [
  { name: "SigNoz", url: "http://127.0.0.1:8080/mcp", description: "traces" },
  { name: "GitHub", url: "", description: "not connected yet" }, // a built-in suggestion row
  { name: "Slack", url: "https://slack.example/mcp", enabledForSession: false },
  { name: "Local Files", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
];

const sessions: Array<{ cleanup: () => void }> = [];
afterAll(() => sessions.forEach((s) => s.cleanup()));

describe("selecting servers", () => {
  it("takes the ones with somewhere to connect to, and leaves the placeholders out", () => {
    const names = resolveMcpServers(CONFIGURED).map((s) => s.name);
    expect(names).toContain("SigNoz");
    expect(names).toContain("Local Files"); // a command is a destination too
    // An empty url is the built-in suggestion row: a name and an icon, nothing
    // to talk to. Handing it to a CLI would advertise a tool that isn't there.
    expect(names).not.toContain("GitHub");
    // Switched off for the session is switched off.
    expect(names).not.toContain("Slack");
  });

  it("keys servers safely for a TOML dotted path", () => {
    expect(mcpKey("Local Files")).toBe("local_files");
    expect(mcpKey("My Server / prod")).toBe("my_server_prod");
    expect(mcpKey("!!!")).toBe("server");
  });

  it("reads an /sse endpoint as SSE and everything else as http", () => {
    const [http1, sse] = resolveMcpServers([
      { name: "a", url: "https://x.example/mcp" },
      { name: "b", url: "https://x.example/sse" },
    ]);
    expect(http1!.entry).toMatchObject({ type: "http" });
    expect(sse!.entry).toMatchObject({ type: "sse" });
  });
});

describe("the generated config file", () => {
  it("writes the standard {mcpServers} document with only the real servers in it", () => {
    const session = writeMcpSession(CONFIGURED)!;
    sessions.push(session);
    expect(session).not.toBeNull();
    const doc = JSON.parse(fs.readFileSync(session.configPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["local_files", "signoz"]);
    expect(doc.mcpServers.signoz).toEqual({ type: "http", url: "http://127.0.0.1:8080/mcp" });
    expect(doc.mcpServers.local_files).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    });
    expect(doc.mcpServers.github).toBeUndefined();
  });

  /**
   * null, not an empty document. With `--strict-mcp-config` an empty file would
   * SUPPRESS the servers the user configured in their own CLI, so "nothing to
   * add" has to be distinguishable from "add nothing".
   */
  it("returns null when nothing is configured", () => {
    expect(writeMcpSession([])).toBeNull();
    expect(writeMcpSession(undefined)).toBeNull();
    expect(writeMcpSession([{ name: "GitHub", url: "" }])).toBeNull();
  });

  it("cleans up after itself", () => {
    const session = writeMcpSession(CONFIGURED)!;
    expect(fs.existsSync(session.configPath)).toBe(true);
    session.cleanup();
    expect(fs.existsSync(session.configPath)).toBe(false);
    expect(() => session.cleanup()).not.toThrow(); // idempotent
  });
});

describe("what the adapters hand their harness", () => {
  const mcpFor = (mcps: McpServerConfig[]): McpTurnConfig => {
    const session = writeMcpSession(mcps)!;
    sessions.push(session);
    return { configPath: session.configPath, servers: session.servers };
  };

  it("claude-code passes the servers to the Agent SDK", async () => {
    const bin = fakeClaude();
    await new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "mcp" }), { bin }).send({ text: "go", mcp: mcpFor(CONFIGURED) });
    expect(claudeMcpOf(bin)).toEqual({
      signoz: { type: "http", url: "http://127.0.0.1:8080/mcp" },
      local_files: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    });
  });

  it("claude-code passes no MCP config when the project has none", async () => {
    const bin = fakeClaude();
    await new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "mcp" }), { bin }).send({ text: "go" });
    expect(claudeMcpOf(bin)).toBeNull();
  });

  it("codex puts the servers in the thread's config", async () => {
    const bin = fakeCodex();
    await new CodexAdapter("codex", makeProjectDir({ name: "mcp" }), { bin }).send({ text: "go", mcp: mcpFor(CONFIGURED) });
    expect(rpcOf(bin, "thread/start")[0]!.config).toEqual({
      "mcp_servers.signoz": { url: "http://127.0.0.1:8080/mcp" },
      "mcp_servers.local_files": { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    });
  });

  it("codex passes no MCP config when the project has none", async () => {
    const bin = fakeCodex();
    await new CodexAdapter("codex", makeProjectDir({ name: "mcp" }), { bin }).send({ text: "go" });
    expect(rpcOf(bin, "thread/start")[0]!.config).toBeUndefined();
  });
});

describe("through the runtime", () => {
  /**
   * The whole point: a server typed into the composer reaches the CLI. This
   * drives the real dispatch path — config → session → adapter → argv — with a
   * fake `claude` standing in for the one that costs money.
   */
  it("hands a configured server to an adapter whose CLI takes one", async () => {
    const bin = fakeClaude();
    const dir = makeProjectDir({
      name: "wired",
      agents: [{ id: "cc", kind: "claude-code", role: "builder", options: { bin } }],
      mcps: [{ name: "SigNoz", url: "http://127.0.0.1:8080/mcp" }],
    });
    const rt = await ProjectRuntime.open({ id: "wired", name: "wired", dir });
    try {
      await rt.sendMessage("go", "cc");
      await waitUntil(() => rt.log.list({ kinds: ["run_complete"] }).length > 0);
      expect(claudeMcpOf(bin)!.signoz).toEqual({ type: "http", url: "http://127.0.0.1:8080/mcp" });
      // …and it's announced in the thread, so "which servers did that turn get"
      // is answerable after the fact rather than a claim on a settings screen.
      const attached = rt.log.list({ kinds: ["status"] }).find((e) => e.payload.state === "mcp_attached");
      expect(attached!.payload.servers).toEqual(["SigNoz"]);
    } finally {
      await rt.close();
    }
  });

  /**
   * An adapter whose CLI has no MCP flag must not be told it got servers.
   * Announcing an attachment that the adapter drops on the floor is the same
   * lie in a new place.
   */
  it("says nothing about MCP for an adapter whose CLI has no flag for it", async () => {
    const dir = makeProjectDir({
      name: "unwired",
      agents: [{ id: "echobot", kind: "echo", role: "builder" }],
      mcps: [{ name: "SigNoz", url: "http://127.0.0.1:8080/mcp" }],
    });
    const rt = await ProjectRuntime.open({ id: "unwired", name: "unwired", dir });
    try {
      await rt.sendMessage("go", "echobot");
      await waitUntil(() => rt.log.list({ kinds: ["run_complete"] }).length > 0);
      expect(rt.log.list({ kinds: ["status"] }).some((e) => e.payload.state === "mcp_attached")).toBe(false);
    } finally {
      await rt.close();
    }
  });
});

describe("reachability", () => {
  it("reports a server that answers as reachable, and one that refuses as not", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await probeMcpServer(`http://127.0.0.1:${port}/mcp`)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    // Same URL, nothing listening now: connection refused is not connected.
    expect(await probeMcpServer(`http://127.0.0.1:${port}/mcp`, 1_000)).toBe(false);
  });

  /**
   * A 405 is a server saying "not that method", which is still a server. The
   * probe measures whether something is there, not whether it likes HEAD.
   */
  it("counts an error status as reachable", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 405;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await probeMcpServer(`http://127.0.0.1:${port}/mcp`)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("never calls a row with no url reachable", async () => {
    expect(await probeMcpServer("")).toBe(false);
    expect(await probeMcpServer("not a url")).toBe(false);
  });
});

/**
 * Health (#21): a dead server's tools are withheld from turns, and its death
 * and recovery are said out loud instead of discovered mid-turn.
 */
describe("mcp health", () => {
  it("marks a dead server down after repeated failures and withholds it from turns", async () => {
    const dir = makeProjectDir({
      name: "mcp-health",
      mcps: [
        // A port nothing listens on: the probe fails honestly and fast.
        { name: "dead", url: "http://127.0.0.1:9", enabledForSession: true },
      ],
    });
    const rt = await ProjectRuntime.open({ id: "mcph", name: "mcph", dir });
    try {
      // Unknown before any poll: passes through — first use must not block on
      // a poll that hasn't run.
      expect(rt.healthyMcps().map((m) => m.name)).toContain("dead");

      await rt.pollMcpHealth(300);
      expect(rt.mcpHealthReport().dead!.up).toBe(false);
      expect(rt.healthyMcps().map((m) => m.name)).toContain("dead"); // one failure: benefit of the doubt

      await rt.pollMcpHealth(300);
      // Two consecutive failures: measured, repeated — now withheld.
      expect(rt.mcpHealthReport().dead!.failures).toBeGreaterThanOrEqual(2);
      expect(rt.healthyMcps().map((m) => m.name)).not.toContain("dead");
    } finally {
      await rt.close();
    }
  });

  it("lets a recovered server rejoin automatically", async () => {
    // A real server that answers, then dies, then answers again.
    const http = await import("node:http");
    const srv = http.createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;

    const dir = makeProjectDir({
      name: "mcp-recover",
      mcps: [{ name: "flappy", url: `http://127.0.0.1:${port}`, enabledForSession: true }],
    });
    const rt = await ProjectRuntime.open({ id: "mcpr", name: "mcpr", dir });
    try {
      await rt.pollMcpHealth(500);
      expect(rt.mcpHealthReport().flappy!.up).toBe(true);

      await new Promise<void>((r) => srv.close(() => r()));
      await rt.pollMcpHealth(300);
      await rt.pollMcpHealth(300);
      expect(rt.healthyMcps().map((m) => m.name)).not.toContain("flappy");

      // Back up — same port so the configured URL is valid again.
      const srv2 = http.createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
      await new Promise<void>((r) => srv2.listen(port, "127.0.0.1", () => r()));
      await rt.pollMcpHealth(500);
      expect(rt.mcpHealthReport().flappy!.up).toBe(true);
      expect(rt.healthyMcps().map((m) => m.name)).toContain("flappy");
      await new Promise<void>((r) => srv2.close(() => r()));
    } finally {
      await rt.close();
    }
  });
});
