# Brain-ready module boundaries

## Native continuity implementation

The prerequisite refactor below is complete. The opt-in native path now lives in
`src/core/continuity/` and is integrated through RuntimeTurns. See
[current architecture](../../ARCHITECTURE.md), [native continuity](../brain-continuity.md)
and [remaining gates](BRAIN-TODO.md). SQLite mutations stay on EventLog's existing
connection. Packet assembly and dispatch do not create another database writer;
client diagnostics remain downstream of persistence. Legacy behavior is available
when continuity is disabled.

## Objective

Prepare Loom for the Brain continuity rewrite without changing its framework,
client protocols, persisted history, or native harness behavior. This is the
prerequisite work in `docs/proposals/brain-session-continuity.md`, not the new
continuity implementation. Work stays on `dev/Harsha`.

## Work checklist

- [x] Read contributor instructions and trace current ownership.
- [x] Separate event contracts from SQLite/JSONL implementations; retain the
  public EventLog entrypoint and test both backends.
- [x] Give conversation metadata its own storage module; preserve implicit Main,
  chat bindings, deleted-chat history and existing state.json compatibility.
- [x] Isolate native adapter state behind per-instance storage; keep native IDs
  separate from app conversation IDs and preserve existing resume data.
- [x] Give adapter subscriptions/startup/retirement explicit lifecycle ownership;
  reject events from replaced instances and prevent duplicate startup.
- [x] Isolate Brain helper dependencies and handoff preparation from execution;
  prevent background extraction from writing after shutdown.
- [x] Centralize client delivery and scope filtering; a failed client must not
  break persistence or delivery to another client.
- [x] Add meaningful lifecycle/compatibility regressions, run focused tests,
  typecheck, build and broader tests; record results and remaining limitations.

## Invariants

- Persist original events before notifying consumers. UI delivery is an observer.
- Brain depends on an event interface, not a storage implementation or UI.
- Native adapters translate harness behavior; they do not manage conversations.
- Runtime coordinates execution, permissions, baton and working-tree ownership.
- Shutdown/retirement invalidates subscriptions and late helper results.
- No paid verification, framework migration, new summarizer or vector model.
- Existing direct-model and bridge features remain compatible; removing them is
  a separate product migration, not a prerequisite for these seams.

## Findings

- The previous extraction left chat storage and handoff preparation in runtime.
- Five harness adapters duplicate state.json reads/writes for native sessions.
- Replaced adapters retain callbacks and model replacement retains started state.
- Brain extraction and semantic startup can outlive the project log.
- WebSocket fanout repeats scope logic and allows one send failure to escape.

## Verification

- Initial focused run was blocked by sandbox loopback restrictions. Re-ran with
  local socket access: 112 tests passed; subsequent expanded run: 129 passed.
- `npm run build`: passed, including browser assets and TypeScript compilation.
- Full `npm test`: backend passed 1,357 tests, 17 skipped; all 125 DOM tests
  passed. Total: **1,482 passed, 17 skipped**, with no failed suites.
- Final `npm run typecheck`, `git diff --check` and whitespace checks on new
  files: passed. No paid provider checks or Electron GUI runs were performed.
- Temporary logs: `/tmp/loom-boundary-focused.log`,
  `/tmp/loom-boundary-build.log`, `/tmp/loom-boundary-full.log`.

Completed on 2026-09-27. The prerequisite checklist above is complete; the next
work is the sequential Brain continuity flow described in the proposal.

## Resulting ownership

| Responsibility | Owner | Callers depend on |
| --- | --- | --- |
| Canonical event persistence | `core/eventlog.ts`, `core/events/*` | EventJournal/EventReader; existing EventLog facade remains public |
| App conversation metadata | `core/conversations.ts` | Chat operations; runtime validates bindings |
| Native resume/process metadata | `core/agent-state.ts` | Per-instance read/patch via AdapterBase |
| Configured live adapter instances | `daemon/runtime/agents.ts` | Install/start/retire/close; read-only roster |
| Context selection and preparation | `daemon/runtime/briefings.ts` | Prepared memory/briefing and injected helper implementations |
| Execution and workspace policy | ProjectRuntime and RuntimeTurns | Existing runtime commands |
| Client frame delivery | `daemon/delivery.ts` | Project/log/admin audiences and transport connections |

## Correctness fixes included

- A failed event observer cannot make a durable append appear to fail or stop
  later observers. Caller/subscriber mutations cannot alter canonical history;
  SQLite and JSONL both return detached data. Closing is idempotent.
- Retired instances are unsubscribed immediately. A replacement waits for the
  predecessor's startup/stop and has independent startup state. Concurrent starts
  share one attempt; failed attempts can retry.
- Turn preparation counts as active work for replacement and hot reload. A
  startup/send failure releases the reservation and records its error in the
  originating chat. Dispatch refuses an instance retired during asynchronous work.
- Brain extraction discards cancelled results before applying memory operations.
  Semantic load completion cannot re-enable a disabled or closed channel.
- OpenCode's asynchronous orphan check updates only its own latest state slot;
  it no longer writes an old snapshot over intervening chat/baton changes.
- Socket send failures are isolated for project, terminal, log and team frames.

## Deliberately retained / next phase

- State.json remains the metadata format; SQLite/JSONL event history is unchanged.
  A migration to the proposed Brain SQLite schema needs its own migration tests.
- Native sessions are still scoped as before (configured instance + working
  directory). Mapping multiple native sessions to one app chat, provider resume
  compatibility, handoff receipts and coverage are next-phase work.
- Context selection still uses the legacy windows/extraction policy. These
  changes establish ownership, not a promise that switching preserves every detail.
- Helper cancellation discards results; it does not kill the existing helper
  process. Its configured timeout still applies. Already running native work
  depends on each adapter's stop implementation; no universal hard-kill policy
  has been introduced.
- No Electron migration, UI batching/virtualization change, model download,
  benchmark, paid agent verification, or removal of existing integrations.
- The T3 Code checkout is unchanged. No source was copied from it.
- The boundary work is now committed at
  `584a3b6a86bfa9af2a0a8ecbeac57e6aa4578e7a`. The next Brain plan is in
  [brain-continuity-implementation.md](../proposals/brain-continuity-implementation.md);
  implementation awaits user review. Planning work does not publish changes.
