/**
 * A stand-in for `opencode serve`, speaking the slice of its HTTP + SSE API the
 * OpenCode adapter uses (shapes recorded from opencode 1.18.31). No model runs:
 * a prompt is admitted, the session is listed in /api/session/active for
 * `turnMs`, then an assistant message completes with `reply`.
 *
 * Knobs model the cases a live server won't give you on demand: a session it
 * has forgotten, a prompt it refuses, a turn that never stops, a failed turn,
 * a compaction, a tool call, a permission request and a question mid-turn.
 * Everything it was asked is recorded. Later endpoints (compact, revert,
 * permission and question replies) follow opencode 1.18.34's /doc.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

export interface FakeOpenCodeOptions {
  reply?: string;
  turnMs?: number;
  /** Stay listed as active forever (quiescence never proven). */
  stuck?: boolean;
  /** POST /prompt answers this status instead of admitting. */
  refusePrompt?: number;
  /** The assistant message finishes with an error. */
  fail?: string;
  /** Emit a compaction (started, ended) during the turn. */
  compact?: boolean;
  /** Emit a tool call during the turn. */
  tool?: { tool: string; input: Json };
  /** Ask permission mid-turn; the turn waits for the reply. */
  ask?: { action: string; resources: string[] };
  /** Ask a question mid-turn; the turn waits for the answer. */
  question?: { question: string; header: string; options: Array<{ label: string; description: string }> };
  /** Usage reported on step.ended. */
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
}

