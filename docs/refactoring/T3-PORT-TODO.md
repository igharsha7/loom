# t3code port — TODO

Plan: [t3code-port.md](../proposals/t3code-port.md). Notes and sources:
[T3-PORT-NOTES.md](T3-PORT-NOTES.md). Scope for now: **Codex and Claude Code only**;
relay, mobile and other providers are out of scope.

Rules: phase by phase, fakes-only tests at every step, one authorized live check per
harness per phase, and never modify a provider's own config (`~/.codex/config.toml`,
Claude settings); override per session through the protocol instead.

## Phase 1 — Provider contract and service ✅ (2026-09-28)

- [x] `src/providers/contracts.ts`: provider kinds, runtime modes, session and turn
  inputs, capabilities, normalized item data, and the canonical runtime event union
  (26 types), ported from t3code `packages/contracts/src/provider*.ts`.
- [x] `src/providers/adapter.ts`: the `ProviderAdapter` interface and `EventHub`.
- [x] `src/providers/errors.ts`: `ProviderError` (validation, not_found,
  session_missing, unsupported, request, transport) with `notSubmitted`.
- [x] `src/providers/directory.ts`: session directory keyed by (chat, agent), in
  memory and as an atomic JSON file; unreadable files moved aside.
- [x] `src/providers/service.ts`: `ProviderService` — register/unregister,
  ensureSession (live / resumed / fresh, shared concurrent start, lost session →
  `session_missing` or fresh on request), sendTurn, interrupt, respond, compact,
  rollback, stop, stopAll, event fan-in keeping the directory and active turns.
- [x] `src/providers/reaper.ts`: idle reaper (30 min / 5 min; skips running turns
  and caller-reported background work).
- [x] `src/providers/ingestion.ts`: canonical events → Loom log events; streamed
  text assembled per item with completed-item fallback; live delta channel; Brain
  tags per turn; large command output to artifacts.
- [x] `src/providers/approvals.ts`: `request.opened` → Loom approval cards → answer
  through the service; cards close when the turn or session ends.
- [x] Fake adapter and tests (`test/providers/`, 45 tests). Full suite green.
- [x] Docs: ARCHITECTURE owner rows; notes.
- [ ] Live check: none this phase — nothing is wired to a real harness yet.

## Phase 2 — Warm sessions for Codex and Claude ✅ (2026-09-28)

- [x] Codex adapter on the contract (`src/providers/codex/`): one `app-server` per
  chat session in its own process group, thread kept open, turns and interrupts on
  one connection; notifications, deltas and server requests mapped to canonical
  events (t3code's `mapToRuntimeEvents`, `toCanonicalItemType`,
  `normalizeCodexTokenUsage`); approvals wait for `respondToRequest`; manual
  compaction (`thread/compact/start`).
