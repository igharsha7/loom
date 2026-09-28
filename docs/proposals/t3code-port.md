# Porting t3code's core into Loom

Status: plan, agreed 2026-09-28. Functionality first; UI after.

Loom takes t3code's provider and turn machinery (MIT, attributed per file) and keeps
its own app, orchestra, teams, phone client and Brain. The port is plain TypeScript;
t3code's Effect layers become classes and async functions. The differentiator is
what t3code refuses: switching provider mid-chat
([`ProviderCommandReactor`](../../../t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts):
"is bound to driver X and cannot switch to Y"). Loom's Brain makes that switch.

## Decisions

- **Port, not fork.** Loom's daemon, clients and features stay; the provider layer
  and turn lifecycle are replaced with t3code's design.
- **Warm sessions.** One live provider session per chat, reused across turns
  (app-server process, Agent SDK streaming query), with an idle reaper. Brain's
  "turn owns a process group" rule becomes turn-level settlement: a turn is settled
  when the harness reports it finished and no commands it started are running.
- **Normalized events at the adapter boundary.** Adapters emit one canonical runtime
  event stream; nothing above them branches on provider.

## What t3code has that Loom lacks

| Area | t3code | Loom today |
| --- | --- | --- |
| Adapter contract | `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`, `respondToUserInput`, `readThread`, `rollbackThread`, `compaction`, `stopSession`, capabilities | `send`, `interrupt`, `available` |
| Runtime events | ~50 normalized types: session/turn/item lifecycle, `content.delta` streaming, requests, user input, plans, diffs, tasks, hooks, account, MCP | ~10 coarse kinds, completed messages only |
| Sessions | warm, directory + reaper, per instance | one process per turn |
| Questions | structured user input, blocking and async (Codex) | `needs_input` heuristic on a trailing `?` |
| Plans | plan items, proposed plan, plan-mode exit | plan-mode briefing text |
| Revert | hidden-ref checkpoints + conversation rollback, refused when the provider can't roll back | checkpoints restore files only |
| Models | catalog per provider (`model/list`, Claude manifest), effort/thinking | free-text model override |
| Compaction | automatic + manual start | automatic only (reported) |
| Providers | instances (several accounts per driver), auth status, install/update ownership | one agent per config entry |

## Phases

Each phase ends with fakes-only tests passing and one authorized live check per
harness.

**1. Provider contract and service.** `src/providers/` in t3code's shape: a
`ProviderAdapter` interface with capabilities, the canonical `ProviderRuntimeEvent`
union (the subset Loom uses first, extended as phases need it), a `ProviderService`
that routes by instance and owns a session directory and reaper, and an ingestion
layer that projects runtime events into Loom's event log. Existing adapters are
wrapped, so nothing user-facing changes yet.

**2. Warm sessions for Codex and Claude.** Codex: one `app-server` per chat, thread
kept open, turns started and interrupted over the same connection. Claude: one
streaming-input `query()` per chat, turns pushed as user messages, `setModel` for
in-provider model switches. Turn-level settlement replaces process-group settlement
in Brain. Token streaming via `content.delta`, throttled on the websocket.

**3. Interaction parity.** Tool items with start/progress/complete and streamed
output; approvals keeping native option ids; structured user input (Claude
`AskUserQuestion`, Codex `requestUserInput`, Codex async questions); plan items and
plan-mode exit; per-turn diffs; manual compaction; model catalogs with effort and
thinking settings.

**4. Checkpoints and revert.** Hidden-ref workspace checkpoints per turn; revert
coordinated with native rollback (Codex thread rollback, Claude resume-at);
refused before touching files when the provider can't roll back.

**5. Cross-provider switching (the differentiator).** Switching provider in a chat
parks the current warm session and starts or resumes the target's, with Brain
building what the target lacks. Budget by the target's context window; offer a
switch when a usage limit is reached; revert across a provider boundary rolls back
each side it touched. Brain continuity becomes the default path, not opt-in.

**6. Provider management.** Instances (several accounts per driver), auth status,
install/update detection by owning installer, importing native session history.

**7. UI overhaul.** Built on the settled event model.

## Not ported

Relay/T3 Connect, mobile app, desktop shell, devices, voice, analytics and
marketing: Loom has its own equivalents or doesn't need them now. Other providers
(Cursor, Grok, OpenCode, Antigravity) move to the new contract after Codex and
Claude.
