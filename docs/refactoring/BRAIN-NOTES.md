# Brain research and edge-case notes

Updated: 2026-09-28. The user approved implementation. The deterministic
native path is implemented behind an opt-in flag; remaining gates are tracked in
[BRAIN-TODO](BRAIN-TODO.md).
The following are verified documentation observations or explicitly proposed
Loom behavior, not results from live harness tests.

## Implementation receipt — 2026-09-28

User approval: “Alright, implement it”; subsequent instruction: update architecture
and docs as well. Work remains on `dev/Harsha`, with no new commit or push requested.

Implemented `core/continuity/` for strict Zod 4.6.5 contracts, transactional SQLite
state on the existing event connection, scoped sources and reviewed item revisions,
FTS/backfill/fallback, immutable packets, exact render hashes, per-chat native bindings,
workspace fencing, receipt transitions and conservative unknown-outcome recovery.
`RuntimeTurns` integrates sequential sends/queues, frozen models/targets, preparation
cancellation and cleanup. Codex/Claude inject ordinary turn context, use explicit
scoped IDs, correlate native events and await process close on interruption.

Design refinements from the proposal:

- Packet sections use one typed `items` union (`instruction`, `decision`, `correction`,
  `topic`, `pending`) instead of parallel arrays. Status/revision/source evidence and
  supersession remain explicit. This is the first wire version, not a migration
  of an already published packet interface.
- Native retention remains unknown. Unprocessed user intent and reviewed current
  items are repeated; return deltas reduce optional native/agent observations.
  This deliberately favors fidelity over speculative subscription savings.
- Source-backed deterministic compaction requires explicit user review. No implicit
  classifier decides that a tiny preference or unresolved question can be dropped.
- Immutable local source JSON is the harness retrieval path, alongside scoped
  authenticated HTTP for clients. It needs no daemon credential in the prompt and
  works through normal local file tools. Private filesystem isolation is not claimed.
- Activation uses `VACUUM INTO` before migration, avoiding an unsupported assumption
  about newer Node backup APIs. No WAL/network-share durability claim is made.
- Runtime profiles are conservative checked CLI versions. Unknown versions,
  attachments, OpenCode/bridges and parallel coding are explicitly unsupported.
  Optional helpers stay disabled rather than launching an unverified account mode.

Migration: `loom brain:migrate` is offline, backed up, restartable/idempotent and
preserves event IDs. Distinct ID collisions/torn records fail before partial import.
The original JSONL remains readable. Returning to an older JSONL reader requires
explicit reconciliation of later SQLite writes; automatic downgrade is not shipped.
Artifacts finalize before packet references; orphan GC/deletion remains pending.

Verification so far:

- 27 new core/storage/HTTP/artifact tests passed, plus two native adapter regressions.
- Latest affected group: 93 tests passed across continuity, storage, HTTP, lifecycle,
  event stores and Codex/Claude adapters. No authenticated model calls.
- Full non-DOM suite: 1,384 passed, 17 skipped before the final two adapter tests;
  affected tests re-run after subsequent edits.
- Browser suite initially: 124 passed, one board-control timing failure before the
  modal opened. Existing `ready()` helper now waits for the board control to be wired;
  rerun passed all 125 tests across 12 browser suites.
- Build/typecheck pass. Whitespace checks pass; final affected checks are recorded below.

[Recorded benchmark](brain-benchmark-2026-09-28.json): Node 24.3.0, macOS arm64,
Apple M4/16 GiB, 10,001 source events, 20 buried user points, 30 preparations, no Git
and no paid calls. Added context 3,034 heuristic tokens versus exact replay 258,978.
All buried points included; the legacy last-400 slice omitted the first point.
Preparation p50 19.0 ms / p95 25.6 ms; retrieval p95 0.76 ms; event-loop p95 19.5 ms;
process RSS ~114 MiB; benchmark project disk ~4.61 MiB. Native understanding/usage
is not measured. This is a daemon benchmark, not an Electron or end-to-end provider benchmark.

