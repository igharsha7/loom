# Brain continuity implementation plan

Status: **approved; deterministic native mode implemented behind an opt-in flag**.
Current implementation: [native continuity](../brain-continuity.md). Remaining
release milestones are explicit in [BRAIN-TODO](../refactoring/BRAIN-TODO.md);
this proposal is not a claim that every gate is complete.
Updated: 2026-09-28. Base: `dev/Harsha` at
`584a3b6a86bfa9af2a0a8ecbeac57e6aa4578e7a`.

This is the actionable plan for the next phase. The earlier
[continuity proposal](brain-session-continuity.md) supplies broader rationale;
this document takes precedence for implementation scope. Research and unresolved
capability questions are in [research notes](../refactoring/BRAIN-NOTES.md).
Execution progress belongs in [BRAIN-TODO.md](../refactoring/BRAIN-TODO.md).
No Brain runtime implementation or dependency installation is authorized yet.

## 1. Milestone and limits

Prove **Claude → Codex → Claude in one app conversation**, including a restart,
a correction, and a native compaction/unknown-retention case. Add OpenCode only
after its supported protocol passes the same contract fixtures.

The app owns history, instructions, decisions, discussion state and context
assembly. The native harness owns execution, authentication and tools. Use its
supported CLI/server interfaces. No replacement coding-agent loop, private
transcript surgery, API proxy or required hosted API key.

The initial implementation has **no embedding model, vector store or model
runtime download**. Use SQLite, exact entity matching and lexical retrieval.
Optional cheap harness helpers follow the deterministic flow; they cannot be a
prerequisite for switching. Do not redesign Electron or add parallel coding here.

Stored, submitted, provider-acknowledged and understood are different claims.
We can verify the first three to varying degrees; we cannot guarantee that a
model understands every supplied point or retains it after native compaction.
Arbitrary history cannot fit a fixed small context budget without information
loss. Never hide that loss by pretending a reference or summary is exact replay.

## 2. Owners and interfaces

| Module | Responsibility | Excluded responsibility |
| --- | --- | --- |
| BrainStore | Canonical evidence, state revisions, transactions, artifacts and migrations | Starting native processes or sending UI frames |
| ConversationState | User intent, accepted decisions, corrections, topic ledger and task observations | Treating helper guesses as user authority |
| ContextAssembler | Frozen snapshots, source coverage, budgets and deterministic rendering | Sending packets or claiming acceptance |
| SessionSync | Session bindings, run serialization, submission and recovery | Choosing a provider using its display/model name alone |
| Retrieval | Scoped FTS/entity search and paginated source reads | Deciding which active instructions to omit |
| ContextHelper | Optional isolated structured summary/metadata jobs | Repository edits, foreground resume IDs or recursive extraction |
| Harness adapters | Supported native session/turn operations and factual event translation | Owning app conversations |
| Client delivery | Versioned UI commands/results and status updates | Mutating canonical history |

Build on the [completed ownership separation](../refactoring/BOUNDARIES.md).
Keep the public EventLog/adapter entrypoints compatible while adding internal
interfaces. One native session belongs to one app conversation/workspace binding;
a configured agent ID remains an instance configuration, not a session ID.
Legacy instance-level cursors must not be reused across unrelated chats.

## 3. Capability checks precede implementation

Record a profile keyed by harness kind, installed version, executable/endpoint
identity and relevant configuration fingerprint. Recheck after an upgrade or
configuration change. Unknown behavior is unsupported until tested.

Verify explicit resume IDs, fresh-session creation, model changes, dynamic
context injection, message/tool IDs, completion versus interruption, usage
fields, context limits, compaction visibility, and read/search access. Fixtures
use fake CLIs/local servers; paid live smoke tests need separate authorization.

