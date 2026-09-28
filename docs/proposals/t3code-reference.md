# T3 Code reference for Loom

Inspected 2026-09-27. Read-only checkout: `/Volumes/Programming Vault/t3code`.
Branch: `main`. Commit: `de251fc2971a884cb5b1305ba4daf309dc8cccb0`
(`fix(web): continue onboarding after incomplete history imports (#13935)`).
Read contributor and agent instructions. No dependencies installed, processes
started, benchmarks run, or T3 source changed. This is a targeted architecture
review, not an audit of the entire repository.

## Findings and implications

### Native sessions still have provider boundaries

The [command reactor](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L688)
rejects an existing thread switching to another driver. Even instances of the
same driver must have matching `continuationIdentity.continuationKey` values.
Model selection and native session compatibility are separate concerns.

**Loom:** keep the app conversation independent of native sessions. Validate
resume compatibility per instance. Cross-harness switching needs a fresh or
compatible target session and our own source-backed handoff. This checkout does
not solve shared context for us. PR #3799 was inspected separately; do not
describe its unmerged code as behavior present here.

### Cheap helper calls through harnesses are concrete

[Model defaults](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/contracts/src/model.ts#L164)
select `gpt-6-luna` for Codex text generation and `claude-haiku-4-5` for Claude.
The [TextGeneration interface](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/textGeneration/TextGeneration.ts#L87)
provides commit messages, PR content, branch names and thread titles.

- [Codex](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/textGeneration/CodexTextGeneration.ts#L197)
  uses `exec --ephemeral`, a read-only sandbox and an output schema.
- [Claude](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/textGeneration/ClaudeTextGeneration.ts#L199)
  requests structured JSON, disables tools and slash commands, and specifies
  strict MCP configuration. Thread title calls use a temporary working directory.

**Loom:** reuse the architectural pattern for a small `ContextHelper` interface.
Summary extraction and source validation are new responsibilities. Discover
available models, bound usage, isolate helper sessions and preserve deterministic
fallbacks. A read-only sandbox alone does not mean a helper has no tools or no
access to unrelated readable files. These defaults do not prove account access,
subscription savings or identical restrictions across harnesses.

### Streaming efficiency is an explicit design concern

The [WebSocket server](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/ws.ts)
batches shell/sidebar projection events, coalesces updates by aggregate and keeps
survivors ordered by sequence. Synchronization markers cannot overtake pending
events. [Client shell state](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/client-runtime/src/state/shell.ts)
applies a batch with a single state write. Chat rendering uses a virtualized list.

**Loom:** persist canonical events independently of UI update frequency. Coalesce
replaceable projections only; preserve messages, decisions, tool outcomes and
delivery acknowledgements. Test ordering and reconnect boundaries. These are
useful performance mechanisms, not measured proof that every screen is fast.

### Electron supervises a backend process

[DesktopBackendManager](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/desktop/src/backend/DesktopBackendManager.ts)
spawns backend processes, tracks lifecycle/readiness and schedules recovery after
unexpected exits. Desktop, server and web are separate applications in the repo.

**Loom:** keep harness execution, SQLite, indexing and helper scheduling outside
the renderer. Specify startup, cancellation, shutdown and crash recovery before
moving the UI to Electron. Electron packaging alone does not provide performance.
Adopting T3's full framework stack is not required to adopt these boundaries.

### SQLite and native compaction have distinct roles

The [SQLite layer](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/persistence/Layers/Sqlite.ts)
enables foreign keys, WAL, a busy timeout and migrations. Its journal-size setting
controls retained WAL size after reset, not a hard cap on all in-flight WAL growth.

The [Claude adapter](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3628)
observes native compaction boundaries and updates usage/thread state. Observing a
native compact event does not create portable cross-provider memory.

**Loom:** SQLite remains the canonical app-owned event and continuity store;
JSONL is an export format. Preserve originals across native compaction and track
what was actually delivered to each session separately from helper summaries.

## Next work, when implementation starts

- [x] Inspect session compatibility, helper isolation, persistence and desktop boundaries.
- [x] Feed verified constraints into the [continuity plan](brain-session-continuity.md).
- [ ] Verify installed harness capabilities and helper model availability.
- [ ] Prototype sequential switching with exact user history and delivery receipts.
- [ ] Test corrections, small decisions, return-to-old-session deltas and interruption.
- [ ] Measure token overhead and continuation quality before adding vector retrieval.
- [ ] Benchmark UI streaming and backend recovery before choosing optimizations.

Pin any future T3 comparison to its commit. Read the local MIT license before
copying source and retain required attribution if code is reused. No source was
copied as part of this review.
