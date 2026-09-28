# Brain implementation TODO

Status: deterministic native mode implemented; release gates remain. Updated: 2026-09-28.
Plan: [brain-continuity-implementation.md](../proposals/brain-continuity-implementation.md).
Evidence and case IDs: [BRAIN-NOTES.md](BRAIN-NOTES.md).

Check an item only after its implementation and required verification pass.
Record actual results, revisions and unresolved limitations in BRAIN-NOTES.md.
Do not infer user approval from elapsed time or an unchecked question.

## Planning receipt

- [x] Read committed boundary implementation and previous continuity proposal.
- [x] Browse primary sources for native continuation, injection, schema and storage.
- [x] Make embeddings/local model runtimes unnecessary for the first milestone.
- [x] Define packet/render/receipt separation and non-silent overflow/recovery policy.
- [x] Identify 64 edge-case fixtures/checks with explicit required outcomes.
- [x] User reviews and authorizes implementation (2026-09-28).

## P0 — Contracts and capabilities

- [x] Add/pin Zod; define versioned JSON-compatible domain contracts and inferred types.
- [x] Implement semantic source/scope/authority/epoch/coverage validation; E33–E36, E40.
- [x] Define protocol limits and unknown-version/error behavior for imports and IPC/HTTP.
- [x] Define asynchronous internal commands for potential worker isolation; preserve legacy synchronous semantics in their owner.
- [x] Record supported Node/harness versions and compatibility profiles.
- [ ] Verify Claude dynamic context on resume, Codex explicit resume and OpenCode API shape; E09–E16.
- [x] Establish native acceptance evidence and idempotency limits; E25–E30.
- [x] Define process/run quiescence and project/workspace ownership; E19–E24, E31–E32.
- [x] Choose a read-only retrieval route for each supported harness; E45.
- [x] Write fake CLI/local server fixtures; run focused adapter/schema tests without paid calls.

Gate: all assumptions needed by P1/P2 have explicit tested capabilities or a
visible unsupported path. Stop errors cannot be swallowed into a new writer.

## P1 — Canonical evidence and storage

- [x] Finalize ordered DDL/migrations, foreign keys, IDs and transactional write paths.
- [ ] Back up and import existing SQLite/JSONL/state.json with manifests and conflict rules.
- [ ] Preserve Main/pre-chat history and original event IDs; handle ambiguous native slots; E55–E56.
- [x] Implement idempotent user requests and exact capture; E08, E30, E63.
- [ ] Implement message/queue revision and deletion dependencies; E07. Native action edits are gated.
- [ ] Normalize streaming/tool outcomes without destroying captured observations; E37–E39.
- [x] Implement instructions, decision supersession, topic ledger and source dispositions; E01–E06.
- [ ] Implement artifact finalization, integrity and scoped references; E52–E53, E62.
- [ ] Build/backfill FTS/entity indexes with query escaping and rebuild fallback; E43–E44.
- [ ] Test disk-full/busy/crash/backup/network-filesystem failures; E49–E54.
- [ ] Test rollback including post-cutover events and older-reader behavior.
- [ ] Implement project ownership/fencing and bounded database queues; E32, E50–E51.

Gate: source history is recoverable, migrations are restartable, no empty-store
fallback or silent merge, and no mandatory user intent depends on FTS ranking.

## P2 — Deterministic sequential continuity

- [x] Implement per-chat/per-workspace native bindings and epochs.
- [x] Implement frozen snapshots and source-level exact/summary/reference/omission coverage.
- [x] Assemble reconstruction/return deltas with protected intent and exact current request.
- [x] Render origin-labeled context; remove blanket authority framing in the new path; E58–E59.
- [x] Persist immutable packet/render hashes and revalidate before submission; E40, E42.
- [x] Implement delivery attempts/receipts and correlated native event ingest; E25–E30.
- [x] Implement finish/interrupt switching, queued target capture and writer leases; E17–E24.
- [x] Recover after restart without blindly replaying unknown action prompts; E26–E27, E31–E32.
- [x] Run Claude → Codex → Claude fixture, including correction and app restart.
- [ ] Verify unavailable targets/offline operation and scoped source access; E45, E57, E61–E64.

Gate: deterministic continuity works across sessions with visible coverage and
recovery state; no duplicate action execution or cross-chat session reuse.

