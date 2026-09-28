# Per-project runtime modules

`../runtime.ts` remains the public ProjectRuntime coordinator. It owns agent
composition, project lifecycle, execution policy, handoffs and orchestra integration.
The extracted modules are instantiated once per runtime:

| Module | Responsibility |
| --- | --- |
| `accounting.ts` | Cost accumulation, budget enforcement and quarantine |
| `agents.ts` | Live adapter instances, event subscriptions, shared startup and retirement |
| `briefings.ts` | Brain retrieval, memory import, team context, helper lifetime and handoff preparation |
| `queue.ts` | Queue dispatch, holds, quiet-time conditions, listeners and clock |
| `turns.ts` | Turn/chat association, checkpoints, diffs, commits, stale turns, retries and interruption |

Each module accepts a typed host interface containing callbacks and live
getters for dependencies owned by the coordinator. Constructors only retain
the host; they must not invoke callbacks before ProjectRuntime has completed
initialization. State is per project, never module-global.

`../runtime-support.ts` contains shared contracts and pure helpers. Existing
public types and error classes are re-exported from `../runtime.ts` to preserve
import paths and error identity. Forwarding methods preserve the public API.

Queue shutdown must stop its clock and remove listeners before closing the
log. Turn completion must preserve checkpoint/cost/chat ordering. Changes need
focused queue, costs/budgets, retry/interruption, rewind, stale-session and
runtime tests; briefing changes also need brain and team-memory coverage.

## Ownership for the Brain rewrite

- `core/events/contracts.ts` defines the journal interface consumed by Brain,
  execution and routes. `core/eventlog.ts` selects the SQLite or JSONL store and
  owns closing it. Observers receive detached events after persistence; an
  observer failure cannot turn a committed append into a failed write.
- `core/conversations.ts` owns chat metadata. Binding validation remains runtime
  policy. Deleting metadata leaves canonical history intact.
- `core/agent-state.ts` owns per-instance native state. Adapters use the protected
  `nativeState` store supplied by their base class. Native IDs are not chat IDs.
- `agents.ts` owns process-instance identity, not native session compatibility.
  Only the current instance can publish. Retirement unsubscribes immediately;
  replacement startup waits for old startup/stop to settle. Failed starts retry.
- `briefings.ts` prepares memory and a one-shot prompt; it cannot take the baton
  or send a turn. Helper/model implementations are injected at composition.
  Closing discards late extraction and semantic-load results. It does not cancel
  an already running helper subprocess; the existing helper timeout still applies.
- `../delivery.ts` owns frame serialization and audience filtering for web,
  desktop, phone and relay connections. It has no database or harness access.
  A failed socket is terminated without blocking the remaining recipients.

Storage formats, wire frames and the adapter SDK remain compatible. This does
not implement multi-session context coverage, durable handoff receipts or the
new Brain compaction policy. See [work notes](../../../docs/refactoring/BOUNDARIES.md).
