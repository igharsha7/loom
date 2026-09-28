# Native continuity implementation

`ContinuityEngine` is the execution-facing interface: capture, prepare, submit,
ingest/settle, reviewed context and diagnostics. It accepts the owning EventLog and
project identity. Native harnesses execute the turn; Brain constructs evidence.

- `contracts.ts`: strict Zod JSON shapes, inferred types, bounded parsing and hashes.
- `store.ts`: SQLite adapter sharing EventLog's connection; migrations/backup,
  ownership, requests/items/revisions, bindings/receipts and FTS.
- `engine.ts`: source/scope validation, mandatory intent, checkpoints, snapshots
  and explicit delivery transitions.
- `artifacts.ts`: flushed immutable source JSON for native file retrieval.
- `capabilities.ts`: fixture-backed version checks; unknown is unsupported.

EventLog captures a request and its original message transactionally, then publishes.
Submission intent commits before calling the harness. Receipts, rendered text and
canonical sources are separate records. Missing coverage, stale epochs, unsafe paths
or uncertain outcomes cannot silently become successful delivery. Unknown native
retention means protected intent is repeated.

Test through the engine interface. Fault tests deliberately use an independent
SQLite connection for contention/rollback. Normal tests must not run authenticated
harnesses. Run `scripts/benchmark-continuity.mjs` after `npm run build`; it creates
only its own temporary project and makes no model calls.

Read [the guide](../../../docs/brain-continuity.md),
[architecture](../../../ARCHITECTURE.md) and
[remaining gates](../../../docs/refactoring/BRAIN-TODO.md) before changing lifecycle
or deciding a source may be omitted. Helpers, compaction observation, retention/GC
and OpenCode parity remain gated.
