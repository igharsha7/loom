# HTTP route registration

`server.ts` owns the Express instance, middleware ordering, daemon lifecycle,
and WebSocket transport. It calls feature registrars in the original endpoint
order. Keep public setup/pairing/approval endpoints before the bearer wall and
protected feature routes after authentication and scope checks.

Each registrar receives a `Pick<RouteContext, ...>` with only its dependencies.
Live daemon values are getters; operations are callbacks bound by the server.
Do not import or reach into the LoomDaemon instance from a registrar.
`runtime-handler.ts` preserves the common project lookup/error response policy.
Shared process helpers live in `../system.ts`; public exports remain available
from `../server.ts` for existing consumers.

When moving or adding a route, preserve HTTP method, registration order,
authentication/scope, response shape, stream lifetime, and error mapping.
Validate with the relevant API tests plus `auth`, `scoped-clients`, and `daemon`
suites. WebSocket behavior remains covered by daemon/runtime integration tests.
