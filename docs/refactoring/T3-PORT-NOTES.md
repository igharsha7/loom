# t3code port — notes

Working notes for the port: what t3code does, where, and how Loom maps it. Paths
under `t3code/` refer to the local clone at `/Volumes/Programming Vault/t3code`
(MIT, © T3 Tools Inc.). Ported files carry an attribution header.

## Vocabulary mapping

| t3code | Loom | Note |
| --- | --- | --- |
| thread | chat (conversation) | Loom's `MAIN_CHAT` and named chats. |
| provider instance | agent config entry (`agents[].id`) | Kind plus options (bin, model, permissions). |
| driver kind | agent kind (`codex`, `claude-code`) | |
| session | one live provider session per **(chat, agent)** | t3code keys by thread alone because a thread never changes driver. Loom switches provider within a chat, so a chat can hold a parked session per agent. |
| runtime mode | permission mode | full-access ↔ bypass, auto-accept-edits ↔ auto, approval-required ↔ ask. |
| resume cursor | native session id (Codex thread id, Claude session id) | Persisted in the session directory. |

## Sources read

- Adapter contract: `t3code/apps/server/src/provider/Services/ProviderAdapter.ts`
  (capabilities: `sessionModelSwitch`, `supportsConversationRollback`,
  `promptlessTurnContinuation`; operations: start/send/interrupt/respond/
  respondToUserInput/stop/list/has/readThread/rollbackThread/compaction/stopAll;
  one `streamEvents` stream).
- Runtime events: `t3code/packages/contracts/src/providerRuntime.ts` — envelope
  `{eventId, provider, providerInstanceId, threadId, createdAt, turnId?, itemId?,
  requestId?, providerRefs?, raw?, type, payload}`; ~50 types.
- Session inputs: `t3code/packages/contracts/src/provider.ts`
  (`ProviderSession`, `ProviderSessionStartInput`, `ProviderSendTurnInput`,
  `ProviderTurnStartResult`).
- Service: `t3code/apps/server/src/provider/Layers/ProviderService.ts` — routes
  by the persisted binding; recovers a missing live session by adopting an
  existing one or restarting from the resume cursor; refuses a cross-driver
  switch (`ProviderCommandReactor.ts:690`).
- Directory: `t3code/apps/server/src/provider/Services/ProviderSessionDirectory.ts`
  — binding `{threadId, provider, providerInstanceId, status, resumeCursor,
  runtimePayload, runtimeMode, lastSeenAt}`; stopped rows kept for their cursors.
- Reaper: `t3code/apps/server/src/provider/Layers/ProviderSessionReaper.ts` — 30 min
  inactivity, 5 min sweep; skips active turns and background work.

## Decisions

- **2026-09-28.** Port, not fork; plain TypeScript, no Effect. Warm sessions.
  Codex and Claude Code only for now.
- **2026-09-28, Phase 1.** Build the foundation (contract, service, directory,
  reaper, ingestion) against a fake adapter and do not wire it into dispatch yet.
  Phase 2's warm adapters change the turn lifecycle, so a temporary bridge around
  the per-turn adapters would be thrown away.
- **2026-09-28, Phase 1.** Session directory is a JSON file under
  `.loom/providers/`, not a SQLite table: the event log has a JSONL fallback, and
  the directory must work with both.
- **2026-09-28.** Loom keeps other agents' sessions in a chat alive (parked) when
  the chat switches agent, instead of t3code's `stopStaleSessionsForThread`. The
  reaper bounds how long they stay warm.
- **2026-09-28, Phase 1.** Ingestion emits a tool's `tool_call` when the item
  **completes** (with its outcome), not when it starts. The old Claude adapter
  reported tools as they started. Phase 3 adds item start/progress to the log and
  UI; until then a long tool shows when it finishes.
- **2026-09-28, Phase 1.** A turn the provider reports as `failed` becomes an
  `error` with no `run_complete`, as t3code treats it. The old Claude adapter still
  emitted `run_complete` after an error result outside Brain; Phase 2's adapter
  follows the new rule.
- **2026-09-28, Phase 1.** Approvals keep Loom's existing cards: `ApprovalBridge`
  turns `request.opened` into a card through the daemon broker and answers with
  `respondToRequest`. t3code's native approval options (accept for session,
  accept always) arrive with Phase 3.
- **2026-09-28, Phase 1.** `ensureSession` registers a start synchronously before
  its first await, so concurrent callers always share it. A turn can finish before
  `sendTurn` returns; the service remembers each session's last finished turn so
  it never re-marks it active.

## Sources read (Phase 1, continued)

