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
- [x] Decided (2026-10-02): continuity on by default, with every feature it
  used to refuse working alongside it (Phase 6 below).
- [ ] Web UI for the switch offer and the switch itself (Phase 7).

## Audit of Phases 1–5 (Sol, GPT 6.1 Sol via Codex) ✅ (2026-10-01)

A second agent audited the port; Claude checked each round's findings against the
code, Sol fixed them, Claude reviewed and ran the suite. Rounds 1–4 covered Phase 5
only; rounds 5–8 covered all five phases, including what earlier fixes introduced.
Findings per round: 5, 4, 6, 4, then 25, 24, 14, 10, 16, 5, 8, 11, 9, 9, 5. All fixed, each with a
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
  containment keeps its handles and retries; shutdown fences service session starts
  (attachment waits were not covered until round 15);
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
- [x] Tests: 1897 passing (plus 134 DOM). Known unrelated: `daemon.test.ts`
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
- [x] Round 10 (5 findings, all fixed): Codex child agents (spawnAgent) count
  as running until they finish, so settlement, diffs, commits, switches and
  rewinds wait for them; `.loom`/`.git` protection is case-insensitive (macOS);
  same-agent route steps wait for finalization; pre-round-9 checkpoints of
  subdirectory projects migrate into the per-project namespace (commits carry a
  `Loom-Project` trailer); completed rewinds' undo points are pruned normally.
  A turn whose writer may still be running keeps the agent busy until Stop (or
  `loom interrupt`) shuts the session down; the busy error says so.
- [x] Round 11 (8 findings, all fixed, plus a design review of Brain): Claude's
  native acceptance is a separate signal from local turn allocation, so a prompt
  that never reached Claude isn't counted as delivered; delta evidence is capped
  at the schema's 1,000; compaction starts a new epoch so pre-compaction
  deliveries aren't trusted; omitted observations stay in a backlog instead of
  the first 900; instruction fingerprints follow ancestors, local, override and
  imported files; journal-less restore pins are cleaned up; the legacy
  checkpoint migration runs once; a provider change under the same agent id
  starts a fresh session instead of reusing the old cursor.
- [x] Provider registry (decided and built 2026-10-02, before Phase 6): static
  drivers in `src/providers/builtInDrivers.ts` (Codex, Claude Code under
  `src/providers/drivers/`), a registry that validates config and owns
  instances, and per-driver continuity facts, capabilities, health, account and
  continuation identity, instruction discovery and writer fencing (opaque, not
  tied to process groups). Brain, the runtime, health and usage read from it;
  dispatch and continuity policy use driver facts. Legacy helper names and
  product/provider presentation still contain concrete names (see boundary below). Persisted data loads as
  before; unknown drivers are preserved. Shared adapter conformance suite in
  `test/providers/conformance.test.ts`. Adding a provider: adapter + driver +
  an entry in `builtInDrivers` + conformance fixtures.
- [x] Round 12 (11 findings: 4 general, 7 in the registry; all fixed): macOS
  process-group inspection retries a transient EPERM (the cause of the flaky
  process test, and of finished writers being held until Stop); instruction
  fingerprints cover Claude rules and managed CLAUDE.md and skip fenced
  examples; usage limits are keyed by driver and account; continuation
  ownership survives rebinding; default-model sessions resume on
  restart-model drivers; failed fencing during instance creation keeps the
  instance for Stop; model discovery uses the agent's own config; setup reads
  driver checks; the conformance suite checks late output, surviving writers
  and real rollback.
- [x] Round 13 (9 findings plus layering, all fixed): queue snapshots are
  versioned so an older response can't undo a newer change, and an unsaved
  queue edit survives redraws (the real cause of the flaky queue DOM test);
  concurrent disposal can't release a replacement instance; a resolved default
  model no longer restarts sessions on restart-model drivers; historical usage
  keeps the driver and account it was reported under; project `.claude/rules`
  are fingerprinted, rule scanning is bounded and ignores irrelevant entries,
  and inline code isn't parsed as an import; a project whose configured driver
  is unavailable still opens; more provider policy moved into driver records
  (what remains is listed in the notes for Phase 6).