## P3 — Long conversations and lightweight performance

- [x] Implement source-backed checkpoints and deterministic compaction/fidelity policy.
- [x] Handle native compaction (both harnesses report it); E13. Retention after an
  uncompacted resume stays "unknown"; E14.
- [ ] Measure tokenizer/heuristic budgets and retrieval/helper/native overhead separately.
- [x] Implement resumable mandatory overflow UX; E41.
- [ ] Test buried small preferences, rejected alternatives and unresolved user dispositions.
- [ ] Verify indexed/paginated database work meets daemon responsiveness thresholds.
- [ ] If measurements require isolation, route all writers through one worker/process owner with bounded messaging and recovery.
- [x] Freeze initial 10,001-event no-Git benchmark/reference hardware and proposed
  thresholds; Git-heavy/native quality comparisons remain pending.
- [ ] Compare exact replay/current Loom/new assembler for correctness, added tokens and latency.
- [x] Verify no local model download or always-loaded inference process is needed.

Gate: long-history performance and fidelity are measured; no "seamless" claim
from only small packets, schema success or provider acceptance.

## P4 — Optional cheap harness helpers

- [ ] Validate available models and account-supported helper mode; no expensive substitution.
- [ ] Implement isolated no-tools/restricted helper execution and schema subset checks.
- [ ] Validate source evidence and authority; reject invented references and false work claims.
- [ ] Add cache keys, global/project concurrency, timeout/output/usage caps and cooldowns.
- [ ] Discard stale/cancelled/deleted-source results; E34–E35, E46–E48.
- [ ] Evaluate summary quality against exact sources and preserve original evidence.
- [ ] Add optional title/topic jobs without contaminating foreground history/coverage.

Gate: helpers improve measured overhead/quality and deterministic operation remains
usable when helpers are disabled or unavailable. Embeddings are outside scope.

## P5 — Integrate and cut over

- [ ] Enable OpenCode only after its protocol/acceptance fixtures pass.
- [ ] Integrate queue, pinned chats, routes and worktree/orchestra ownership.
- [ ] Apply explicit team/private/bridge context rules; E24, E57–E60.
- [ ] Remove redundant legacy injection/extraction paths after parity; prevent double briefings.
- [x] Add diagnostics for packet contents, sources, coverage, estimates and receipt outcomes.
- [ ] Test supported platforms, daemon reload, worker recovery and packaged retrieval access.
- [ ] Run build/typecheck, affected integration tests, full regression suite and packaging checks.
  Build/typecheck, 1,384 non-DOM, 125 browser and 105 final affected checks passed;
  cross-platform packaged execution remains unverified.
- [x] Update contributor/user docs with capability, retention and cost limitations.
- [ ] Record final results, remaining gaps and optional separately authorized live smoke tests.

Release gate: P0–P3 and integration safeguards pass. P4 is optional. Parallel model
coding, Electron redesign and local embeddings require separate future scope.

## Implementation receipt and deliberate gates

- [x] Zod pinned to 4.6.5; contracts use shape checks plus semantic validation.
- [x] Existing SQLite connection retained; activation backup and explicit offline
  JSONL migration preserve originals and refuse conflicts/torn imports.
- [x] Scoped reviewed checkpoint artifacts finalize atomically and verify hashes.
- [x] Native initialization is separated from acceptance; errors do not release
  foreground preparation barriers before process/send settlement.
- [x] Scoped request/packet/source HTTP routes and overflow/checkpoint UI exist.
- [x] 10,001-event daemon benchmark recorded without paid calls; all buried
  user points included. See `brain-benchmark-2026-09-28.json`.
- [ ] Release certification for every E01–E64 case and platform. Grouped regressions
  cover core cases; they do not certify every matrix row.
- [ ] Native compaction hooks/actual retention, tokenizer and actual quota accounting.
- [ ] Complete tool-result normalization across both harnesses (Claude outcomes
  remain pending when no final result is exposed); bounded large-output behavior.
- [ ] Automatic artifact GC/deletion/retention and complete downgrade/export tooling.
- [ ] Genuine OS disk-full/network-filesystem and process-orphan fault injection.
- [ ] Isolated cheap helpers/account model discovery, OpenCode protocol parity.
- [ ] Native continuation quality and Git/worktree-heavy performance corpora.