- **Codex:** documentation describes explicit exec resume IDs, JSON events and
  schema-constrained output. Resume by our bound ID, never `--last`. Ephemeral
  runs are helper-only. Choose CLI vs app-server after recording the minimum
  supported version; do not migrate transports merely for consistency.
  [Official CLI reference](https://developers.openai.com/codex/cli/reference/).
- **Claude:** current CLI documentation describes recorded system prompts on
  resume. A changed append-system prompt may not update the active context until
  compaction. Test dynamic delivery; prefer verified per-turn user content for
  changing handoffs. Use snapshot controls only on versions that support them.
  [Official CLI reference](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations).
- **OpenCode:** current SDK documents context-only `noReply` prompts, abort and
  summarize operations. Loom currently speaks an older API shape; verify or
  update the adapter before enabling those capabilities. Context-only submission
  still contributes to later input context; it is not a quota bypass.
  [Official SDK](https://opencode.ai/docs/sdk/).

Do not assume API features or SDK examples are implemented by every CLI version.
Native stop acknowledgement must be distinguished from verified process/run
quiescence. A stopped UI spinner does not authorize a second writer.

## 4. Three separate contracts, defined with Zod

Add Zod to the backend/shared contracts when implementation is approved. Infer
TypeScript types from the schemas. Validate unknown inputs at persistence,
IPC/HTTP, import, adapter and helper boundaries; trusted internal values need not
be reparsed at every function call. Keep validation out of token-delta hot paths.

Use strict, explicitly versioned objects; reject unknown versions without writing
state. Bound strings, arrays, bytes, nesting and numeric values before expensive
parsing. Schemas are module-owned and dependency-free apart from Zod.

| Contract | Contains | Stored / supplied |
| --- | --- | --- |
| ContextPacketV1 | Target binding, snapshot revisions, request reference, protected state, discussion/task context, evidence, source coverage and budget | Immutable database record; only selected contents are rendered |
| RenderedBriefingV1 | Exact rendered text, renderer version, channel and content hash | Store the exact bytes supplied to the harness |
| DeliveryReceiptV1 | Packet/attempt/run IDs, state transitions, native IDs where observed, timestamps and evidence | Database bookkeeping; never prompt overhead |

Supporting schemas: SourceRefV1, WorkspaceRefV1, InstructionV1, DecisionV1,
TopicV1, WorkObservationV1, CoverageEntryV1, SessionBindingV1, RunV1 and
HelperResultV1. Helpers return candidate summaries/topics/claims with source
references; they do not generate sessions, receipt states or authority grants.

Proposed packet shape (design notation, not committed runtime code):

```ts
type ContextPacketV1 = {
  version: 1;
  id: string;
  conversationId: string;
  requestId: string;
  target: {
    bindingId: string;
    agentInstanceId: string;
    harnessKind: string;
    nativeSessionId: string | null;
    sessionEpoch: number;
    compatibilityFingerprint: string;
  };
  snapshot: {
    throughEventId: number;
    conversationRevision: number;
    protectedStateRevision: number;
    workspace: WorkspaceRefV1;
    instructionFilesFingerprint: string;
  };
  mode: "reconstruction" | "delta";
  currentRequest: SourceRefV1;
  goal: ContextItemV1 | null;
  instructions: ContextItemV1[];
  decisions: ContextItemV1[];
  corrections: ContextItemV1[];
  topics: TopicV1[];
  completedWork: WorkObservationV1[];
  pendingWork: ContextItemV1[];
  recentMessages: ExactMessageV1[];
  evidence: EvidenceReferenceV1[];
  coverage: CoverageEntryV1[];
  budget: {
    estimatedAddedTokens: number;
    estimation: "tokenizer" | "heuristic";
    targetAddedTokens: number;
    overflow: "none" | "soft" | "mandatory";
  };
};
```

A ContextItem has an ID/revision, text, nonempty source references, scope, source
origin (`user`, `agent`, `derived`, `external`) and lifecycle status. Source origin
is not an automatic execution privilege. A decision is exploratory/tentative/
accepted/rejected/deferred/superseded; accepted user decisions require supporting
user evidence. Corrections refer to the exact superseded item/revision.

SourceRef identifies the project, event ID, source-content hash and optional
UTF-8 byte span. Event IDs alone are not globally unique. Validate span bounds,
UTF-8 boundaries, scope and hashes against immutable captured text. Attachments
use artifact hash/media type/size and access capability, not filesystem paths
chosen by a helper. WorkspaceRef has a stable local workspace ID, repository
identity, checkout/worktree identity, observed HEAD/dirty state and revision;
unknown observations stay unknown rather than becoming an invented clean state.

Zod shape checks are only the first layer. Semantic validators enforce reference
existence/visibility, origin, supersession, mandatory coverage, target epochs,
workspace compatibility and receipt transitions. No coercion of booleans or IDs,
no defaults that silently turn uncertain claims into accepted ones.

A matching quote proves that text exists, not that a summary faithfully captures
its meaning. Preserve original sources, test semantic fidelity on the evaluation
corpus, and retain uncertainty when an interpretation is disputed. Client retry
IDs are bound to a payload hash; reusing an ID with different text/target is a
conflict, not a new prompt silently discarded as a duplicate.

Generate helper JSON Schema from simple JSON-compatible Zod schemas. Refinements
and transforms may not be representable; run semantic checks locally after the
response. Pin and test the harness-supported JSON Schema dialect/subset rather
than assume generated schemas work everywhere. [Zod API](https://zod.dev/api),
[JSON Schema conversion](https://zod.dev/json-schema).

Structured output can still fail or exhaust retry limits; keep the raw eligible
source and deterministic path rather than considering a partial JSON object a
valid checkpoint. [Claude structured output errors](https://code.claude.com/docs/en/agent-sdk/structured-outputs#error-handling).

## 5. Capture and protect conversation meaning

Persist each user submission exactly once with an idempotent client request ID,
original eligible text, attachment references, timestamp and destination captured
at submission. Editing a sent message appends a revision/correction; it cannot
rewrite evidence already delivered. Main's pre-chat events remain Main's.

Separate captured observations from normalized projections. Streaming deltas
update a reconstructable message draft; final output closes it. An interrupted
assistant message stays partial. Tool records distinguish requested, running,
succeeded, failed, cancelled and outcome-unknown. Preserve final status, exit
code and relevant stdout AND stderr. A success claim requires evidence; an agent
saying tests passed remains a reported claim until a matching tool outcome exists.

Protect current user instructions, accepted decisions, unresolved corrections,
current request and unfinished work independently of retrieval ranking. Preserve
small preferences and user discussion, including rejected alternatives and open
questions, in a topic ledger with source links. Discussion is not automatically
a command. Contradictions remain explicit until a clear correction resolves them.
Do not use recency alone to supersede an unrelated scoped instruction.

Every eligible user message gets a source disposition: exact, source-backed
summary, deferred/unprocessed, or explicitly excluded with a reason. Do not call
unprocessed text summarized. Deferred user intent remains exact in the mandatory
context path until covered. Helper extraction may propose interpretations; it
cannot certify semantic completeness or grant itself authority.

Summaries retain originals and source hashes. They may replace verbose assistant
and tool detail in the packet, but do not silently replace critical user wording.
Without helpers, use exact spans and deterministic task/topic records; uncertain
user intent cannot be safely compressed just because the budget is small.

## 6. Packet assembly and actual harness input

Assemble from one frozen database snapshot, after obtaining the execution lease:

1. Resolve the target binding and resume compatibility. Missing/incompatible
   sessions or uncertain retained context select reconstruction.
2. Select mandatory active user state, the exact new request and unresolved user
   source dispositions. Then add open topics/tasks and relevant work observations.
3. Prefer exact eligible history if it fits. Otherwise select a recent exact tail
   and cached source-backed checkpoints; retrieve task-specific evidence only
   after mandatory context has been reserved.
4. A delta includes changes not previously submitted, explicit supersession,
   fresh workspace observations and the active protected state. It is not simply
   `events since lastId`: referenced/summarized sources have different coverage.
5. Deduplicate overlapping evidence and the current request. Do not count the
   same prompt as both recent history and new input. New observations after the
   snapshot go to the next delta; new governing corrections invalidate an unsent
   packet and force reassembly.
6. Render fixed sections: goal; active user instructions; accepted decisions and
   corrections; work completed with evidence; unfinished work/open questions;
   relevant exact discussion/evidence; exact current request. Label historical
   assistant/tool/external content as evidence, not executable instructions.
7. Store packet and rendered hash atomically. Recheck permissions, session epoch,
   protected revision and workspace identity immediately before submission.

Transmit the briefing alongside the new request in **one normal foreground
turn**, using the tested native channel. Avoid a separate paid "acknowledge this
context" turn. OpenCode context-only injection is optional when verified; if used,
its submission and the subsequent action are separate recorded attempts.

A file/MCP reference is not the referenced text. Every source access route must
be usable by the target harness. Offer small paginated read/search tools with
scope checks; a local read-only export is fallback where MCP is unavailable.
Supply critical intent inline even when retrieval exists. If neither retrieval
nor file reading works, include necessary evidence inline or report the limitation.

No recorded tool invocation is re-executed during reconstruction. Native hidden
state, credentials and private reasoning are not imported to imitate another
harness. Do not elevate all imported memories to system-level authority, as the
legacy generic briefing wrapper currently does.

## 7. Budgets, retrieval and compaction

Initial configurable **soft targets**, not performance promises: 3–6k added
context tokens for reconstruction; 1–3k for a return delta. Also respect verified
native context capacity, output reserve and harness/tool overhead. Treat remaining
capacity as unknown when the harness does not report it. Character count alone
is not a tokenizer, especially for code, CJK, emoji and large attachments.

Order budget reductions: deduplicate, remove irrelevant evidence, shorten verbose
assistant/tool summaries, reduce optional history, use cached validated checkpoints.
Never truncate the current request or drop active user requirements silently.
Mandatory overflow returns a visible, resumable result: expand context within
verified capacity or explicitly narrow/archive scope. The default must not quietly
send less than required or repeatedly spawn helper retries to try fitting it.

Search uses chat/workspace/scope filtering, exact paths/symbols and FTS5 BM25.
Parameterized SQL is required; separately escape/limit FTS query syntax. Topic
aliases and optional helper query expansion address wording differences. Lexical
search is not semantic recall; label uncertainty and provide a broader paginated
source search. Test FTS availability and rebuild consistency; fallback to bounded
exact/entity search if unavailable. [SQLite FTS5](https://sqlite.org/fts5.html).

Coverage records exact/summarized/referenced/omitted for individual sources or
validated contiguous ranges. Never advance a full-coverage cursor over holes.
Track submitted coverage and retained-context confidence separately. Receipt
acceptance does not establish comprehension. Native compaction invalidates any
assumption of exact retention; refresh protected state and relevant checkpoints.
Unknown compaction visibility is recorded as unknown and uses conservative,
configurable reconstruction triggers without resetting every native session.

Optional helpers run in isolated sessions, receive bounded source snapshots and
return strict source-backed output. Resolve available models; Luna/Haiku are
preferences, not universal IDs. Never substitute a more expensive model silently.
Disable tools/MCP/hooks/skills where supported and verified; a read-only sandbox
alone is insufficient. No helper can mutate the workspace or main session.

Start with one helper job per project, deduped by sources/hash/prompt/model/policy.
Set global concurrency, input/output, timeout and usage caps. Foreground work
wins; no recursive helper triggers or summarizing summaries without original
sources. Invalid/late/deleted-source outputs are discarded, originals remain,
and repeated failure opens a cooldown instead of an infinite repair loop.

Measure added context, retrieval output and helper usage separately from native
reported input/output/cached tokens and quota errors. Missing usage is unknown,
not zero. Stable rendering avoids unnecessary prompt churn, but caches are
provider-local and subscription cost cannot be inferred from API prices.
[Claude cost guidance](https://code.claude.com/docs/en/costs).

## 8. Runs, switching, receipts and recovery

One foreground run per chat and one mutating foreground owner per workspace.
The workspace rule applies to pinned chats, routes and other participating
workflows, not only the new switch button. Existing orchestra worktrees retain
separate ownership. Read-only concurrent work is a later explicit capability;
a "pinned thread" alone is not proof its adapter cannot edit.

Persist a run with request ID, target binding/epoch, source snapshot and writer
lease before invoking the harness. Events carry instance, native session, epoch,
run ID and provider event identity where supplied. A terminal event is recorded
before the next queued turn is released. Late old-run events stay attached to
that run and cannot change the selected target or current work projections.

Idle picker changes are free local selection. Submitted/queued requests keep
their captured destination. During a run offer finish-then-switch (default) or
interrupt-then-switch. Interrupt requests move to stopping; keep the writer lease
until verified quiescence. Approval prompts and child processes may prevent it.
Fail visibly if stop cannot be verified; do not launch another writer anyway.

Receipt states and meaning:

```text
prepared -> submitting -> accepted
                      -> failed
                      -> outcome_unknown
```

`prepared` has not invoked the native interface. Persist `submitting` before the
external call. `accepted` requires documented evidence, such as a correlated
native user-message/turn event; process spawn alone is not acceptance. A provider
response may prove acceptance even if the completed run failed. `failed` means
known rejection/non-submission, not every timeout. A lost response after a possible
submission is `outcome_unknown`. Cancellation does not retract delivered text.

Use a separate attempt record for retries. On restart, inspect the session/run
and workspace for correlated evidence. Recover accepted or safely failed states
where possible; otherwise keep unknown and require explicit recovery selection.
Never blindly replay an action prompt: harnesses without idempotency cannot
provide exactly-once external execution. Brain's own writes/request ingestion
are idempotent; that does not make the native side idempotent.

A replacement native session gets a new epoch and reconstructed context. Update
UI success only when startup/binding is verified; failed switches preserve pending
intent. App restart must not orphan a still-writing CLI and then start another.
Multiple app/daemon processes use validated project ownership/fencing; a stale
heartbeat or PID number alone is insufficient to authorize takeover.

## 9. SQLite, artifacts and migration

Extend `.loom/log.db`; preserve all existing event IDs and original payloads.
Use an ordered migration table and transactions. Core logical records: events,
requests/runs, session_bindings, context_items/topics/work_observations,
context_packets/rendered_briefings/delivery_attempts/source_coverage,
checkpoints/helper_jobs, chunks/chunks_fts, artifacts and import manifests.
Final DDL is a phase deliverable, with foreign keys, unique idempotency keys and
indexes designed from query paths. Do not implement every optional table upfront.

One database owner per project, outside UI execution. Use the existing daemon
backend for the first flow, with indexed, paginated and bounded queries. The
current EventLog interface is synchronous: it cannot be transparently moved to a
worker without blocking waits or changing its contract. Do neither silently.
During P0 define an asynchronous internal command/read interface for any future
worker boundary; keep the existing synchronous facade in its owning execution
context. Never acknowledge a memory-only append before durable commit.

Measure daemon event-loop responsiveness in P3. If bounded operations still exceed
the agreed threshold, worker/process isolation becomes a release prerequisite
and must route legacy and new writers through the same owner. Its queue must be
bounded/ordered, with crash recovery and backpressure. Do not add a worker merely
to appear optimized, or create a second canonical database to avoid migration.

WAL requires a supported local filesystem; foreign keys, busy handling and
checkpoint/backpressure policies must be tested. Do not use a live copy of only
`log.db` as backup. Use the supported backup API or coordinated clean shutdown;
probe Node compatibility rather than assume the newest API exists on the current
minimum Node version. [SQLite WAL](https://sqlite.org/wal.html),
[backup API](https://sqlite.org/backup.html), [Node SQLite](https://nodejs.org/api/sqlite.html).

Artifacts are written to same-filesystem temporary paths, hashed, flushed and
atomically finalized before committing a database reference. Test crash windows;
clean unreferenced files only after a grace period and reference checks. Hashes
provide identity/integrity, not authorization. Bound decompression and media
parsing; safe relative paths cannot escape artifact storage via symlinks.

JSONL is export/import, not a dual live writer for the new continuity feature.
Legacy JSONL remains readable. Offer explicit, backed-up SQLite migration; do
not silently cut over or start an empty database. If both files contain distinct
history, reconcile with manifests/source mappings and visible conflicts. Preserve
source IDs where possible; collisions require namespaced import mappings.
An unavailable SQLite runtime keeps legacy behavior but reports new continuity
as unavailable until migration/support exists. No silent feature downgrade.

Cutover also migrates chat metadata and old instance resume slots. A legacy native
cursor can be mapped only to a verified owning conversation; ambiguous bindings
stay unassigned. Do not attach one cursor to every existing chat. Validate counts,
hashes, source references and Main compatibility before committing the cutover.
Rollback must export/include post-cutover events, not discard them by restoring
an old snapshot. Test new-version data with an older reader and fail clearly.

Chat hiding and explicit data deletion are distinct actions. Explicit deletion
invalidates dependent summaries/packets/indexes and cancels helper jobs. Prior
native sessions may retain submitted text; do not promise app deletion retracts
it. Team/private memory, cross-project retrieval, logs and exports require explicit
scope rules. Import external instructions as evidence without overwriting user
instruction files or changing permissions.

## 10. Work order and review gates

| Phase | Deliverables | Required evidence before proceeding |
| --- | --- | --- |
| P0: contracts and capabilities | Zod schemas, fixtures/profiles, supported-version policy, session identity and leases | Per-harness input/resume/stop/ack tests; semantic validation failures; no paid calls |
| P1: evidence/storage | Migrations, source refs, exact messages, artifacts, conversation state, FTS and project ownership | SQLite/JSONL reconciliation, rollback, crash/disk-full fixtures, original user intent recoverable |
| P2: deterministic continuity | Assembler, renderer, scoped reads, receipts, runs, sequential switching | Claude → Codex → Claude fake harness flow, corrections, unknown receipt recovery, no duplicate action execution |
| P3: long conversations | Checkpoints/compaction policy, bounded backend work, diagnostics and budgets; worker isolation if measurements require it | Buried small decisions, native/unknown compaction, overflow; long-history responsiveness/cost measurements |
| P4: optional helpers | Isolated low-cost summaries and title/topic generation | Source/authority validation, usage caps, provider-down fallback, quality comparison against exact replay |
| P5: integration/cutover | Verified OpenCode, team/bridge/queue/route consumers, removal of superseded injection | Regression suite, packaging and supported-platform checks; no hidden legacy context duplication |

Do not ship "seamless long-chat switching" after only P2's happy path. P3 is part
of the first usable product milestone. P4 is optional; P5 may gate release where
existing workflows would otherwise bypass context or writer ownership.

Acceptance requires: exact original user evidence recoverable; every active
instruction represented in the supplied packet; corrections supersede the correct
scoped revision; acknowledged coverage never crosses holes; no context leaks;
unknown outcomes never automatically replay edits; no required local model;
helper/provider outages preserve deterministic operation or explicit overflow.

Use recorded fixtures and deterministic assertions for structure, ordering,
coverage and recovery. Later authorized live evaluations test whether models
actually continue correctly; passing a schema test cannot prove model behavior.
Compare exact replay, current Loom and the new assembler on the same histories.
Measure p50/p95 assembly/switch latency, event-loop delay, memory, stored bytes,
added/retrieved/helper/native tokens and continuation outcomes. Freeze reference
hardware and proposed thresholds after baseline; do not invent achieved numbers.

## 11. Review choices

Recommended defaults for approval: Zod contracts; SQLite canonical storage;
no embeddings; deterministic first; one workspace writer; soft context budgets
above; helper jobs disabled until isolation/account-capability checks pass;
finish-then-switch; no automatic replay of unknown action submissions.

Decide during P0: minimum harness versions, CLI/app-server transport, a usable
read-only retrieval route per harness and legacy-session adoption rules. Decide
before release: reference hardware/performance thresholds, retention/export
controls, and the UI action for mandatory overflow. These are explicit gates,
not gaps to fill with guessed behavior during implementation.

This plan is ready for user review. Follow the companion TODO only after the user
authorizes implementation; current work changes documentation only.

## Implementation audit — 2026-09-28

The current code was audited against this plan and all E01–E64 requirements.
[BRAIN-AUDIT](../refactoring/BRAIN-AUDIT.md) records separate standards/spec reviews,
fixes, verification and remaining partial/gated work. This plan remains broader
than the supported opt-in milestone; unchecked release gates are not complete.
