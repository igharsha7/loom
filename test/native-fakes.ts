/**
 * Stand-ins for the two native harnesses, speaking the protocols the adapters
 * actually use: the Claude Code CLI's stream-json control protocol (what the
 * Agent SDK drives) and `codex app-server` JSON-RPC.
 *
 * The real CLIs aren't used because a turn costs money and needs an account,
 * and because the interesting cases — a lost session, a refused turn, a
 * process that dies mid-turn — are ones you can't ask a working CLI for.
 *
 * Each fake records what it was given next to itself: `calls.jsonl` (argv per
 * launch) and `stdin.jsonl` (every protocol message it received, including
 * the answers to its own permission requests).
 *
 * A script is a list of steps run when the turn starts. Any string in a step
 * containing `$SESSION` (or `$TURN` for Codex) is filled in at run time.
 *   { out: {...} }                  write one protocol message
 *   { raw: "text" }                 write a line that isn't protocol
 *   { stderr: "text" }              write to stderr
 *   { sleep: ms }                   wait
 *   { ask: {...} }                  Claude: a can_use_tool request, awaits the answer
 *   { ask: method, params }         Codex: a server request, awaits the answer
 *   { exit: code }                  exit now
 *   { spawn: "js" }                 start a child in the fake's process group
 */

import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.js";

export type Step = Record<string, unknown>;

export interface FakeClaudeOptions {
  /** The turn: steps run after each user message arrives. Defaults to CLAUDE_OK. */
  script?: Step[];
  /** Per-turn scripts (turn 1, turn 2, …); a turn past the end uses `script`. */
  scripts?: Step[][];
  /** Exit code when stdin closes (after the result). */
  code?: number;
  /** A `--resume` of any session fails as the real CLI does. */
  missingSession?: boolean;
  /** Written to stderr at launch. */
  stderr?: string;
  version?: string;
}

/** A complete, ordinary Claude turn. */
export const CLAUDE_OK: Step[] = [
  { out: { type: "system", subtype: "init", session_id: "$SESSION" } },
  { out: { type: "assistant", message: { model: "claude-test", content: [{ type: "text", text: "Did the work." }],
    usage: { input_tokens: 30, cache_read_input_tokens: 2, output_tokens: 8 } }, parent_tool_use_id: null, session_id: "$SESSION" } },
  { out: { type: "result", subtype: "success", is_error: false, result: "Did the work.", total_cost_usd: 0.0421,
    usage: { input_tokens: 32, output_tokens: 8 }, modelUsage: { "claude-test": { contextWindow: 200000 } }, session_id: "$SESSION" } },
];

export const claudeInit: Step = { out: { type: "system", subtype: "init", session_id: "$SESSION" } };
export const claudeText = (text: string, extra: Record<string, unknown> = {}): Step =>
  ({ out: { type: "assistant", message: { model: "claude-test", content: [{ type: "text", text }], ...extra }, parent_tool_use_id: null, session_id: "$SESSION" } });
export const claudeThink = (thinking: string): Step =>
  ({ out: { type: "assistant", message: { content: [{ type: "thinking", thinking }] }, parent_tool_use_id: null, session_id: "$SESSION" } });
export const claudeTool = (name: string, input: Record<string, unknown>): Step =>
  ({ out: { type: "assistant", message: { content: [{ type: "tool_use", id: `tu-${name}`, name, input }] }, parent_tool_use_id: null, session_id: "$SESSION" } });
export const claudeResult = (extra: Record<string, unknown> = {}): Step =>
  ({ out: { type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.0421,
    usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, session_id: "$SESSION", ...extra } });

const RUNNER = `
const fs = require("node:fs"), path = require("node:path");
const here = path.dirname(process.argv[1]);
const record = (file, value) => fs.appendFileSync(path.join(here, file), JSON.stringify(value) + "\\n");
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fill = (value, vars) => JSON.parse(JSON.stringify(value).replace(/\\$(SESSION|TURN|THREAD)/g, (_, k) => vars[k]));
`;

