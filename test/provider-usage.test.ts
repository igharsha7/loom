import { describe, expect, it, vi } from "vitest";
vi.mock("../src/web/format.js", () => ({ esc: String, tokens: String }));
import { observeUsage } from "../src/web/usage.js";

describe("registry account identities in the browser", () => {
  it("shares limits within an account and keeps other accounts separate for any driver", () => {
    const roster = ["a", "a", "b"].map((accountKey, index) => ({ id: String(index), kind: "server-driver",
      provider: { driverKind: "server-driver", accountKey, limitsProvider: "server" }, limits: null as any }));
    const project = { agents: roster };
    expect(observeUsage(project, { agentId: "0", kind: "status", ts: 1,
      payload: { state: "usage_limits", provider: "server", accountKey: "a", windows: [{ id: "weekly", usedPercent: 90 }] } })).toBe(true);
    expect(roster[0]!.limits).toEqual(roster[1]!.limits);
    expect(roster[0]!.limits.windows).toHaveLength(1);
    expect(roster[2]!.limits).toBeNull();
    observeUsage(project, { agentId: "2", kind: "status", ts: 2,
      payload: { state: "usage_limits", provider: "server", accountKey: "a", windows: [] } });
    expect(roster[2]!.limits).toBeNull();
  });
  it("uses roster account identity when legacy events omit it", () => {
    const agents = ["one", "two"].map(id => ({ id, kind: "codex", provider: { accountKey: "codex", limitsProvider: "codex" }, limits: null as any }));
    observeUsage({ agents }, { agentId: "one", kind: "status", ts: 1, payload: { state: "usage_limits", provider: "codex", windows: [] } });
    expect(agents[0]!.limits).toEqual(agents[1]!.limits);
    expect(agents[0]!.limits).toMatchObject({ provider: "codex" });
  });
});