Unsupported profiles/features return explicit errors rather than silently using
legacy native sessions, parallel execution or unverified helper calls. The default
remains off until the remaining release gates are reviewed.

## Cleanup audit follow-up

See [BRAIN-AUDIT](BRAIN-AUDIT.md) for both review axes and all 64 case statuses.

- [x] Fix Stop/submission race and bounded pre-intent reassembly.
- [x] Preserve exact queued text and captured targets/models.
- [x] Fix checkpoint revision holes, authority and receipt link validation.
- [x] Make reconciliation atomic, addressable beyond latest 100 and single-use.
- [x] Start inherited-group cleanup at parent exit; fence unknown termination.
- [x] Prevent app-owned turn commits from overlapping the next native writer.
- [x] Roll back config/mode ownership on failed atomic config saves; fence unresolved leases across legacy restart.
- [x] Gate unsupported route/orchestra work before side effects and guard mode changes.
- [x] Remove unused runtime forwarding and native legacy decision/extractor paths.
- [x] Harden artifacts and add transactional FTS maintenance/rebuild.
- [ ] Certify escaped children, Windows, real native quality and the remaining partial/gated rows.

Cleanup validation: build/typecheck, 1,408 daemon tests, 125 browser tests, 87 focused
checks, documentation links/64 audit rows, whitespace and packaging dry run passed.
The 17 skips and all partial/gated matrix rows remain visible release limitations.

## Validation follow-up — 2026-09-28

An independent review reproduced four defects against the committed implementation;
all are fixed with regressions in `test/continuity.test.ts`.

- [x] Return deltas examined only the latest 50 events; older work by another agent
  got no coverage and was never revisited (E42). Deltas now cover every observation
  since their basis packet.
- [x] Queued, overflowed or pre-launch-failed requests were rendered as history in
  earlier turns and made unsent packets stale (E08, E23). Only requests with a
  submitting/accepted/unknown receipt are conversation history.
- [x] The harness check ran after capture, and a retried request ID silently no-oped.
  Reachability is checked before capture; an unsent request re-runs on retry.
- [x] Superseding a checkpoint left its originals hidden. Only current checkpoints
  replace originals.
- [x] Exact CLI version pinning removed. Any reachable version runs; a 20 s
  `HarnessMonitor` probe reports reachability transitions and gates dispatch.
- [x] Usage-aware switching: resumed sessions receive only what they lack; new or
  compacted sessions get a bounded packet (recent exact tail, older headlines, full
  text on file). Model changes within a harness keep its native session.
- [x] Claude `compact_boundary` marks the binding compacted; the next packet rebuilds
  state into the same resumed session (E13 for Claude).
- [x] User-authority writes (reviewed items, checkpoints) are refused while a turn runs.

Transport (app-server / Agent SDK):

- [x] Codex on `codex app-server` JSON-RPC and Claude Code on the Claude Agent SDK,
  following t3code. The `exec --json` / `-p` transports and the MCP approval shim
  are removed; "ask" is real approvals on both, answered in-process.
- [x] Lost native session (`NativeSessionMissing`): receipt failed, binding moves to
  a new epoch, next packet reconstructs.
- [x] Context in use, model window, compaction progress and provider usage limits
  reported by both adapters and shown in the composer.
- [x] Live smoke turn per harness (codex-cli 0.153.4, claude 2.1.278).
- [ ] Cap packet size by the remaining context window. Not done: the per-agent
  reading can't tell which chat's session it measured, and the 6,000-token default
  is ~3% of current windows. Revisit for small-window models.

Later:

- [x] Linux argv limit: resolved by the transport change. Both harnesses now receive
  the prompt over stdin (Agent SDK user message, app-server `turn/start`), so the
  128 KiB `MAX_ARG_STRLEN` cap no longer applies. Linux is still untested live.
- [x] Codex compaction signal: `codex app-server` reports `contextCompaction` items;
  the binding is marked compacted like Claude's.
- [ ] Optional cheap-model summaries of referenced history (P4); headlines are the
  deterministic default.
- [ ] Local admin-token exposure: any same-user process can fetch it from
  `/api/bootstrap`. The idle guard narrows the Brain window; a per-client or
  UI-confirmed authority token is the durable fix.
