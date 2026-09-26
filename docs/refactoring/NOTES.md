# Modularization notes

## Constraints
- No framework migration in this change; Next.js is a possible later choice.
- Preserve URLs, event payloads, persisted config/state, and the public SDK.
- Keep changes on `dev/Harsha`; no publishing or deployment is requested.
- Ordinary tests use fake agents and isolated LOOM_HOME. Do not run paid
  `verify-*` scripts as regression tests.

## Baseline observations
- `app-page.ts`: 15,434 lines, HTML/CSS/browser JS inside a TS template literal.
- `server.ts`: 5,148 lines, route registration plus daemon lifecycle.
- `runtime.ts`: 3,815 lines, project coordination plus multiple state owners.
- Root dependencies were absent; Node 24.3.0 and npm 11.14.1 are installed.
- `npm test` omits app-page-console-dom, app-queue-dom, app-servers-dom and
  app-update-dom after excluding them from the parallel pass. Include all DOM
  suites in final verification.
- Historical design documents are not authoritative for current behavior.

## Progress and decisions
- Browser: ordinary ES modules in `src/web`, feature factories for per-project
  closures, ordered CSS layers, and a document shell. esbuild packages the JS;
  assets remain inline in the served page. No framework decision is required.
- API: ordered feature registrars in `src/daemon/routes`, each receiving a typed
  subset of daemon capabilities. Middleware and WebSocket lifecycle stay in
  `server.ts`. Shared system helpers preserve their old exports.
- Runtime: accounting, briefings, queue and turns own their state under
  `src/daemon/runtime`. ProjectRuntime remains the public coordinator.
- Build and desktop staging include generated web assets; daemon fingerprints
  include CSS and HTML so desktop detects style-only changes.
- Explicit dependency analysis exposed pre-existing out-of-scope browser calls:
  preview attachments, notification replies, and explorer refresh. These now
  use explicit mounted-project callbacks. Late screenshots are discarded if
  their composer has been replaced by navigation.

## Verification history
- Initial build passed. The initial full test run in the sandbox hit EPERM
  opening local sockets: 57 failed files, 69 passed, 1 skipped. This is not a
  usable green baseline. Subsequent integration runs use allowed local sockets.
- Browser extraction: 88 DOM checks passed; 45 static page checks passed.
- Route extraction: 8 suites / 110 tests passed (auth, daemon, scoped clients,
  workspace, relay, tasks, skills MCP, providers).
- Runtime extraction: 124 tests passed, two test fixtures referenced a private
  map that moved. Fixtures now access its owning turn module; the full rerun passes.
- Full suite found a real source-mode regression: type-only re-exports worked
  under tsc/Vitest but failed in the CLI's tsx process. Marked those exports
  `type`; all 126 non-DOM suites now pass (1,342 tests, 17 skipped).
- Browser unresolved-name analysis: zero unresolved names after extraction.
- npm pack dry-run includes all four `dist/web` artifacts. Docker runner now
  copies the browser build script; desktop staging verifies the new assets.
- Build/typecheck/diff checks pass. Default DOM suites pass; pipe validation
  exposed a timing-sensitive target-selector test in the previously omitted
  queue suite. It now pauses the queue during selection instead of depending
  on a two-second agent sleep; all six queue DOM tests pass in both modes.

## Current module map

| Previous hotspot | Current coordinator | Extracted responsibilities |
| --- | --- | --- |
| `app-page.ts` (15,434 lines) | 30 lines | `src/web/`: entry, feature modules, project factories, CSS layers and shell |
| `server.ts` (5,148 lines) | 863 lines | `routes/`: typed feature registrars; `system.ts`: shared process helpers |
| `runtime.ts` (3,815 lines) | 2,633 lines | `runtime/`: accounting, briefings, queue and turns; shared contracts in `runtime-support.ts` |

All 217 literal HTTP registrations retain their original method/path order.
The emitted CSS and non-script HTML match the original served page byte for byte.
Feature factory exports were pruned to callbacks the coordinator actually uses;
state setters are exposed only where the feature writes that binding.

## Validation scope and follow-up boundaries

- The default backend passed 1,342 non-DOM tests and all 125 DOM tests (the new
  screenshot navigation test was corrected and passed in a focused rerun).
- The source-mode CLI regression is fixed; compiled and source entrypoints are
  both covered. Source-mode BUILD_REV retains the original `dev` marker.
- Phone protocol copies match; all 41 phone pure-logic tests pass.
- Docker image, Electron GUI and native phone builds were not run. Runner
  build inputs and packaged asset paths were checked; desktop behavior has
  automated coverage. Phone dependencies are not installed in this checkout.
- No paid agent verification, deployment or framework migration.
- This is an extraction with stable contracts. Browser shared session state and
  per-project view coordination remain explicit; runtime agent event handling,
  handoffs and orchestra lifecycle still live in ProjectRuntime. Future work
  can change these boundaries incrementally once the framework is chosen.
- Browser edits require rebuilding assets; there is no watch pipeline yet.


## Final verification

Completed on Node 24.3.0 / macOS. Full runs plus focused reruns after corrections:

| Configuration | Passing tests | Skipped tests |
| --- | --- | --- |
| Default: non-DOM + DOM | 1,342 + 125 = 1,467 | 17 |
| Forced pipe: non-DOM + DOM | 1,339 + 125 = 1,464 | 20 |
| Phone pure logic | 41 | 0 |

The full default attempt needed a focused rerun of the new screenshot test
fixture; the full pipe attempt needed a focused rerun of the queue target test
fixture. Both corrected suites pass. The final queue test also passes under
the default backend. No unresolved test failures remain; a final monolithic
`npm test` was not repeated after those focused reruns.

Additional checks passed: `npm run build`, `npm run typecheck`, phone relay-copy
consistency, npm package dry-run asset inclusion, browser unresolved-name
analysis, exact CSS/non-script HTML comparison, endpoint registration order,
and whitespace checks for both tracked and new files.

Local test logs (temporary, not committed): `/tmp/loom-final-tests.log`,
`/tmp/loom-pipe-tests.log`, `/tmp/loom-screenshot-tests.log`,
`/tmp/loom-default-queue-tests.log`, `/tmp/loom-pipe-queue-tests.log`, and
`/tmp/loom-phone-tests.log`.

Branch is `dev/Harsha`, based on main at `838f994`. Publication target is
`igharsha7/loom` (`origin`); the original repository is retained as `upstream`.
TODO.md has no remaining work within the requested three steps.
