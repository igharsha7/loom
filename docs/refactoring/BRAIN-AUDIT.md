# Brain cleanup and plan audit — 2026-09-28

Baseline: `584a3b6a86bfa9af2a0a8ecbeac57e6aa4578e7a` plus the uncommitted
implementation. Scope: native Brain, event storage, adapters, foreground turns,
queues, runtime entrypoints, HTTP and browser controls. No commit/push or paid
provider call was performed. Applied `code-review` (independent standards/spec
reviews) and `codebase-design` (keep ownership behind the existing interfaces).

## Standards review

Five initial correctness findings were fixed: cancellation during submission,
queue whitespace/idempotency, incomplete mode-change guards, late orchestra
rejection, and adapter preparation outside cleanup ownership. Follow-up fixes
cover inherited-pipe cleanup at parent exit, uncertain process-group errors and
reassembly overflow. Each has a focused regression or is exercised by the native
lifecycle fixtures. Heuristic duplication between legacy and native dispatch remains
an intentional compatibility seam; neither uses the other's briefing/extractor.

Additional cleanup removes four unused runtime forwarding methods, native legacy
agent-decision mining/text accumulation, duplicated semantic startup on mode changes,
and legacy extractor/embedding/projection controls while native mode is enabled.
Legacy SDK/team-memory interfaces remain supported when native continuity is off;
deleting those before protocol/route/OpenCode parity would break existing users.

## Spec review

Six initial gaps were corrected or bounded explicitly: current-request budget,
checkpoint revision coverage, new user evidence invalidating unsent snapshots,
atomic/addressable reconciliation, optional delta holes, and inherited descendant
containment. Follow-up review caught mixed packet/receipt links, repeat reconciliation,
failed Git observation treated as stable state, and evidence-count bounds; these were
fixed. Review did not certify the remaining release gates below.

Other fixes: distinguish agent-generated legacy decisions from user authority;
prevent tentative/helper supersession; fence uncertain writers against rewind/handoff;
wait for app-owned diff/commit writes before the next native turn; publish artifacts
without overwriting existing hashes, read without following final symlinks, verify
reference size/hash/path, and remove failed temporary artifacts. Native JSONL records
are bounded before readline can accumulate unlimited tool output. Configuration changes validate before activation and roll back ownership on failed
atomic config replacement; unresolved native leases also fence legacy journal writes.
FTS has update/delete
maintenance plus explicit transactional rebuild. Packet validation uses sets to avoid
quadratic mandatory-coverage scans; event attribution avoids loading a whole packet
for each native event.

Native queue action edits and autonomous routes now reject before execution until
durable revisions and root-task continuity are implemented. Queued target/model/text
remain frozen; timing changes/reordering are supported. Removing an unsent queue item
prevents dispatch but retains its original user evidence. This is not data erasure.

## Edge-case traceability

**Covered** means an implementation plus focused local fixtures, not live-provider or
all-platform certification. **Partial** records a working safeguard plus missing
requirements. **Gated** means explicitly unsupported/disabled or unimplemented.
Tests are in `test/continuity.test.ts`, `test/continuity-storage.test.ts`,
`test/continuity-http.test.ts`, native adapter and existing runtime/browser suites.
The original research matrix remains authoritative; this table reports implementation.