- [x] Round 14 (9 findings and 2 flaky tests): concurrent agent Stop shares
  cleanup for attached owners; unavailable drivers reject before queue dispatch;
  rollback retains requested default models; first-mount queue reads cannot retire the current
  epoch; pre-submission Stop emits interrupted while Brain keeps its rejection;
  pending approval snapshots insert missing thread cards on mount/reconnect;
  legacy browser limits retain built-in ownership; observed continuity busy time
  resets quiet conditions; live approval cards and badge retain session permission options.
  Interrupt tests wait for turn-start events; the approval DOM test waits for
  both copies and actually submits a stale card to exercise HTTP 404.
- [x] Round 15 (5 P2 findings): Stop cancels attachment waits without a current
  turn and disposes late factory results; approval snapshots reject reads crossed
  by live events and fold cards absent after reconnect; Claude stream termination
  during initialization rejects startup instead of registering a stopped session;
  foreground busy transitions reset quiet time even while paused or between ticks;
  Codex stdin errors close RPC and reject pending/future requests. Focused fake
  regressions cover every finding. No persisted shapes or Brain engine changes.
- [ ] UI for the recovery states (pending rewind, pending compaction, a turn
  held after an unsettled writer) — Phase 7.
  Today the way out is the CLI or the API.
- [ ] Next audits go area by area (checkpoints, sessions, Brain) rather than
  across the whole port.

## Phase 6 — Provider management, and Brain on by default

Decided with the user 2026-10-02.

- [ ] Brain continuity on by default (`brain.continuity` defaults to true;
  an explicit false still turns it off).
- [ ] Parallel orchestra, parallel subagents and autonomous routes work with
  Brain on (today each is refused): each parallel worker gets its own Brain
  binding and packets; results come back into the chat as ordinary evidence.
- [ ] Memory extraction and semantic retrieval work with Brain on: an extracted
  memory becomes a candidate item sourced to its turn (never a decision by
  itself), included as labelled "remembered context" within the packet budget
  and promotable or droppable; semantic search only ranks candidates.
- [x] Model lists update automatically, as in t3code: a live per-instance
  snapshot (status, version, auth, models) refreshed at startup, on settings
  change, every 5 minutes while a client is open, and on demand; changes pushed
  to clients over the websocket. Codex from paginated `model/list`; Claude from
  the Agent SDK's reported models (not t3code's manifest file).
  Done 2026-10-03: `src/providers/probe.ts` (Codex app-server `account/read` +
  paginated `model/list`; Claude SDK initialization with a never-yielding
  prompt, no session file, hooks or MCP), `src/providers/snapshots.ts`
  (refresh at open, on config save, every 5 min while a client watches, and
  `POST /api/projects/:id/provider-status/refresh`; failed probes keep the last
  models), `provider_status` frames, and the model picker re-rendering live.
  Live check: Codex 8 models in ~1 s, Claude 12 in ~2 s, both with sign-in,
  no turn taken and nothing left running. Tests set `LOOM_PROVIDER_PROBES=0`.