Initial same-hardware regression thresholds for this frozen corpus: preparation
p95 <100 ms, retrieval p95 <5 ms, loop p95 <25 ms, all 20 protected points included,
and no inference process/helper calls. Git-heavy workspaces, 100k+ events, cold-start
migration, pathological mandatory overflow and real native continuation quality
still need separate baselines. Current evidence does not justify introducing a
worker with a synchronous bridge; revisit after those measurements.

Current architecture and user behavior are documented in
[ARCHITECTURE.md](../../ARCHITECTURE.md), [native continuity](../brain-continuity.md)
and [CONTRIBUTING.md](../../CONTRIBUTING.md). Remaining checklist items are intentional
release gates, not represented as complete by the implementation or UI.

## 1. Evidence ledger

| Source checked | Verified observation | Loom implication / remaining check |
| --- | --- | --- |
| [Codex CLI reference](https://developers.openai.com/codex/cli/reference/) | Explicit exec resume IDs, newline-delimited JSON output, output-schema and ephemeral options are documented. | Bind a specific native ID; do not use most-recent selection. Verify accepted-event evidence and version-specific flags in fixtures. |
| [Codex app-server](https://developers.openai.com/codex/app-server/) | A documented application integration interface exists alongside CLI execution. | Evaluate against receipt/event requirements in P0; its existence is not a decision to replace Loom's working transport. |
| [Claude CLI reference](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations) | Resumed conversations may reuse recorded system prompt text; changes to prompt flags need not apply immediately. Built-in tool restriction does not alone remove MCP tools. | Do not rely on changed append-system prompts for corrections. Verify dynamic channel and helper isolation by installed version. |
| [Claude SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | Native sessions preserve conversations, not filesystem snapshots. Resume and fork are distinct operations. | Workspace identity/revision is app-owned. SDK behavior alone is not proof of CLI compatibility. |
| [Claude hooks](https://code.claude.com/docs/en/hooks) | PreCompact and PostCompact lifecycle hooks are documented. | Compaction can be observable on supported integrations. Determine whether our actual adapter can receive these signals without overwriting user hooks. |
| [Claude costs](https://code.claude.com/docs/en/costs) | Context size affects token usage; caching and native compaction are optimizations. | Measure native and added-context usage separately; do not promise subscription savings from packet size alone. |
| [OpenCode SDK](https://opencode.ai/docs/sdk/) | Session prompts support context-only noReply; session abort/summarize and message reads are documented. | An optional injection path exists, but current Loom's legacy API must be reconciled first. NoReply is not free context. |
| [OpenCode server](https://opencode.ai/docs/server/) | Published session endpoints cover prompt, abort and message operations. | Pin supported server protocol; avoid inferring support from endpoint reachability alone. |
| [Zod schemas](https://zod.dev/api) | Strict objects and discriminated unions are available. | Use versioned backend contracts and inferred types; runtime shape checks do not establish truthful content. |
| [Zod JSON Schema](https://zod.dev/json-schema) | Schema conversion supports dialect selection; some Zod types/checks cannot be represented. | Simple helper schemas only; test provider-supported subsets and run semantic validation locally. |
| [Claude structured output errors](https://code.claude.com/docs/en/agent-sdk/structured-outputs#error-handling) | Structured output generation can fail, including exhausted validation retries. | Bound helper retries and retain deterministic fallback; partial output cannot become a validated checkpoint. |
| [SQLite FTS5](https://sqlite.org/fts5.html) | BM25 ranks lexical matches; external-content indexes need explicit consistency maintenance. | Search without an embedding model. Test initial backfill, update/delete/rebuild, query escaping and packaged runtime support. |
| [SQLite WAL](https://sqlite.org/wal.html) | WAL has same-host/local-filesystem constraints and separate checkpoint behavior. | Do not use network-share WAL or copy only a live database file for backup. |
| [SQLite backup](https://sqlite.org/backup.html) | A supported online backup interface exists. | Select a safe backup route and test recovery rather than relying on ordinary file copying. |
| [Node SQLite](https://nodejs.org/api/sqlite.html) | The current Node docs expose DatabaseSync and a backup function with version history. | Feature-probe against Loom's minimum Node version and bundled runtime; current web docs describe a newer runtime than that minimum. |

Sources were read on 2026-09-28. No account entitlement, provider ToS clearance,
installed version compatibility or real token accounting was established by this
research. The implementation remains within supported native interfaces; test
model availability and account-supported helper use before enabling it.

The earlier [T3 notes](../proposals/t3code-reference.md) remain pinned to their
inspected commit. T3's helper pattern is useful; it is not evidence that Loom
already has cross-harness continuation or measured performance.

## 2. Baseline code observations before implementation

Base commit: `584a3b6a86bfa9af2a0a8ecbeac57e6aa4578e7a`.

- `SendInput` has text/briefing/model/MCP but no conversation binding, run epoch,
  receipt correlation or explicit session selection.
- `AgentStateStore` separates access but native IDs remain in per-instance slots.
  It does not yet provide multiple native sessions per app conversation.
- Claude injects briefing through append-system-prompt; the documented resume
  snapshot behavior requires a verified alternative for changing context.
- Codex resumes an explicit instance-level thread; OpenCode speaks older
  `/api/session/.../prompt` shapes rather than assuming the modern SDK contract.
- The legacy briefing wrapper labels all carried context authoritative. The new
  renderer must distinguish user instructions from assistant/external evidence.
- `RuntimeAgents` ignores retired callbacks and waits for stop promises, but
  swallows stop errors. That is not verified quiescence. A failed stop must not
  permit a new writer in the continuity flow.
- Some pinned-thread execution bypasses the baton. A chat pin is not a read-only
  guarantee, so a workspace execution lease must cover that path too.
- Live event ordering, run identity and late-event capture need an explicit
  ingest path; project event IDs alone do not correlate native retries.
- DatabaseSync/EventLog currently run synchronously in the daemon. A transparent
  worker wrapper would either change contracts or block; design an asynchronous
  internal boundary first. Bounded queries/backpressure and responsiveness tests
  are required; isolate ownership further if those measurements require it.
- The boundary refactor is now committed. Its recorded 1,482 passing tests are a
  useful baseline, not proof of the new continuity behavior.

## 3. Edge-case matrix

Each ID becomes a named fixture or documented platform/capability check. The
expected responses below are design requirements, not implemented behavior.
No finite list proves that every possible edge case has been found.

### User meaning and scope

| ID | Trigger | Required handling / assertion |
| --- | --- | --- |
| E01 | Small preference buried early in a long conversation | Protected state or exact unresolved source survives; retrieval rank cannot drop it. |
| E02 | User says an alternative might work | Keep tentative/exploratory status; no accepted decision without supporting user evidence. |
| E03 | User corrects an earlier decision | Supersede the matching scoped revision; send the correction and current state on return. |
| E04 | Instructions appear contradictory but apply to different tasks | Preserve scopes; do not blindly let the newest sentence win. |
| E05 | Ambiguous or conflicting governing instruction | Keep evidence and unresolved conflict visible; clarify only when execution depends on resolving it. |
| E06 | Rejected alternative or unresolved question | Retain topic disposition; do not summarize it as a chosen approach or completed task. |
| E07 | Edited/deleted message already supplied to a provider | Record revision/deletion and invalidate derived state; do not claim the native session forgot the original. |
| E08 | New user message arrives during assembly/helper work | Persist immediately; invalidate unsent governing context or queue steering for the captured run target. |

### Native sessions and execution

| ID | Trigger | Required handling / assertion |
| --- | --- | --- |
| E09 | Same configured agent used in two chats | Separate native bindings; never resume chat A's cursor for chat B. |
| E10 | Switch to another provider with a similarly named model | Resolve actual instance/harness identity; never transfer provider resume IDs. |
| E11 | Same-harness model/permission/auth configuration changes | Validate compatibility fingerprint; resume only when supported, otherwise reconstruct a new epoch. |
| E12 | Native session missing, expired, manually cleared or corrupted | Preserve app evidence; mark binding unavailable and reconstruct safely. |
| E13 | Return to a native session that compacted | Submitted coverage remains history; retained confidence changes and protected state is refreshed. |
| E14 | Compaction signal unavailable or lost | Record unknown retention; use conservative reconstruction policy without pretending exact memory. |
| E15 | Repeated resume ignores a changed system prompt | Fixture catches it; deliver dynamic context through a verified per-turn channel. |
| E16 | Workspace moved, branch/worktree changed or non-Git project | Revalidate workspace identity and observations; no clean/compatible assumption from the native session alone. |

### Switching and concurrency

| ID | Trigger | Required handling / assertion |
| --- | --- | --- |
| E17 | Rapid idle picker changes | Coalesce selection locally; no provider request or helper job required. |
| E18 | Picker changes after request submission | Frozen request target remains unchanged; later selection affects subsequent work only. |
| E19 | Switch while a writer is active | Default finish-then-switch; explicit interrupt path waits for quiescence. |
| E20 | Interrupt acknowledgement but child process still writes | Hold writer lease; no replacement writer until stop is verified. |
| E21 | Stop fails, times out or an approval dialog remains | Surface stopping/failed-stop state; do not swallow it and continue editing elsewhere. |
| E22 | Late event from previous run after a switch | Attach to the original run; never advance the new run's coverage/current task state. |
| E23 | Concurrent sends, queued prompts or two pinned chats | Idempotent requests, explicit order, one foreground chat run and one workspace writer. |
| E24 | Route/orchestra/bridge/helper shares a workspace | Enforce capabilities and ownership across entrypoints; helper/bridge cannot silently become an authorized writer. |

### Submission and crash recovery

| ID | Trigger | Required handling / assertion |
| --- | --- | --- |
| E25 | Crash after prepared packet, before external call | No submission recorded; safely continue the prepared attempt after revalidation. |
| E26 | Crash after marking submitting but before/around native acceptance | Outcome unknown unless correlated evidence resolves it; do not infer rejection. |
| E27 | Native accepts but response/ack is lost | Reconcile session messages/request IDs if supported; otherwise explicit unknown recovery, no automatic replay of edits. |
| E28 | Process spawned but prompt rejected | Spawn is not acceptance; distinguish startup from native input acknowledgement. |
| E29 | Accepted request ends in error, quota exhaustion or cancellation | Preserve acceptance/coverage separately from run outcome; no false completed-work claim. |
| E30 | Duplicate/reordered native events or client retries | Use source IDs/idempotency where available; dedupe only provable duplicates, preserve valid repeated text. |
| E31 | App restart while old CLI remains alive | Reconcile live ownership before dispatch; do not create a second writer. |
| E32 | Two app processes, stale lease or reused PID | Validate owner identity/fencing and quiescence; heartbeat expiry/PID alone cannot authorize takeover. |

### Packet validity and evidence quality

| ID | Trigger | Required handling / assertion |
| --- | --- | --- |
| E33 | Schema version unknown, malformed JSON, extra keys or huge nesting | Bound parsing; reject/quarantine without partial state mutation or silent field loss. |
| E34 | Helper invents source ID/span/hash or references another project | Semantic validation rejects it before state or retrieval output changes. |
| E35 | Summary drops a small point or promotes agent opinion | Preserve originals, dispositions and authority; schema-valid is not semantically complete. |
| E36 | Unicode, CJK, emoji, CRLF or code delimiters in user text | Exact capture, safe UTF-8 spans and rendering; token estimation and query handling must not corrupt text. |
| E37 | Tool emitted success-looking stdout then failed/timed out | Final exit/outcome controls work claims; preserve stderr and partial output. |
| E38 | Interrupted streaming message, missing final event or partial tool result | Mark partial/unknown; never reconstruct it as a complete successful response. |
| E39 | Tests passed before subsequent file changes | Record workspace revision; mark applicability stale rather than reporting current verification. |
| E40 | Packet becomes stale before send | Revalidate epoch, protected state, permissions and workspace; rebuild or fail before invoking native work. |

### Budget, retrieval and helpers

| ID | Trigger | Required handling / assertion |
| --- | --- | --- |
| E41 | Mandatory instructions/current request exceed soft/native budget | Visible overflow and resumable expansion/narrowing; no silent truncation or empty packet. |
| E42 | Returning session has summarized/referenced coverage holes | Delta reconstructs necessary missing evidence; high-water mark alone cannot skip it. |
| E43 | FTS unavailable, index stale/corrupt or rebuilding | Bounded exact/entity fallback, rebuild diagnostics and transactional index consistency. |
| E44 | Search wording differs, FTS syntax/path tokens are unusual | Escaped bounded queries, aliases and broader source reads; no claim of universal semantic recall. |
| E45 | MCP unavailable, exported file unreadable or unsupported attachment | Necessary content inline or explicit limitation; reference alone is not delivered content. |
| E46 | Helper unavailable, invalid output, quota limit or expensive fallback | Deterministic flow/originals remain; bounded failure cooldown and no silent model substitution. |
| E47 | Helper finishes after correction, deletion, shutdown or model/policy change | Recheck hashes/revisions/lifetime; discard stale result and do not advance coverage. |
| E48 | Many chats trigger summaries/titles simultaneously | Global/project bounded scheduling, deduplication and foreground priority; no recursive helper jobs. |

### Persistence, migration and artifacts

| ID | Trigger | Required handling / assertion |
| --- | --- | --- |
| E49 | Disk full, permission error or failed DB transaction | Fail before acknowledging durable capture; no memory-only cursor advancement or silent fallback store. |
| E50 | SQLite busy, long reader or growing WAL | Bounded retry/checkpoint/backpressure; UI remains responsive and capture order is preserved. |
| E51 | Network filesystem or unsupported SQLite/Node feature | Explicit supported mode/failure; no unsupported WAL or pretending continuity is available. |
| E52 | Crash between artifact finalize and referencing transaction | Orphan cleanup after grace period; committed references only point to finalized verified artifacts. |
| E53 | Artifact missing/corrupt or media/decompression bomb | Integrity/capability checks and bounded parsing; preserve diagnostics without fabricating evidence. |
| E54 | Backup taken during writes, migration interrupted or rollback requested | Safe backup/atomic migration; restore includes all post-cutover evidence via export, no unnoticed history loss. |
| E55 | JSONL torn tail, colliding IDs or both SQLite/JSONL have distinct histories | Manifest/count/hash reconciliation; retain sources and require explicit conflict policy before cutover. |
| E56 | Legacy session cursor has ambiguous chat ownership | Leave unassigned until verified; do not clone it into every chat or discard it silently. |

### Privacy, trust and product integration

| ID | Trigger | Required handling / assertion |
| --- | --- | --- |
| E57 | Private/team/external memory appears relevant across scopes | Scope filtering before ranking/reads/export; no relevance-based permission bypass. |
| E58 | Retrieved text contains instructions or forged briefing delimiters | Label/escape evidence; preserve origin and native permissions, never replay embedded commands automatically. |
| E59 | User instruction files change or imported memory conflicts | Fingerprint/refresh sources; do not overwrite user files or elevate all imports to system authority. |
| E60 | Explicit data deletion with derived summaries/artifacts/backups/native sessions | Invalidate app dependencies and jobs; clearly distinguish hiding, app deletion and external retained copies. |
| E61 | Offline/provider-down switch, unavailable model or authentication changes | Preserve pending request and history; no dependence on the failed provider's helper or automatic fallback execution. |
| E62 | Text-only target receives images, binary files or large attachments | Capability-aware representations; attachment pointer is not visual understanding, no guessed content. |
| E63 | UI disconnect, stale command version or duplicate submission | Canonical state persists independently; scoped replay/version checks and idempotent client request IDs. |
| E64 | Diagnostics/logging/export includes credentials or private source text | Capture documented output only; redact sensitive diagnostic fields, apply scopes and explicit export policy. |

## 4. Historical planning questions / decisions to preserve

- Historical: proposed defaults were awaiting review; user approved implementation on 2026-09-28.
- Installed harness versions, account helper models, native idempotency/ack
  evidence, compaction visibility and stop guarantees have not been live-tested.
- CLI vs app-server/SDK selection remains a P0 capability decision; changing
  transport must solve a concrete missing requirement.
- Need a documented minimum supported Node/harness matrix and migration backup
  route before SQLite cutover. No changes to dependencies were made in research.
- Token targets are configurable soft targets. Reference hardware, output reserve,
  performance thresholds and long-history evaluation corpus must be frozen before
  advertising latency/RAM/continuation quality.
- Existing embedding candidates are historical optional research only; no local
  model is required or planned for the first milestone.
- No private transcript edits, prompt proxying or API pricing assumptions are
  required by this design. Native usage/account behavior still needs verification.

## 5. Session receipt for this planning work

- [x] Reviewed current code and committed boundary baseline.
- [x] Read primary harness, Zod, SQLite and Node documentation.
- [x] Wrote actionable plan, edge-case matrix and implementation checklist.
- [x] User reviewed/approved the plan.
- [x] Implementation started; current release gaps are listed in BRAIN-TODO.

Research changed documentation only. No code, dependency, model download, paid
harness call, runtime fixture or application server was run. Local document links,
code-fence balance, tracked/new-file whitespace and all 64 unique edge-case IDs
were checked successfully. Runtime tests were not rerun for documentation changes.

## Final verification receipt

- `npm run build` and `npm run typecheck`: passed.
- Full daemon/non-DOM regression: 1,384 passed, 17 skipped; no model calls.
- All 12 browser suites rerun after the board readiness fix: 125 passed.
- Final affected group after adapter/dispatch refinements: 105 passed across
  8 suites (continuity, storage, HTTP, native adapters, chat API, events, lifecycle).
- Initial sandbox-only integration failures were localhost `listen EPERM`;
  authorized reruns with networking passed.
- Source artifact tests verify full output preservation, integrity, unsafe paths
  and immutable references; previews are labelled truncated when originals are
  stored as artifacts. Known pre-launch rejection produces `failed`; lack of
  native evidence stays `outcome_unknown`.
- No commit/push, installed account probe beyond fake fixtures, or paid harness turn.

The complete approved release plan is not claimed finished. Optional helpers,
OpenCode parity, automatic retention/deletion/GC, native compaction observation,
real account/token/continuation measurements and broader platform/fault-injection
gates remain in BRAIN-TODO. The implemented mode remains opt-in.

Final artifact checks: `npm pack --dry-run` includes the continuity JavaScript,
contracts/types, implementation guide and benchmark JSON (561 files, ~6.67 MiB
unpacked). Documentation relative links and `git diff --check` passed. The
additional strict HTTP submission tests reject string booleans/unknown keys before
request capture or harness invocation. Native live/account and cross-platform
packaged execution remain unverified.

## Cleanup audit receipt — 2026-09-28

User requested removal of obsolete Brain paths, races and bad logic, followed by
comparison with the approved implementation plan and research matrix. Applied the
code-review and codebase-design skills. Two independent review axes and all E01–E64
implementation statuses are recorded in [BRAIN-AUDIT](BRAIN-AUDIT.md).

The cleanup fixes cancellation, source coverage/authority, exact queued capture,
atomic recovery, native descendant containment, app-owned post-turn writes and
artifact/index consistency. Current-request bytes now count toward the conservative
turn-input budget. Remaining native usage is still unknown. No paid native tests or
new commit/push were requested or performed. Legacy compatibility APIs remain while
native execution skips their injection/mining/extraction; unsafe queue edits and
unverified autonomous routes now fail explicitly instead of appearing supported.

Additional primary-source check: [Claude tool-call result format](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
documents tool-use IDs and error flags. This supports a future result normalizer,
but does not verify that every checked CLI profile emits those results. The Claude
normalization gate remains open rather than inferring success from assistant text.

Verified after cleanup:

- `npm run build` and `npm run typecheck`: passed.
- Final focused core/native group: 87 passed across five suites.
- `npm test`: 1,408 non-DOM tests and all 125 browser tests passed; 17 existing skips.
  The full suite ran outside the filesystem/network sandbox because localhost
  listeners are required. No paid provider calls were made.
- `git diff --check` and documentation links: passed; all 64 unique matrix IDs have audit rows.
- Packaging dry run with already-built output: new compiled modules, audit and
  benchmark artifacts included. No package published.
- [Audit benchmark](brain-benchmark-audit-2026-09-28.json): same M4/Node24.3 corpus,
  all 20 buried user points retained; preparation p95 13.85 ms, retrieval p95
  0.224 ms, event-loop p95 18.12 ms; 3,047 heuristic turn-input tokens including
  the current request. Native token usage and understanding remain unmeasured.

Standards: eight initial/follow-up correctness findings addressed; the original
worst issue was Stop racing with launch. Spec: ten initial/follow-up findings
addressed in the supported path; full descendant/platform containment remains
partial. Neither verdict is release certification for every matrix row.

## OpenCode (2026-09-29)

Enabled as a native harness after its protocol and acceptance fixtures passed.

Protocol, recorded from a live `opencode serve` 1.18.31 (`/doc` OpenAPI plus a captured `/event` stream):

- A bound session that no longer exists answers `GET /api/session/{id}` with 404
  `SessionNotFoundError`. The adapter raises NativeSessionMissing before sending
  anything, so the engine moves the binding to a new epoch.
- `POST /api/session/{id}/prompt` returns 200 at once with an admission
  (`admittedSeq`, message id, `delivery: "steer"`). That admission is the
  acceptance evidence (`native_turn_accepted`). Any other status before admission
  is NativeDispatchRejected; a network failure mid-request stays "outcome unknown".
- `/api/session/{id}/wait` still answers 503 ("not available yet"), so it can't
  prove a turn is over. `GET /api/session/active` lists the session as
  `{type: "running"}` for the whole turn and drops it when the turn ends, so the
  turn is over, and quiescent, when the session leaves that list. A session still
  listed at the timeout is NativeQuiescenceUnknown.
- `POST /api/session/{id}/model` switches the model of an existing session, so a
  model change keeps the native session, as with Codex and Claude.
- Streamed events are `session.next.*`: text/reasoning deltas, `tool.called` /
  `tool.success` / `tool.failed` (reported as tool calls), and
  `compaction.started` / `compaction.ended` plus `session.compacted` (reported once
  as `native_compacted`, which marks the binding compacted).

Verification:

- `test/opencode-continuity.test.ts` (11 cases) runs the real adapter and engine
  against a fake server with those shapes. The cases: acceptance and correlation,
  delta resume on the same session, in-place model switch, a lost session then
  rebuild, a refused prompt with no lease left behind, a stuck session with
  unknown quiescence, a failed turn, tool and compaction events, the baseUrl
  health probe, and a runtime-level turn. A mutation that drops the lost-session
  check fails it.
- Live (opencode 1.18.31, free `opencode/big-pickle`), through a daemon with
  continuity on:
  1. The first turn is a reconstruction, which creates the session.
  2. The second is a delta on the same session and recalls a planted fact.
  3. After restarting the daemon and its OpenCode server, the third is a delta on
     the same session and still recalls the fact.
  All three receipts are `accepted/complete`. An ordinary (non-continuity)
  OpenCode turn still works.

Limits: prompts carry no client message id yet (the API accepts `id: msg_…`, which
could make a lost acknowledgement retry-safe). There is no context-window meter
for OpenCode. Attachments and `extraArgs` stay refused, as for the other harnesses.