| Case | Status | Evidence / remaining requirement |
| --- | --- | --- |
| E01 | Covered | Buried user source fixture and 10,001-event benchmark; mandatory intent bypasses ranking. |
| E02 | Covered | Exact tentative discussion, explicit item status; no automatic acceptance. |
| E03 | Covered | Accepted user supersession, scoped revision checks; helper/tentative supersession rejected. |
| E04 | Partial | Chat/source scope and originals preserved; explicit task-level scopes not implemented. |
| E05 | Partial | Conflicting original statements remain; conflict classification/clarification is not automated. |
| E06 | Partial | Topic/deferred/rejected statuses retained; no native comprehension evaluation. |
| E07 | Gated | Message deletion/revision dependencies absent; native queue action edits explicitly rejected. |
| E08 | Covered | New governing user evidence invalidates unsent packets; queued/unsent requests are neither history nor invalidation (validation follow-up fix). |
| E09 | Covered | Same instance, distinct chat bindings; explicit native IDs. |
| E10 | Covered | Provider-specific bindings; Claude → Codex → Claude fixture. |
| E11 | Partial | Model/options/protocol/workspace fingerprint; external auth/entitlement discovery unverified. |
| E12 | Partial | Missing native acknowledgement stays unknown; manual reconciliation resets epoch. No automatic expiry recovery. |
| E13 | Covered | Both harnesses report compaction (Claude `compact_boundary`, Codex app-server `contextCompaction`); the binding is marked compacted and the next packet rebuilds state into the resumed session. |
| E14 | Partial | Retention unknown; protected user evidence repeated. Native reconstruction triggers pending. |
| E15 | Partial | Ordinary turn-input fixture avoids append-system prompt; live continuation quality unverified. |
| E16 | Partial | Canonical checkout, HEAD/dirty content and instruction fingerprints; non-Git file applicability and moved-store migration pending. |
| E17 | Covered | Picker changes only local selection; dispatch freezes target later. |
| E18 | Covered | Queued captured target/model stays unchanged after picker changes. |
| E19 | Covered | Foreground reservation, queueing and process-group interruption. |
| E20 | Partial | Inherited tool group and output-pipe fixture; escaped/detached descendants and Windows containment remain gates. |
| E21 | Partial | Failed lifecycle stop blocks successors; uncertain termination retains lease. Real approval dialogs unverified. |
| E22 | Partial | Run/binding/epoch correlation and original chat lookup; broader reordered/late-provider fixtures pending. |
| E23 | Covered | Request idempotency, one foreground writer across pinned chats/queue; unsent retries re-run instead of silently no-oping. |
| E24 | Partial | Orchestra/subagents/bridges/routes gated before mutation; full worktree/team parity pending. |
| E25 | Covered | Immutable prepared packet/receipt; revalidation before any native call. |
| E26 | Covered | Restart submitting intent becomes unknown with lease retained. |
| E27 | Covered | No automatic replay; explicit reconciliation. Native message discovery unavailable. |
| E28 | Covered | Spawn/init separate from acceptance; proven no-launch rejection releases safely. |
| E29 | Covered | Acceptance and execution separate; quiescence uncertainty retains lease. |
| E30 | Partial | Stable client request IDs; stale run correlation. No universal native event-ID deduplication. |
| E31 | Partial | Active/unknown lease retained across restart; genuine orphan OS fault matrix pending. |
| E32 | Partial | Live owner/host/PID fence and conservative takeover; no heartbeat/remote-filesystem certification. |
| E33 | Covered | Strict bounded Zod contracts, unknown versions, extra fields, nesting and boolean fixtures. |
| E34 | Covered | Project/chat/hash and UTF-8 source checks; helpers disabled. |
| E35 | Partial | Originals retained; removing checkpoint sources restores mandatory evidence; user must review summary fidelity. |
| E36 | Covered | Exact whitespace/Unicode capture, byte-boundary checks, quoted rendering; heuristic labelled. |
| E37 | Partial | Codex final shell exit and full large-output artifact; Claude final tool-result normalization pending. |
| E38 | Partial | Missing completion/failed streams are not success; complete partial-message/tool lifecycle schema pending. |
| E39 | Gated | Current snapshot checked; per-verification historical workspace applicability not implemented. |
| E40 | Covered | Immutable packet/receipt links, source/outcome/coverage checks, epoch/state/workspace revalidation. |
| E41 | Covered | Current request included in heuristic budget; durable overflow/reassembly and explicit resume. Native capacity unknown. |
| E42 | Covered | Deltas cover every observation since the basis packet plus prior omissions; user sources a session lacks are resent exact or referenced. |
| E43 | Partial | FTS backfill/update/delete/rebuild and lexical fallback; actual index/DB corruption fault matrix pending. |
| E44 | Partial | Escaped bounded FTS, scoped reads; aliases/entity expansion and broad paginated search pending. |
| E45 | Covered | Mandatory text inline, verified local artifact reference, attachments/capabilities fail explicitly. |
| E46 | Gated | Helpers disabled; no automatic expensive substitution. |
| E47 | Gated | No helper jobs; helper result invalidation must precede enablement. |
| E48 | Gated | No helper scheduling; account/global concurrency gate remains. |
| E49 | Partial | Transaction/foreign-key/busy and reconciliation rollback fixtures; real disk-full/OS permission matrix pending. |
| E50 | Partial | Busy timeout and bounded indexed work; long-reader/WAL/backpressure corpora pending. |
| E51 | Partial | SQLite required, unknown protocol/platform explicit; network filesystem detection/certification pending. |
| E52 | Partial | Flush/exclusive artifact publication before reference; temporary cleanup; orphan GC/grace period pending. |
| E53 | Partial | Hash/path/size/no-follow checks and corruption fixtures; media/binary decoding unsupported. |
| E54 | Partial | Consistent activation backup and transactional import; post-cutover downgrade/export pending. |
| E55 | Covered | Torn records/ID collisions/distinct histories rejected; originals/backups retained; idempotent import. |
| E56 | Covered | Legacy native cursor never adopted into a chat binding. |
| E57 | Partial | Chat/project source scope before search/read/artifact export; team/private parity remains gated. |
| E58 | Partial | Origin-labelled JSON-quoted data; no application replay. Model resistance to adversarial evidence unmeasured. |
| E59 | Covered | Instruction fingerprint, no user-file overwrite, legacy imported memory not injected in native mode. |
| E60 | Gated | Complete deletion/derived artifact/backup/native-copy policy absent; hiding is not deletion. |
| E61 | Partial | No fallback execution; pending capture preserved. Live offline/auth/quota/account matrix pending. |
| E62 | Covered | Unsupported attachment representations explicitly rejected; no visual-understanding claim. |
| E63 | Partial | Canonical stable request IDs and bounded packet summaries; request-ID persistence across browser reload pending. |
| E64 | Partial | Bounded contract diagnostics and project-authenticated routes; sensitive native output redaction/export policy pending. |