export interface FakeOpenCode {
  url: string;
  opts: FakeOpenCodeOptions;
  sessions: Map<string, { model: Json; messages: Json[] }>;
  prompts: Array<{ session: string; text: string }>;
  modelSwitches: Array<{ session: string; model: Json }>;
  created: Array<{ id: string; body: Json }>;
  /** Permission and question replies, compactions and reverts, in order. */
  replies: Array<{ kind: "permission" | "question" | "question-reject"; session: string; request: string; body: Json }>;
  compactions: string[];
  reverts: Array<{ session: string; messageID: string; files?: boolean }>;
  interrupts: string[];
  forget(session: string): void;
  close(): Promise<void>;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(16)}${(seq++).toString(16).padStart(6, "0")}`;

export async function fakeOpenCode(opts: FakeOpenCodeOptions = {}): Promise<FakeOpenCode> {
  const sessions = new Map<string, { model: Json; messages: Json[] }>();
  const active = new Set<string>();
  const sse = new Set<http.ServerResponse>();
  const prompts: FakeOpenCode["prompts"] = [];
  const modelSwitches: FakeOpenCode["modelSwitches"] = [];
  const created: FakeOpenCode["created"] = [];
  const replies: FakeOpenCode["replies"] = [];
  const compactions: string[] = [];
  const reverts: FakeOpenCode["reverts"] = [];
  const interrupts: string[] = [];
  const staged = new Map<string, string>();
  const waiting = new Map<string, () => void>();
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };
  const push = (type: string, properties: Json) => {
    const line = `data: ${JSON.stringify({ id: nextId("evt"), type, properties })}\n\n`;
    for (const res of sse) res.write(line);
  };
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const body = (req: http.IncomingMessage) => new Promise<Json>((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { try { resolve(raw ? (JSON.parse(raw) as Json) : {}); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    if (p === "/api/health") return send(res, 200, { healthy: true });
    if (p === "/api/model") return send(res, 200, { data: [{ providerID: "opencode", id: "big-pickle", name: "Big Pickle", limit: { context: 200000, output: 32000 } },
      { providerID: "opencode", id: "other-free", name: "Other Free", limit: { context: 100000, output: 8000 } }] });
    if (p === "/api/provider") return send(res, 200, { data: [{ id: "opencode", name: "OpenCode Zen" }] });
    if (p === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      sse.add(res);
      req.on("close", () => sse.delete(res));
      return;
    }
    if (p === "/api/session/active") return send(res, 200, { data: Object.fromEntries([...active].map((s) => [s, { type: "running" }])) });
    if (p === "/api/session" && req.method === "POST") {
      const b = await body(req);
      const id = nextId("ses");
      sessions.set(id, { model: (b.model as Json) ?? { providerID: "opencode", id: "big-pickle" }, messages: [] });
      created.push({ id, body: b });
      return send(res, 200, { data: { id, model: sessions.get(id)!.model } });
    }
    const m = /^\/api\/session\/([^/]+)(?:\/(.*))?$/.exec(p);
    if (!m) return send(res, 404, { message: "no route" });
    const sid = decodeURIComponent(m[1]!), rest = m[2] ?? "";
    const s = sessions.get(sid);
    if (!s) return send(res, 404, { _tag: "SessionNotFoundError", sessionID: sid, message: `Session not found: ${sid}` });
    if (rest === "" && req.method === "GET") return send(res, 200, { data: { id: sid, model: s.model } });
    if (rest === "model" && req.method === "POST") {
      const b = await body(req);
      s.model = b.model as Json;
      modelSwitches.push({ session: sid, model: s.model });
      return send(res, 200, { data: { id: sid, model: s.model } });
    }
    if (rest === "message") return send(res, 200, { data: s.messages });
    const mm = /^message\/(.+)$/.exec(rest);
    if (mm) {
      const msg = s.messages.find((x) => x.id === mm[1]);
      return msg ? send(res, 200, { data: msg }) : send(res, 404, { message: "no message" });
    }
    if (rest === "interrupt") {
      interrupts.push(sid);
      active.delete(sid);
      return send(res, 200, { data: true });
    }
    if (rest === "compact" && req.method === "POST") {
      compactions.push(sid);
      const mid = nextId("msg");
      later(10, () => {
        push("session.next.compaction.started", { sessionID: sid, messageID: mid, reason: "manual" });
        push("session.next.compaction.ended", { sessionID: sid, messageID: mid, reason: "manual", text: "", recent: "" });
      });
      return send(res, 200, {});
    }
    if (rest === "revert/stage" && req.method === "POST") {
      const b = await body(req);
      const mid = String(b.messageID ?? "");
      if (!s.messages.some((x) => x.id === mid)) return send(res, 400, { message: `no message ${mid}` });
      staged.set(sid, mid);
      reverts.push({ session: sid, messageID: mid, ...(typeof b.files === "boolean" ? { files: b.files } : {}) });
      return send(res, 200, { data: { messageID: mid } });
    }
    if (rest === "revert/commit" && req.method === "POST") {
      const mid = staged.get(sid);
      if (!mid) return send(res, 400, { message: "nothing staged" });
      staged.delete(sid);
      s.messages.splice(s.messages.findIndex((x) => x.id === mid));
      return send(res, 200, {});
    }
    const reply = /^(permission|question)\/([^/]+)\/(reply|reject)$/.exec(rest);
    if (reply && req.method === "POST") {
      const b = await body(req);
      replies.push({ kind: reply[1] === "permission" ? "permission" : reply[3] === "reject" ? "question-reject" : "question", session: sid, request: reply[2]!, body: b });
      waiting.get(reply[2]!)?.();
      return send(res, 200, {});
    }
    if (rest === "prompt" && req.method === "POST") {
      const b = await body(req);
      const text = String(((b.prompt ?? {}) as Json).text ?? "");
      if (opts.refusePrompt) return send(res, opts.refusePrompt, { message: "refused" });
      prompts.push({ session: sid, text });
      const userId = typeof b.id === "string" && b.id.startsWith("msg_") ? b.id : nextId("msg");
      s.messages.push({ id: userId, type: "user", text, time: { created: Date.now() } });
      active.add(sid);
      send(res, 200, { data: { admittedSeq: s.messages.length, id: userId, sessionID: sid, delivery: "steer" } });
      const asstId = nextId("msg");
      const pause = (id: string) => new Promise<void>((resolve) => waiting.set(id, () => { waiting.delete(id); resolve(); }));
      later(20, async () => {
        push("session.next.step.started", { sessionID: sid, assistantMessageID: asstId, model: s.model });
        if (opts.ask) {
          const rid = nextId("per");
          push("permission.v2.asked", { id: rid, sessionID: sid, action: opts.ask.action, resources: opts.ask.resources, save: [], metadata: {}, source: { type: "tool", messageID: asstId, callID: "call_ask" } });
          await pause(rid);
        }
        if (opts.question) {
          const rid = nextId("que");
          push("question.v2.asked", { id: rid, sessionID: sid, questions: [{ ...opts.question, multiple: false, custom: true }] });
          await pause(rid);
        }
        if (opts.tool) {
          push("session.next.tool.called", { sessionID: sid, assistantMessageID: asstId, callID: "call_1", tool: opts.tool.tool, input: opts.tool.input });
          push("session.next.tool.success", { sessionID: sid, assistantMessageID: asstId, callID: "call_1", result: {} });
        }
        if (opts.compact) {
          push("session.next.compaction.started", { sessionID: sid, messageID: asstId, reason: "auto" });
          push("session.next.compaction.ended", { sessionID: sid, messageID: asstId, reason: "auto", text: "", recent: "" });
          push("session.compacted", { sessionID: sid });
        }
        push("session.next.text.delta", { sessionID: sid, assistantMessageID: asstId, textID: "t0", delta: opts.reply ?? "done" });
      });
      if (opts.stuck) return;
      const finish = () => later(opts.turnMs ?? 60, () => {
        s.messages.push({
          id: asstId, type: "assistant", time: { created: Date.now(), completed: Date.now() },
          finish: opts.fail ? "error" : "stop",
          ...(opts.fail ? { error: { message: opts.fail } } : {}),
          content: opts.fail ? [] : [{ type: "text", text: opts.reply ?? "done" }],
          tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          model: s.model,
        });
        push("session.next.step.ended", { sessionID: sid, assistantMessageID: asstId, finish: opts.fail ? "error" : "stop", ...(opts.tokens ? { tokens: opts.tokens, cost: 0.01 } : {}) });
        active.delete(sid);
      });
      if (opts.ask || opts.question) {
        // The turn ends only after every ask is answered.
        const check = setInterval(() => {
          const asked = (opts.ask ? 1 : 0) + (opts.question ? 1 : 0);
          if (replies.filter((r) => r.session === sid).length >= asked || !active.has(sid)) { clearInterval(check); finish(); }
        }, 10);
        timers.add(check as unknown as NodeJS.Timeout);
      } else finish();
      return;
    }
    send(res, 404, { message: `no route ${req.method} ${p}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    opts,
    sessions,
    prompts,
    modelSwitches,
    created,
    replies,
    compactions,
    reverts,
    interrupts,
    forget: (session) => { sessions.delete(session); active.delete(session); },
    close: async () => {
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      for (const res of sse) res.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