/** A fake `claude` for the Agent SDK. Returns its path. */
export function fakeClaude(options: FakeClaudeOptions = {}): string {
  const dir = tmpDir("fake-claude"), bin = path.join(dir, "claude");
  const config = { script: options.script ?? CLAUDE_OK, scripts: options.scripts ?? [], code: options.code ?? 0, missingSession: options.missingSession ?? false,
    stderr: options.stderr ?? "", version: options.version ?? "2.1.283 (Claude Code)" };
  fs.writeFileSync(bin, `#!/usr/bin/env node
${RUNNER}
const config = ${JSON.stringify(config)};
const args = process.argv.slice(2);
record("calls.jsonl", args);
if (args.includes("--version")) { console.log(config.version); process.exit(0); }
if (config.stderr) process.stderr.write(config.stderr + "\\n");
const flag = (name) => { const i = args.findIndex((a) => a === name || a.startsWith(name + "=")); return i < 0 ? null : args[i].includes("=") ? args[i].slice(name.length + 1) : args[i + 1]; };
const resume = flag("--resume");
if (resume && config.missingSession) {
  process.stderr.write("No conversation found with session ID: " + resume + "\\n");
  process.exit(1);
}
const vars = { SESSION: resume || flag("--session-id") || require("node:crypto").randomUUID() };
const pending = new Map();
let seq = 0, turns = 0, interrupted = false, running = null;
const queued = [];
async function run(script) {
  for (const step of script) {
    if (interrupted) return;
    if ("out" in step) out(fill(step.out, vars));
    else if ("raw" in step) process.stdout.write(step.raw + "\\n");
    else if ("stderr" in step) process.stderr.write(step.stderr + "\\n");
    else if ("sleep" in step) await sleep(step.sleep);
    else if ("exit" in step) process.exit(step.exit);
    else if ("spawn" in step) require("node:child_process").spawn(process.execPath, ["-e", step.spawn], { stdio: ["ignore", "inherit", "inherit"] }).unref();
    else if ("ask" in step) {
      const request_id = "fake-" + ++seq;
      const answer = new Promise((resolve) => pending.set(request_id, resolve));
      out({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_use_id: "tu-" + seq, ...step.ask } });
      await answer;
    }
  }
}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  record("stdin.jsonl", m);
  if (m.type === "control_request") {
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    if (m.request.subtype === "interrupt" && !interrupted) {
      interrupted = true;
      out({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request interrupted by user"],
        total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, session_id: vars.SESSION });
    }
  } else if (m.type === "control_response") {
    const resolve = pending.get(m.response.request_id);
    if (resolve) { pending.delete(m.response.request_id); resolve(m.response); }
  } else if (m.type === "user") { queued.push(m); if (!running) running = drain(); }
});
// One CLI serves many turns: each user message runs the next script.
async function drain() {
  while (queued.length) {
    queued.shift();
    const script = config.scripts[turns] || config.script;
    turns++;
    interrupted = false;
    record("turns.jsonl", { turn: turns, pid: process.pid });
    await run(script);
  }
  running = null;
}
process.stdin.on("end", async () => { if (running && !interrupted) await running; process.exit(config.code); });
`, { mode: 0o755 });
  return bin;
}

export interface FakeCodexOptions {
  /** Notifications and requests after each turn/start. Defaults to CODEX_OK. */
  script?: Step[];
  /** Per-turn scripts (turn 1, turn 2, …); a turn past the end uses `script`. */
  scripts?: Step[][];
  /** thread/resume answers "no rollout found". */
  missingThread?: boolean;
  /** turn/start is refused with an error response. */
  refuseTurn?: string;
  /** Exit before answering initialize, with this stderr. */
  dieAtStart?: { code: number; stderr: string };
  /** The model thread/start reports. */
  model?: string;
  version?: string;
  /** The thread is on legacy history: thread/revert is refused, thread/rollback works. */
  legacyHistory?: boolean;
  paginatedHistory?: boolean;
  initializeDelayMs?: number;
  compactDelayMs?: number;
  startAckExit?: boolean;
}

const usage = (input: number, cached: number, output: number, reasoning = 0) =>
  ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning });

export const codexNotify = (method: string, params: Record<string, unknown>): Step => ({ out: { method, params: { threadId: "$THREAD", turnId: "$TURN", ...params } } });
export const codexItem = (item: Record<string, unknown>): Step => codexNotify("item/completed", { item: { id: `i-${Math.random().toString(36).slice(2)}`, ...item } });
export const codexMessage = (text: string): Step => codexItem({ type: "agentMessage", text });
export const codexTokens = (input: number, cached: number, output: number, window = 272000): Step =>
  codexNotify("thread/tokenUsage/updated", { tokenUsage: { total: usage(input, cached, output), last: usage(input, cached, output), modelContextWindow: window } });