- [x] OpenCode as a registry driver. Upstream main (#213, merged 2026-10-03)
  added native continuity for OpenCode inside the legacy
  `src/adapters/opencode.ts`, with a hard-coded native-kind list. On this
  branch a native kind is a registry driver with a `ProviderAdapter`, so the
  merge kept the registry checks and the feature waits for this item: an
  OpenCode driver and adapter ported from t3code's
  `provider/Layers/OpenCodeAdapter.ts`, reusing upstream's verified opencode
  1.18 protocol (session per binding, admission as acceptance,
  `/api/session/active` for quiescence, `session.next.*` events, `baseUrl`
  health) and its fake server (`test/opencode-fake.ts`). Done when
  `test/opencode-continuity.test.ts` runs unskipped.
  Done 2026-10-03: `src/providers/opencode/adapter.ts` and
  `src/providers/drivers/opencode.ts`; the legacy `src/adapters/opencode.ts` is
  gone. One warm `opencode serve` per agent (or `baseUrl`), a session per chat,
  Loom-chosen `msg_` ids as turn ids, admission as acceptance, leaving
  `/api/session/active` as settlement (writers finish inside the session),
  permission and question requests answered through Loom, manual compaction,
  conversation rollback by `revert/stage` + `commit` (files stay with Loom's
  checkpoints), late events attributed by reply id, and the model catalogue as
  OpenCode reports it (provider, free models, Zen/Go). "Ask" mode stays
  unsupported (upstream saw the headless API ignore deny rules). Tests: 20 in
  `test/opencode-continuity.test.ts` and the 12 conformance scenarios via a
  scripted fake `opencode` CLI (`fakeOpenCodeCli`). Not yet run against a live
  model: revert and permission replies are checked against 1.18.34's `/doc`.
- [ ] Instances: several accounts per driver (the registry's continuation and
  account identity), auth status, install/update detection, native session
  history import.

### From t3code's October update (83 commits, de251fc29..4804036e0)

Reviewed 2026-10-03. t3code is the reference for each item.

**MCP.** Loom already hands the project's own MCP servers to both harnesses
(`src/core/mcp.ts`; Codex `mcp_servers.<key>` config on `thread/start`, Claude
SDK `mcpServers`). Missing:

- [ ] MCP elicitations. Loom declines every `mcpServer/elicitation/request`
  (`src/providers/codex/adapter.ts`). t3code surfaces form-mode elicitations as
  an approval with Approve / allow for session / always allow, builds the
  response content from the form schema, and declines URL mode
  (`CodexSessionRuntime.ts` `toMcpElicitationResponse`). The Claude SDK side
  needs the same through its elicitation callback. The popup is Phase 7.
- [ ] Refresh Codex's MCP tool list before each turn when MCP servers are
  configured (`config/mcpServer/reload`), so a server added mid-chat is seen
  without restarting the session.
- [ ] Surface `mcpServer/oauthLogin/completed` and MCP server status, so a server
  that needs sign-in says so instead of failing silently.
- [ ] A Loom MCP server for agents, like t3code's `t3-code` server: an HTTP MCP
  endpoint in the daemon, a per-chat bearer credential with capabilities, and
  injection per process (Codex `-c mcp_servers.loom.url=…` with
  `bearer_token_env_var`, Claude SDK `mcpServers` with an `Authorization`
  header), revoked when the session ends. Never written to the user's provider
  config. t3code's toolkits are preview, devices and pull requests; Loom's
  would start with what agents now do through prose or the CLI: link a PR to
  the chat, ask the orchestra or team, read Brain's briefing.
- [ ] Restart a chat's session on request to load new skills, plugins and MCP
  servers (t3code 921cb3c8b, a cmd+k action). Under Brain this is a
  reconstruction packet into the new session.

**Subagents.** Loom shows a subagent as one `collab_agent_tool_call` item and
drops subagent narration. t3code models each one as a task:

- [ ] Canonical `task.started / task.progress / task.updated / task.completed`
  events with a task id and linkage (title, role, model, effort, agent path,
  parent task for nested agents), status `running / waiting / idle / completed
  / failed / cancelled / interrupted`, and `timelineBypass` so rows stay out of
  the parent chat's text.
- [ ] Claude: identity from `task_started`, attribution by
  `parent_tool_use_id`, the subagent's own model from its assistant snapshots
  (t3code 7ab800a43: snapshots can arrive before `task_started` and nested
  agents' tool calls arrive only as snapshots, so buffer both, capped).
- [ ] Codex: the multi-agent v2 child-thread notifications mapped to the same
  task events (t3code's synthetic `collabAgent/*` events); a finished child turn
  is idle and resumable, not terminal.
- [ ] Token usage records whether a turn had subagents, so context-window
  reporting doesn't count their tokens against the parent's window.
- [ ] Brain: a subagent's result reaches the chat as ordinary evidence, the same
  rule as parallel orchestra workers above.

**Git worktrees.** Loom has worktrees per orchestra worker and per agent
(`git.worktreePerAgent`, `agent/<id>`), not per chat. t3code gives each thread
an optional worktree and branch:

- [ ] A chat can run in its own worktree: created on a temporary branch
  (t3code's `t3code/<8 hex>`), renamed to a generated branch name after the
  first turn, and the session's cwd follows it. Brain bindings must carry the cwd,
  so a switch to another provider in the same chat lands in the same worktree.
- [ ] Before each turn, recreate a worktree whose directory was deleted
  (`git worktree prune`, then `add` from the branch), instead of failing the
  turn.
- [ ] A workspace lease per checkout, so a turn starting and a worktree being
  removed never overlap, including orchestra workers sharing a repo.
- [ ] A per-project setup script run when a worktree is created, and submodules
  initialised (`git worktree add` leaves them empty).
- [ ] Cleanup rules: remove worktrees after N days, when merged, when the chat
  is deleted, or when unchanged; never one with uncommitted work.
- [ ] Agents told where they are: the chat's instructions name the worktree and
  branch, and that other chats work elsewhere (what orchestra workers already
  get).

**Fixes to port.**

- [ ] Claude results for another turn (t3code 9da066dbe). Claude runs turns of
  its own between prompts (background tasks reported after resume, peer
  messages). Loom's Claude adapter completes the active turn on any `result`,
  so `/compact` or a queued prompt can end early and leave the chat busy. Match
  `user_message_uuids` / `user_message_uuid` against the turn id, and treat a
  result with a non-human `origin` as not the user's.
- [ ] Codex 0.159 protocol bindings (t3code 422248515): check Loom's Codex
  method and field names against them.
- Phase 7 (after this): UI in Loom's own look, inspired by t3code, including
  question, permission and approval popups.

## Phase 7 — UI overhaul

- [ ] Thread: grey out or fold the turns a rewind dropped (the `rewound` checkpoint
  event carries `chat` and `conversation`); a proper "files only / files and
  conversation" choice in place of the confirm dialogs.
- [ ] One live text path for provider agents: upstream now sends their text both as
  `delta` frames and as `stream` frames (see notes, upstream changes).

### Follow-up audit — 2026-10-02

- Fixed concurrent disposal with a shared, retryable fencing promise and owner-checked release.
- Sessions persist optional `runtimePayload.requestedModel` (string or null), separately from the adapter-resolved model. Legacy bindings still load; an ambiguous legacy default adopts the existing cursor rather than discarding it.
- Queue HTTP and socket snapshots share a volatile epoch/revision; queue files are unchanged. Browser snapshots preserve the editing DOM node, draft, focus, selection and scroll.
- Historical limits resolve historical provider/driver ownership, never the current agent kind. Ambiguous custom limits labels now carry optional `driverKind` and reached scope in new events; old events still replay with legacy label inference.
- Instruction source paths belong to built-in driver records; the observer is generic. Claude covers ancestor project rules and user rules, imports, inline/fenced code exclusion. Scans bound entries (10,000), directories (1,000), depth (32), elapsed time (1s) and file/content bytes. Supported symlinks are bounded and deduplicated, including outside-tree links; broken irrelevant links do not block. Codex does not scan Claude sources. Observations are re-read at safety boundaries, not cached across preparation/submission.
- Unavailable saved drivers materialize an unavailable adapter: project/status/recovery still open, enabled state/config/bindings remain, normal disable/remove/reassign paths work.
- The queue edit/reorder/delete/pause DOM test uses held conditions rather than a timed busy turn.
- Driver records now own built-in memory paths, vendor/aliases/briefings, orchestration priority/options, setup hints, usage window labels, and internal Claude CLI/API transports for extraction and observability. Legacy exports remain facades. Brain engine selection and prompts are unchanged.

The boundary is behavioral, not a claim that every provider name has vanished.
Phase 6 deliberately retains: ADE product catalogs and browser labels/icons,
runner credential mount provisioning, legacy provider-name compatibility facades
and historical label migration, operator-selected internal engine defaults,
non-registry Antigravity/OpenCode/Grok/bridge policy, provider management/login UI,
and real remote drivers. Runner credential setup is infrastructure provisioning,
not session dispatch or continuity ownership. These retained items do not route
native cursors or determine native settlement/limits policy.
