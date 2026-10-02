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

it("preserves unrelated blocked windows and clears only updated reasons (A4)", () => {
  const agent = { id: "a", kind: "claude-code", limits: null as any };
  const fold = (id: string, reached?: string) => observeUsage({ agents: [agent] }, { agentId: "a", kind: "status", ts: 1,
    payload: { state: "usage_limits", provider: "claude", windows: [{ id, usedPercent: reached ? 100 : 10 }], reached } });
  fold("five_hour", "five_hour"); fold("seven_day", "seven_day"); fold("seven_day");
  expect(agent.limits.reached).toBe("five_hour"); fold("five_hour"); expect(agent.limits.reached).toBeNull();
});

it("keeps identically named accounts on different drivers separate (B3)", () => {
  const agents = ["codex", "claude-code"].map(kind => ({ id: kind, kind, provider: { driverKind: kind, accountKey: "work" }, limits: null as any }));
  observeUsage({ agents }, { agentId: "claude-code", kind: "status", ts: 1,
    payload: { state: "usage_limits", provider: "claude", accountKey: "work", windows: [], reached: "five_hour" } });
  observeUsage({ agents }, { agentId: "codex", kind: "status", ts: 2,
    payload: { state: "usage_limits", provider: "codex", accountKey: "work", windows: [] } });
  expect(agents[1]!.limits.reached).toBe("five_hour"); expect(agents[0]!.limits.reached).toBeNull();
});