export const codexDone = (status = "completed", error: string | null = null): Step =>
  codexNotify("turn/completed", { turn: { id: "$TURN", items: [], status, error: error ? { message: error } : null } });

/** A complete, ordinary Codex turn. */
export const CODEX_OK: Step[] = [
  codexNotify("turn/started", { turn: { id: "$TURN", items: [], status: "inProgress", error: null } }),
  codexMessage("Did the work."),
  codexTokens(52831, 44672, 120),
  codexDone(),
];

/** A fake `codex` that serves `app-server`. Returns its path. */
export function fakeCodex(options: FakeCodexOptions = {}): string {
  const dir = tmpDir("fake-codex"), bin = path.join(dir, "codex");
  const config = { script: options.script ?? CODEX_OK, scripts: options.scripts ?? [], missingThread: options.missingThread ?? false,
    refuseTurn: options.refuseTurn ?? null, dieAtStart: options.dieAtStart ?? null, model: options.model ?? "gpt-test",
    version: options.version ?? "codex-cli 0.155.0", legacyHistory: options.legacyHistory ?? false, paginatedHistory: options.paginatedHistory ?? false, initializeDelayMs: options.initializeDelayMs ?? 0, compactDelayMs: options.compactDelayMs ?? 0, startAckExit: options.startAckExit ?? false };
  fs.writeFileSync(bin, `#!/usr/bin/env node
${RUNNER}
const config = ${JSON.stringify(config)};
const args = process.argv.slice(2);
record("calls.jsonl", args);
if (args.includes("--version")) { console.log(config.version); process.exit(0); }
if (args[0] !== "app-server") { console.error("unexpected args"); process.exit(2); }
if (config.dieAtStart) { process.stderr.write(config.dieAtStart.stderr + "\\n"); process.exit(config.dieAtStart.code); }
const vars = { THREAD: "", TURN: "", SESSION: "" };
const pending = new Map();
let seq = 0, turns = 0, interrupted = false;
const history = []; // native history survives fake app-server restarts too
const saveHistory = () => fs.writeFileSync(path.join(here, vars.THREAD + ".history.json"), JSON.stringify(history));
const reply = (id, result) => out({ id, result });
async function run(script, turnVars = { ...vars }) {
  for (const step of script) {
    if (interrupted) return;
    if ("out" in step) out(fill(step.out, turnVars));
    else if ("raw" in step) process.stdout.write(step.raw + "\\n");
    else if ("stderr" in step) process.stderr.write(step.stderr + "\\n");
    else if ("sleep" in step) await sleep(step.sleep);
    else if ("exit" in step) process.exit(step.exit);
    else if ("spawn" in step) require("node:child_process").spawn(process.execPath, ["-e", step.spawn], { stdio: ["ignore", "inherit", "inherit"] }).unref();
    else if ("ask" in step) {
      const id = "srv-" + ++seq;
      const answer = new Promise((resolve) => pending.set(id, resolve));
      out({ id, method: step.ask, params: fill({ threadId: "$THREAD", turnId: "$TURN", itemId: "item-" + seq, ...(step.params || {}) }, turnVars) });
      await answer;
    }
  }
}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  record("stdin.jsonl", m);
  if (m.method === undefined) { const resolve = pending.get(m.id); if (resolve) { pending.delete(m.id); resolve(m); } return; }
  if (m.id === undefined) return; // a notification ("initialized")
  switch (m.method) {
    case "initialize": return setTimeout(() => reply(m.id, { userAgent: "fake-codex" }), config.initializeDelayMs);
    case "config/read": return reply(m.id, { config: { model: config.model } });
    case "model/list": return reply(m.id, { data: [{ model: config.model, isDefault: true }] });
    case "thread/start":
      vars.THREAD = "thread-" + process.pid + "-" + Date.now();
      return reply(m.id, { thread: { id: vars.THREAD }, model: config.model });
    case "thread/resume":
      if (config.missingThread) return out({ id: m.id, error: { code: -32600, message: "no rollout found for thread id " + m.params.threadId } });
      vars.THREAD = m.params.threadId;
      const saved = path.join(here, vars.THREAD + ".history.json");
      history.splice(0, history.length, ...(fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, "utf8")) : []));
      return reply(m.id, { thread: { id: vars.THREAD }, model: config.model });
    case "turn/start":
      if (config.refuseTurn) return out({ id: m.id, error: { code: -32600, message: config.refuseTurn } });
      // One app-server serves many turns on the same thread.
      turns++;
      vars.TURN = "turn-" + process.pid + "-" + turns;
      history.push(vars.TURN);
      saveHistory();
      interrupted = false;
      record("turns.jsonl", { turn: turns, pid: process.pid, thread: vars.THREAD });
      if (config.startAckExit) { setTimeout(() => process.exit(1), 150); return; }
      reply(m.id, { turn: { id: vars.TURN, items: [], status: "inProgress", error: null } });
      void run(config.scripts[turns - 1] || config.script);
      return;
    case "thread/compact/start":
      reply(m.id, {});
      setTimeout(() => out({ method: "thread/compacted", params: { threadId: vars.THREAD } }), config.compactDelayMs);
      return;
    case "thread/revert": {
      if (config.legacyHistory) return out({ id: m.id, error: { code: -32600, message: "thread uses legacy history" } });
      const at = history.indexOf(m.params.beforeTurnId);
      if (at < 0) return out({ id: m.id, error: { code: -32600, message: "unknown turn " + m.params.beforeTurnId } });
      history.splice(at);
      saveHistory();
      record("history.jsonl", { pid: process.pid, turns: history });
      return reply(m.id, { thread: { id: vars.THREAD, turns: [] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
    }
    case "thread/turns/list": {
      const offset = Number(m.params.cursor || 0);
      return reply(m.id, { data: history.slice(offset, offset + 1).map(id => ({ id, items: [] })), nextCursor: offset + 1 < history.length ? String(offset + 1) : null });
    }
    case "thread/read":
      if (config.paginatedHistory) {
        if (m.params.includeTurns) return out({ id: m.id, error: { code: -32600, message: "use turns/list" } });
        return reply(m.id, { thread: { id: vars.THREAD, historyMode: "paginated" } });
      }
      return reply(m.id, { thread: { id: vars.THREAD, turns: history.map((id) => ({ id, items: [] })) } });
    case "thread/rollback":
      history.splice(Math.max(0, history.length - m.params.numTurns));
      saveHistory();
      record("history.jsonl", { pid: process.pid, turns: history });
      return reply(m.id, { thread: { id: vars.THREAD, turns: history.map((id) => ({ id, items: [] })) } });
    case "turn/interrupt":
      interrupted = true;
      reply(m.id, {});
      out({ method: "turn/completed", params: { threadId: vars.THREAD, turn: { id: vars.TURN, items: [], status: "interrupted", error: null } } });
      return;
    default:
      return out({ id: m.id, error: { code: -32601, message: "unknown method " + m.method } });
  }
});
process.stdin.on("end", () => process.exit(0));
`, { mode: 0o755 });
  return bin;
}