- Ingestion: `t3code/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
  — assistant and reasoning text are the streamed deltas; the completed item's
  `detail` is a whole-block snapshot used only when nothing streamed (lines
  ~1960–2260).


## Sources read (Phase 2)

- Codex runtime: `t3code/apps/server/src/provider/Layers/CodexSessionRuntime.ts` —
  `openCodexThread` (resume with `excludeTurns`, recoverable resume errors),
  `buildTurnStartParams`, server-request handlers (approvals park on a deferred,
  `acceptForSession` → session scope, permissions granted or an empty grant),
  `interruptTurn` (settle open approvals *before* `turn/interrupt`), `close`.
- Codex mapping: `t3code/apps/server/src/provider/Layers/CodexAdapter.ts` —
  `mapToRuntimeEvents` (lines ~1307–2010), `toCanonicalItemType`,
  `normalizeCodexTokenUsage` (`last.totalTokens` is the context in use).
- Claude: `t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts` — `startSession`
  (~4382: prompt queue, `sessionId` chosen up front or `resume`,
  `includePartialMessages`, `canUseTool`), `sendTurn` (~5127: `setModel`, user
  message `uuid` = turn id), `interruptTurn` (~5276: closes the session),
  `handleStreamEvent` (~2849), `handleResultMessage`, `stopSessionInternal`.
- Verified live (2026-09-28, claude 2.1.x): resuming an unknown session id makes
  `initializationResult()` reject with "No conversation found with session ID"
  within ~2 s, before any prompt is read; a fresh session initializes in ~1 s
  without a model call.

## Decisions (Phase 2)

- **2026-09-28 (superseded in Phase 3).** Phase 2 first kept process-group
  settlement for continuity turns by ending the session after each one. That
  contradicted the decided strategy: warm sessions everywhere, with turn-level
  settlement replacing the process-group rule.
- **2026-09-28, Phase 3.** Turn-level settlement for every turn: settled when the
  harness reports the turn done and no command it started (a `command_execution`
  item) is still running. The session stays warm, Brain turns included. A command
  still running after 60 s leaves a Brain turn's quiescence unknown; an ordinary
  turn moves on after 5 s (a harness can end a turn with an abandoned item). A
  background process a tool detaches is outside what the harness reports, so it is
  outside this guarantee.
- **2026-09-28.** Loom's "auto" keeps `approvalPolicy: never` for Codex (t3code's
  auto-accept-edits uses `on-request`): Loom promises auto never stops to ask.
- **2026-09-28.** A handoff briefing now rides in front of the prompt for Claude
  too (framed, as Codex always had it): a warm session's system prompt is fixed
  when it starts.
- **2026-09-28.** A failed turn outside continuity is not re-thrown by `send()`:
  ingestion already logged the error, and the error event ends the turn. Continuity
  turns still throw so Brain records the failure.
- **2026-09-28.** Claude `Bash` is reported as the canonical `shell` tool (command
  execution), like Codex. Nothing in Loom keyed on the name `Bash`.
- **2026-09-28.** Codex `item/tool/requestUserInput` is still answered empty and
  MCP elicitations declined; structured questions are Phase 3.
- **2026-09-28.** One `ProviderService` per agent working directory (not per
  project): native state already lives in the agent's directory (a worktree agent
  has its own `.loom`), and the session directory file must have one writer.

## Sources read (Phase 3)

- `t3code/apps/server/src/provider/CodexDeveloperInstructions.ts` — plan/default
  collaboration-mode prompts (ported verbatim, minus T3's browser/device blocks).
- `CodexSessionRuntime.ts` — `buildCodexCollaborationMode` (~595: mode, model,
  reasoning_effort default "medium", developer_instructions), request_user_input
  handler (~2347) and `toCodexUserInputAnswer` (~1145), permissions approval
  (`scope: "session"` on acceptForSession).
- `CodexAdapter.ts` — `toUserInputQuestions` (~883), async questions on
  `agentMessage` with `delivery: "async"` (~1694, `responseMode: "message"`), plan
  item → `turn.proposed.completed`.
- `ClaudeAdapter.ts` — `handleAskUserQuestion` (~4441: question id = question text,
  answers returned as `updatedInput.answers`), `canUseTool` (~4651: ExitPlanMode
  captured and denied, full-access allows, otherwise asks),
  `toSessionPermissionUpdates` (~311), `sendTurn` plan mode via
  `setPermissionMode` (~5179), `compaction: { type: "slash-command", command:
  "/compact" }` (~5561).
- Verified live: Claude Code's plan mode writes its plan to
  `~/.claude/plans/<slug>.md` before calling ExitPlanMode.

## Decisions (Phase 3)

- **2026-09-28.** Claude's `canUseTool` is registered in every mode (as t3code) so
  questions and plans reach Loom. Other tools: full access allows; approval-required
  asks a person; auto denies without asking (Loom's auto never stops to ask — a tool
  runs there only if Claude's settings pre-allow it, as before).
- **2026-09-28.** Tool progress is live-only (websocket `item` frames), not new log
  events: the log keeps one `tool_call` per finished tool, which is what Brain's
  evidence and the transcript read.
- **2026-09-28.** Codex plan mode is sent only when a turn is a plan turn, and the
  default mode once afterwards to leave it — not on every turn as t3code does — so
  a user who never plans gets Codex's own prompt unchanged.
- **2026-09-28.** A plan turn on a provider agent uses native plan mode (which
  changes nothing) instead of Loom's "write plans/…md" briefing; Loom writes the
  proposed plan to `plans/` itself, so the artifact stays.
- **2026-09-28.** A Claude write outside the session directory (plan mode's own
  plan file) is a tool call, not a project file edit.