- [x] Claude adapter on the contract (`src/providers/claude/`): one streaming-input
  `query()` per chat session, session id chosen up front, `initializationResult()`
  proves the session (a lost resume fails here, before any prompt), turns pushed as
  user messages, `setModel` in-session, `canUseTool` → `request.opened`, partial
  messages → deltas, interrupt closes the session (t3code's hard boundary).
- [x] Runtime dispatch: `ProviderAgent` (`src/providers/agent.ts`) is the runtime's
  Adapter for `codex` and `claude-code`; one `ProviderService` per working
  directory with the file directory, reaper and approval bridge. `SendInput.chat`
  added; sessions keyed by (chat, agent). Old per-turn adapters deleted
  (`adapters/codex.ts`, `adapters/claude-code.ts`); `codex-rpc.ts` moved to
  `providers/codex/rpc.ts`. The pre-warm per-agent session id migrates to the main
  chat's binding. A rebuilt agent (model/permission change) takes over its
  predecessor's sessions. MCP server changes restart and resume the session.
- [x] Brain: turn-level settlement — a turn is settled when the harness reports it
  done and no command it started is still running; the session stays warm.
  (Phase 2 first shipped "a continuity turn ends its session"; corrected in Phase 3
  to the decided turn-level rule. See notes.)
- [x] Token streaming: `content.delta` → `LiveDeltaThrottle` (50 ms) → `delta`
  websocket frames; a minimal streaming bubble in the web thread, replaced by the
  finished message.
- [x] Tests: `test/providers/warm.test.ts` (16), throttle test; fakes serve many
  turns per process (`scripts`, `turnsOf`); existing Codex/Claude/MCP/continuity
  tests run against the warm agent. Full suite green.
- [x] Live check per harness (read-only mode, scratch project): Codex
  (`gpt-6-astra` override; `~/.codex/config.toml` untouched) and Claude each ran one
  turn; session stayed warm after the turn, the reply streamed as a delta, the
  process group was gone after stop.

## Phase 3 — Interaction parity ✅ (2026-09-28)

- [x] Tool progress: `item.started/updated/completed` → live `item` websocket frames
  (a "running" row in the thread), command output as live deltas; the finished tool
  is still one `tool_call` in the log.
- [x] Approvals with native options: `request.opened.options` (Allow / Allow for this
  session / Deny); Loom cards gain "Allow for session" when offered; Codex gets
  `acceptForSession`, Claude gets its own permission suggestions scoped to the session.
- [x] Structured user input: Codex `item/tool/requestUserInput` (answers
  `{id: {answers: []}}`), Codex async questions (answer with the next message),
  Claude `AskUserQuestion` via `canUseTool` (answers keyed by question text).
  `needs_input` carries `questions`, `requestId`, `responseMode`; answered via
  `POST /api/projects/:id/agents/:agent/answers`; question cards in the thread.
- [x] Plan mode: Codex collaboration mode (t3code's developer instructions, ported
  in `providers/codex/instructions.ts`), left on the next default turn; Claude
  `setPermissionMode("plan")` and `ExitPlanMode` captured as the proposed plan.
  Loom's plan turns on provider agents use native plan mode; the runtime saves the
  proposed plan to `plans/<day>-<slug>.md` (`status: plan_saved`).
- [x] Manual compaction: Codex `thread/compact/start`; Claude `/compact` as a turn
  (t3code's slash-command compaction). `POST /api/projects/:id/agents/:agent/compact`.
- [x] Reasoning effort: agent option `effort` → Codex `turn/start.effort`, Claude
  query `effort` at session start.
- [x] Turn-level settlement (correction of Phase 2), bounded: 60 s for Brain turns
  (then quiescence unknown), 5 s for ordinary turns.
- [x] Tests: `test/providers/interaction.test.ts` (13),
  `test/providers/runtime-interaction.test.ts` (2). Full suite green.
- [x] Live check (read-only, scratch project): a plan-mode turn on each harness.
  Codex explored with one command and proposed a plan (captured). Claude wrote its
  plan to its own `~/.claude/plans/` file and called ExitPlanMode (captured); the
  project was untouched. Found and fixed: that plan file was logged as a project
  edit.
- Moved: model catalogs (`model/list`, `supportedModels()`) to Phase 6 (provider
  management). Per-turn diffs: Loom's own `turn_diff` (git, per turn) already covers
  both providers; Codex's `turn.diff.updated` is mapped but not yet shown.

## Phase 4 — Checkpoints and revert ✅ (2026-09-29)

- [x] Hidden-ref checkpoints per turn: already Loom's (`core/checkpoint.ts`, #101).
  The checkpoint event now records the chat whose turn it precedes.
- [x] Turn ledger: each (chat, agent) binding records its native turns (id and start
  time) in `.loom/providers/sessions.json`, complete from the session's start (or
  from when the ledger began, for older bindings).
- [x] Contract: `rollbackThread(threadId, beforeTurnId)` → `{ resumeCursor, live }`
  (t3code counts turns; Loom names the first turn to drop). Service:
  `planRollback` (no files touched; refuses when unsupported or when the turns
  since are not on record) and `rollbackConversation`.
- [x] Codex: `thread/revert` before the turn; on a thread that refuses it (codex-cli
  0.153.4: "only supports paginated threads"), `thread/read` + deprecated
  `thread/rollback` with the counted turns. The session stays warm.
- [x] Claude: `getSessionMessages` finds the turn's user message (uuid = turn id),
  `forkSession` up to the message before it, the session ends, and the next turn
  resumes the fork. A turn compaction replaced is refused.
- [x] Rewind: `rewind(id, { conversation })` plans every provider agent's rollback
  in the checkpoint's chat, refuses (409 `conversation_refused`) before files move,
  restores files, rolls back, and logs `checkpoint · rewound` with `chat` and
  `conversation`. Whole-session drops forget the binding (next turn starts fresh).
  CLI `loom rewind --files-only`; the web app offers files-only when refused.
- [x] Tests: `test/providers/rollback.test.ts` (10), service tests updated. Full
  suite green.
- [x] Live check (read-only, scratch git projects): BLUE, then RED, roll back
  before RED, ask for the codewords. Both answered "BLUE". Codex (`gpt-6-astra`
  override) went through the `thread/rollback` fallback and stayed on one
  app-server. Claude resumed the fork. Projects untouched.
- [x] Projects without git (or with no commit yet): checkpoints in Loom's own store,
  a bare repo at `.loom/checkpoints.git` driven with `GIT_DIR`/`GIT_WORK_TREE`.
  Capture, rewind, one-file restore and undo work as in a repository; the turn's
  diff card comes from the checkpoint (`checkpoints.diffSince`). Default excludes,
  a new-content cap (20k files / 256 MB, listing ≤ 15 s), and `gc --auto` after
  pruning. The same for Codex and Claude; Claude's SDK file checkpointing
  (`enableFileCheckpointing` / `rewindFiles`) is deliberately not used. Tests:
  5 in `test/checkpoint.test.ts`, 1 runtime test in `rollback.test.ts`. No extra
  live check: the store is harness-independent and was tested against real git,
  and the native rollback was already checked live.
- Not done: other chats' conversations are left alone even though their files were
  put back too (decided; see notes). An undo of a rewind restores files only.

## Phase 5 — Cross-provider switching (with Brain continuity on) ✅ (2026-09-30)

- [x] Park/resume across providers within a chat: each (chat, agent) keeps its own
  warm session; switching away leaves it parked (warm until the reaper), and a
  switch back gets a delta on the same session. Brain builds a reconstruction for
  a target whose session is new, including the other agent's work.
- [x] `switchChat(chat, agentId, { resend })` + `POST /api/projects/:id/chats/:chat/switch`:
  stops the outgoing turn in that chat, moves Main's baton or re-pins the chat,
  logs `chat_switched`; `resend` sends the chat's last message to the new agent.
- [x] Packet sized by the target's context window: `packetBudget(kind, window)` =
  10% of the last reported window (defaults: Codex 272k, Claude 200k), clamped to
  6k–40k, instead of a fixed 6000.
- [x] Switch offered at a usage limit: a `usage_limits` report with `reached` logs
  `status · switch_suggested` (provider, limit, resetsAt, alternatives on another
  provider whose limit isn't reached), once per agent and limit per turn. Works
  with continuity on or off.
- [x] Rewind × Brain (Phase 4 carry-over): checkpoints record the turn's message
  (`turnEvent`); the `rewound` event records `dropped.from`; Brain's queries
  (protected user sources, observations, holes) skip dropped ranges; Brain's
  bindings follow the session a rollback left (`followRollback`), which fixes a
  Claude rewind being undone by the next continuity turn.
- [x] Tests: `test/providers/switching.test.ts` (8 at first, 48 after the audit). Full suite green.
- [x] Live check (read-only, scratch git project, continuity on): one chat
  Codex (`gpt-6-astra`) → Claude → Codex. Claude answered BLUE from a
  reconstruction packet; Codex answered BLUE from a delta on its parked session.
  Project untouched.
- [ ] Open decision: continuity on by default. Continuity today refuses parallel
  orchestra and turns off semantic briefings and memory extraction, so switching
  it on for everyone changes those features. Without it, a switched-to agent
  starts the chat with no history. Needs the user's call.
- [ ] Web UI for the switch offer and the switch itself (Phase 7).

## Audit of Phases 1–5 (Sol, GPT 6.1 Sol via Codex) ✅ (2026-10-01)

A second agent audited the port; Claude checked each round's findings against the
code, Sol fixed them, Claude reviewed and ran the suite. Rounds 1–4 covered Phase 5
only; rounds 5–8 covered all five phases, including what earlier fixes introduced.
Findings per round: 5, 4, 6, 4, then 25, 24, 14, 10, 16. All fixed, each with a
regression test.

- [x] Phase 5: dropped turns are named explicitly (`dropped: { from, turns, keep }`
  from the turn's `before_turn` checkpoint, or a `turn_association` status when
  no checkpoint could be taken); switching holds the queue with a counter (never
  the user's pause) and refuses sends, enqueues, rewinds and handoffs that
  straddle it; inferred queue targets carry `followsChat`.
- [x] Checkpoints: restore touches only captured paths, never `.loom`/`.git`,
  refuses symlinked parents and ignored files, keeps the user's index, works in
  linked worktrees and repo subdirectories, treats git failures as failures, and
  takes literal filenames (also in auto-commit staging). Turn diffs compare
  content, so edits to already-dirty files count.
- [x] Sessions and settlement: Brain's writer lease, diffs, commits and routes
  wait for command settlement; Claude no longer invents completions for
  unfinished commands; Stop before or during submission is honoured; a failed
  containment keeps its handles and retries; shutdown fences pending starts;
  late events keep their own chat and run.
- [x] Rewind recovery: an interrupted rewind is journalled and holds dispatch
  until it is retried, undone, or finished `--files-only`; a manual compaction is
  owned until it completes, released by Stop, `loom interrupt`, shutdown, or
  `loom recover-compaction`. Disabled agents' sessions and Brain bindings are
  rolled back too, per workspace.
- [x] Interaction: structured answers count as user evidence and resolve the
  question everywhere (routes, status, reloaded cards); multi-select questions;
  Codex file-read approvals; sparse Claude and Codex limit reports; per-window
  limit state.
- [x] Tests: 1764 passing (plus 132 DOM). Known unrelated: `daemon.test.ts`
  "real models" depends on the live Codex catalog; `app-queue-dom` is
  occasionally flaky. `codex.test.ts` "interrupts the running turn" failed once
  under full-suite load and couldn't be reproduced (6 runs alone, 2 full runs).
- [x] Round 9 (all phases, deepest on checkpoints; 16 findings, all fixed):
  per-turn auto-commit no longer commits the user's staged work (it skips the
  commit when a touched file has staged changes); sibling projects in one repo
  keep separate checkpoint refs and pruning; undo of an interrupted rewind
  restores into the journalled checkout, and a failed retry keeps the journal;
  a files-only release with the checkout gone succeeds with `recoveryReleased`;
  Claude background Bash/agents count as running until their task ends; an
  unsettled legacy turn is stopped before ownership is released, and Stop
  cancels a turn still being prepared; switching honours pending journals;
  routes wait for diff/commit finalization; submodules and embedded repos report
  `checkpoint_unavailable`; a tracked `.loom/log.db` no longer invalidates
  Brain's packets; large restores batch git work (20k paths in seconds) and
  oversize patches keep the file list.
- [ ] UI for the recovery states (pending rewind, pending compaction) — Phase 7.
  Today the way out is the CLI or the API.
- [ ] Next audits go area by area (checkpoints, sessions, Brain) rather than
  across the whole port.

## Phase 6 — Provider management

- [ ] Instances (several accounts per driver), auth status, install/update
  detection, native session history import.

## Phase 7 — UI overhaul

- [ ] Thread: grey out or fold the turns a rewind dropped (the `rewound` checkpoint
  event carries `chat` and `conversation`); a proper "files only / files and
  conversation" choice in place of the confirm dialogs.
- [ ] One live text path for provider agents: upstream now sends their text both as
  `delta` frames and as `stream` frames (see notes, upstream changes).