/** argv of every launch except version probes. */
export const callsOf = (bin: string): string[][] => {
  const file = path.join(path.dirname(bin), "calls.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as string[]).filter((args) => !args.includes("--version"));
};

/** Every protocol message the fake received, in order. */
export const stdinOf = (bin: string): Array<Record<string, unknown>> => {
  const file = path.join(path.dirname(bin), "stdin.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
};

/** The JSON-RPC requests a fake codex received, by method. */
export const rpcOf = (bin: string, method: string): Array<Record<string, unknown>> =>
  stdinOf(bin).filter((m) => m.method === method).map((m) => (m.params ?? {}) as Record<string, unknown>);

/** The prompt text a fake claude was sent (the SDK's user message). */
export const claudePromptOf = (bin: string): string => {
  const user = stdinOf(bin).filter((m) => m.type === "user").at(-1) as { message?: { content?: Array<{ text?: string }> | string } } | undefined;
  const content = user?.message?.content;
  return typeof content === "string" ? content : (content ?? []).map((c) => c.text ?? "").join("");
};

/** The last SDK initialize request a fake claude received. */
export const claudeInitOf = (bin: string): Record<string, unknown> =>
  ((stdinOf(bin).filter((m) => m.type === "control_request" && (m.request as Record<string, unknown>)?.subtype === "initialize").at(-1)?.request) ?? {}) as Record<string, unknown>;

/** Every turn a fake served: `{ turn, pid }` per turn, in order. */
export const turnsOf = (bin: string): Array<{ turn: number; pid: number; thread?: string }> => {
  const file = path.join(path.dirname(bin), "turns.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { turn: number; pid: number; thread?: string });
};

export interface FakeOpenCodeCliOptions {
  /** Events after each admitted prompt. Defaults to OPENCODE_OK. */
  script?: Step[];
  /** Per-turn scripts (turn 1, turn 2, …); a turn past the end uses `script`. */
  scripts?: Step[][];
  /** POST /prompt answers this status instead of admitting. */
  refusePrompt?: number;
  version?: string;
}

/** An OpenCode event for the running turn ($SESSION, $TURN = the user message, $MSG = the reply). */
export const opencodeEvent = (type: string, properties: Record<string, unknown> = {}): Step =>
  ({ event: type, properties: { sessionID: "$SESSION", assistantMessageID: "$MSG", ...properties } });
/** The reply is complete and the session goes idle. */
export const opencodeDone = (error?: string): Step => ({ done: error ? { error } : {} });

/** A complete, ordinary OpenCode turn. */
export const OPENCODE_OK: Step[] = [
  opencodeEvent("session.next.step.started", { model: { providerID: "opencode", id: "big-pickle" } }),
  opencodeEvent("session.next.text.delta", { textID: "t0", delta: "Did the work." }),
  opencodeEvent("session.next.step.ended", { finish: "stop", cost: 0, tokens: { input: 900, output: 20, reasoning: 0, cache: { read: 100, write: 0 } } }),
  opencodeDone(),
];

/**
 * A fake `opencode` that serves `opencode serve`'s HTTP API (the 1.18 shapes
 * test/opencode-fake.ts records). A turn's steps run when a prompt is
 * admitted; `{ done }` completes the reply and takes the session off
 * /api/session/active. Sessions persist next to the binary, so a restarted
 * server still has them. Returns its path.
 */
export function fakeOpenCodeCli(options: FakeOpenCodeCliOptions = {}): string {
  const dir = tmpDir("fake-opencode"), bin = path.join(dir, "opencode");
  const config = { script: options.script ?? OPENCODE_OK, scripts: options.scripts ?? [], refusePrompt: options.refusePrompt ?? 0, version: options.version ?? "1.18.34" };
  fs.writeFileSync(bin, `#!/usr/bin/env node
${RUNNER}
const http = require("node:http");
const config = ${JSON.stringify(config)};
const args = process.argv.slice(2);
record("calls.jsonl", args);
if (args.includes("--version")) { console.log(config.version); process.exit(0); }
if (args[0] !== "serve") { console.error("unexpected args"); process.exit(2); }
const port = Number(args[args.indexOf("--port") + 1]);
const store = path.join(here, "sessions.json");
const sessions = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : {};
const save = () => fs.writeFileSync(store, JSON.stringify(sessions));
const active = new Set(), streams = new Set(), staged = {};
let seq = 0, turns = 0;
const id = (p) => p + "_" + Date.now().toString(16).padStart(12, "0") + String(++seq).padStart(14, "0");
const push = (type, properties) => { const line = "data: " + JSON.stringify({ id: id("evt"), type, properties }) + "\\n\\n"; for (const r of streams) r.write(line); };
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((resolve) => { let raw = ""; req.on("data", (c) => raw += c); req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } }); });
const fillAll = (v, vars) => JSON.parse(JSON.stringify(v).replace(/\\$(SESSION|TURN|MSG)/g, (_, k) => vars[k]));
async function run(script, vars, s) {
  for (const step of script) {
    if (vars.interrupted) return;
    if ("event" in step) push(step.event, fillAll(step.properties, vars));
    else if ("sleep" in step) await sleep(step.sleep);
    else if ("exit" in step) process.exit(step.exit);
    else if ("spawn" in step) require("node:child_process").spawn(process.execPath, ["-e", step.spawn], { stdio: ["ignore", "inherit", "inherit"] }).unref();
    else if ("done" in step) {
      s.messages.push({ id: vars.MSG, type: "assistant", time: { created: Date.now(), completed: Date.now() }, finish: step.done.error ? "error" : "stop",
        ...(step.done.error ? { error: { message: step.done.error } } : {}), tokens: { input: 900, output: 20, reasoning: 0, cache: { read: 100, write: 0 } }, model: s.model });
      save();
      active.delete(vars.SESSION);
      push("session.idle", { sessionID: vars.SESSION });
    }
  }
}
const running = {};
http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/api/health") return send(res, 200, { healthy: true });
  if (p === "/api/model") return send(res, 200, { data: [{ providerID: "opencode", id: "big-pickle", name: "Big Pickle", limit: { context: 200000, output: 32000 }, cost: [{ input: 0, output: 0 }] }] });
  if (p === "/api/provider") return send(res, 200, { data: [{ id: "opencode", name: "OpenCode Zen" }] });
  if (p === "/event") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: {\\"type\\":\\"server.connected\\",\\"properties\\":{}}\\n\\n"); streams.add(res); req.on("close", () => streams.delete(res)); return; }
  if (p === "/api/session/active") return send(res, 200, { data: Object.fromEntries([...active].map((s) => [s, { type: "busy" }])) });
  if (p === "/api/session" && req.method === "POST") {
    const b = await body(req), sid = id("ses");
    sessions[sid] = { model: b.model || { providerID: "opencode", id: "big-pickle" }, messages: [] }; save();
    return send(res, 200, { data: { id: sid, model: sessions[sid].model } });
  }
  const m = /^\\/api\\/session\\/([^/]+)(?:\\/(.*))?$/.exec(p);
  if (!m) return send(res, 404, { message: "no route" });
  const sid = decodeURIComponent(m[1]), rest = m[2] || "", s = sessions[sid];
  if (!s) return send(res, 404, { _tag: "SessionNotFoundError", message: "Session not found: " + sid });
  if (rest === "" ) return send(res, 200, { data: { id: sid, model: s.model } });
  if (rest === "model") { s.model = (await body(req)).model; save(); return send(res, 200, {}); }
  if (rest === "message") return send(res, 200, { data: s.messages });
  if (rest === "interrupt") { if (running[sid]) running[sid].interrupted = true; active.delete(sid); push("session.idle", { sessionID: sid }); return send(res, 200, {}); }
  if (rest === "compact") {
    send(res, 200, {});
    const mid = id("msg");
    setTimeout(() => { push("session.next.compaction.started", { sessionID: sid, messageID: mid, reason: "manual" }); push("session.next.compaction.ended", { sessionID: sid, messageID: mid, reason: "manual", text: "", recent: "" }); }, 10);
    return;
  }
  if (rest === "revert/stage") { const b = await body(req); if (!s.messages.some((x) => x.id === b.messageID)) return send(res, 400, { message: "no message" }); staged[sid] = b.messageID; return send(res, 200, { data: { messageID: b.messageID } }); }
  if (rest === "revert/commit") { const at = s.messages.findIndex((x) => x.id === staged[sid]); if (at < 0) return send(res, 400, { message: "nothing staged" }); s.messages.splice(at); delete staged[sid]; save(); record("history.jsonl", { session: sid, messages: s.messages.map((x) => x.id) }); return send(res, 200, {}); }
  if (rest === "prompt" && req.method === "POST") {
    const b = await body(req);
    if (config.refusePrompt) return send(res, config.refusePrompt, { message: "refused" });
    const vars = { SESSION: sid, TURN: b.id, MSG: id("msg"), interrupted: false };
    s.messages.push({ id: b.id, type: "user", text: b.prompt.text, time: { created: Date.now() } }); save();
    turns++;
    record("turns.jsonl", { turn: turns, pid: process.pid, thread: sid });
    active.add(sid);
    running[sid] = vars;
    send(res, 200, { data: { admittedSeq: s.messages.length, id: b.id, sessionID: sid, delivery: "steer" } });
    void run(config.scripts[turns - 1] || config.script, vars, s);
    return;
  }
  send(res, 404, { message: "no route " + p });
}).listen(port, "127.0.0.1");
`, { mode: 0o755 });
  return bin;
}
