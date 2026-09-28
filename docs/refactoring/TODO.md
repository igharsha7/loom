# Modularization work

Branch: `dev/Harsha`, based on local `main` at `838f994`.

Scope: preserve existing behavior and public contracts while separating the web
client, HTTP routes, and project runtime. Framework selection is deferred.

## 0. Baseline
- [x] Create the requested branch from main; confirm a clean checkout.
- [x] Read contribution instructions and map the three large modules.
- [x] Install dependencies and build; baseline test run was blocked by sandbox socket restrictions (see notes).

## 1. Web client
- [x] Extract browser JavaScript, styles, and document shell.
- [x] Split browser behavior into feature modules with explicit dependencies.
- [x] Preserve startup order, pairing, asset packaging, and desktop/phone behavior.
- [x] Run script parsing, DOM, packaging, and daemon tests.

## 2. HTTP routes
- [x] Separate route registration by feature with typed dependencies.
- [x] Preserve middleware order, authentication, response shapes, and streaming.
- [x] Run API, auth, WebSocket, and affected integration tests.

## 3. Project runtime
- [x] Extract accounting and budget ownership.
- [x] Extract briefing and memory coordination.
- [x] Extract queue coordination and turn execution.
- [x] Preserve lifecycle, interruption, retries, chat routing, and cleanup.
- [x] Run runtime, adapter, queue, memory, route, and orchestra regressions.

## 4. Finish
- [x] Update source maps and contributor instructions.
- [x] Build, typecheck, run the full suite including omitted DOM suites.
- [x] Verify packaging and `git diff --check`.
- [x] Record limitations and final verification in NOTES.md.

Completed: all three requested extractions. Framework selection remains deferred.
See NOTES.md for verification results and deliberately retained boundaries.

The next authorized phase is tracked in [BOUNDARIES.md](BOUNDARIES.md): separating
storage, native adapters, Brain preparation and client delivery before building
Brain continuity. The completed checklist above describes the earlier extraction.

Brain continuity implementation is tracked separately in [BRAIN-TODO.md](BRAIN-TODO.md),
with source research and edge-case IDs in [BRAIN-NOTES.md](BRAIN-NOTES.md).
The plan is awaiting user review; the checklist does not authorize implementation.
