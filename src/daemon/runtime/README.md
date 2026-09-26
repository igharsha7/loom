# Per-project runtime modules

`../runtime.ts` remains the public ProjectRuntime coordinator. It owns agent
registration, project lifecycle, chats, handoffs and orchestra integration.
The extracted modules are instantiated once per runtime:

| Module | Responsibility |
| --- | --- |
| `accounting.ts` | Cost accumulation, budget enforcement and quarantine |
| `briefings.ts` | Brain retrieval, memory import, team context and briefing preparation |
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