## Verification receipt

No live harness/account, Windows Job Object, escaped-child or network-filesystem
certification is implied by local fixtures. Native mode remains opt-in.

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

## Validation follow-up — 2026-09-28

A later review reproduced four defects (delta coverage window, unsent requests
rendered as history, capture before harness preflight with a silent retry no-op,
and superseded checkpoints hiding originals). All are fixed with regressions; see
[BRAIN-TODO](BRAIN-TODO.md#validation-follow-up--2026-09-28). The version allow-list was
replaced by a 20 s reachability monitor, and assembly now sends a resumed native
session only what it lacks. Full suite after the fixes: 1,419 non-DOM and 125
browser tests passed; 17 existing skips.

## Transport change (app-server / Agent SDK)

Codex moved from `codex exec --json` to `codex app-server` JSON-RPC and Claude Code
from `claude -p` to the Claude Agent SDK, following t3code. Brain-relevant effects:

- Acceptance evidence is explicit on both: Codex's `turn/start` response or
  `turn/started`; Claude's `requesting` status or first output.
- A lost native session is reported before any turn starts (`NativeSessionMissing`);
  `settled()` fails the receipt and moves the binding to a new epoch, so the next
  packet reconstructs instead of sending a delta to an empty session.
- Prompts travel on stdin, which removes the Linux argv limit.
- A stream failure (an oversized record) now stops RPC parsing before anything else
  is imported, and the failure's own message is kept.
- Codex `run_complete` no longer adds cached input to input (cached is a subset).

