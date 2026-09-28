// Deterministic daemon-side benchmark, no native/paid harness calls.
// Run after npm run build; stdout is a standalone JSON measurement artifact.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { EventLog } from "../dist/core/eventlog.js";
import { ContinuityEngine, estimateTokens } from "../dist/core/continuity/engine.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-brain-benchmark-"));
fs.mkdirSync(path.join(root, ".loom"));
const log = await EventLog.open(path.join(root, ".loom"));
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
try {
  const brain = new ContinuityEngine(log, "benchmark");
  for (let i = 0; i < 10_000; i++) log.append({ kind: "message", ...(i % 500 ? { agentId: "fake-codex" } : {}),
    payload: { text: i % 500 ? `Agent observation ${i}: touched file-${i % 40}.ts; claim only, verification unknown.` :
      `User point ${i / 500}: keep keyboard focus, no telemetry; alternative SQLite remains tentative until approved.` } });
  const req = brain.capture({ id: "benchmark-request", conversationId: "main", agentInstanceId: "fake-claude",
    text: "Continue with keyboard focus preserved", source: "user", model: null, plan: false, targetAddedTokens: 6000 }).request;
  const timings = [], added = [], retrieval = []; let packet;
  for (let i = 0; i < 30; i++) {
    const start = performance.now(); packet = await brain.prepare(req, "claude-code", root, {});
    timings.push(performance.now() - start); added.push(packet.packet.budget.estimatedAddedTokens);
    const search = performance.now(); brain.store.search("main", "keyboard focus"); retrieval.push(performance.now() - search);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.floor((values.length - 1) * p)];
  const replay = log.list().map(e => typeof e.payload.text === "string" ? e.payload.text : JSON.stringify(e.payload)).join("\n");
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).reduce((sum,e) => sum +
    (e.isDirectory() ? walk(path.join(dir,e.name)) : fs.statSync(path.join(dir,e.name)).size), 0);
  process.stdout.write(JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version,
    hardware: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
    corpus: { events: 10001, buriedUserPoints: 20, attempts: 30, paidCalls: 0, git: false },
    preparationMs: { p50: percentile(timings,.5), p95: percentile(timings,.95) },
    retrievalMs: { p50: percentile(retrieval,.5), p95: percentile(retrieval,.95) },
    daemonLoopMs: { p95: loop.percentile(95)/1e6, max: loop.max/1e6 },
    turnInputEstimatedTokens: { minimum: Math.min(...added), maximum: Math.max(...added), estimation: "UTF-8 bytes / 3 heuristic" },
    exactReplayEstimatedTokens: estimateTokens(replay),
    allBuriedUserPointsIncluded: Array.from({length:20},(_,i) => packet.rendered.text.includes(`User point ${i}:`)).every(Boolean),
    legacyRecent400ContainsFirstPoint: log.list({limit:400}).some(e => String(e.payload.text).includes("User point 0:")),
    processMemory: process.memoryUsage(), diskBytes: walk(root),
    nativeTokens: null, helperTokens: 0, continuationQuality: "native understanding not measured; exact source inclusion checked",
  }, null, 2) + "\n");
} finally { loop.disable(); log.close(); fs.rmSync(root, { recursive: true, force: true }); }
