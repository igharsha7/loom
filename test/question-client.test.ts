import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("../src/web/connection.js", () => ({ api }));
let dom: JSDOM, lineFor: (event: unknown) => string, settle: (event: unknown, root?: Element) => void;
let createOrchestra: (view: unknown) => { needsInputClick: (event: unknown) => boolean }, state: Record<string, any>;
beforeAll(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.window.document); vi.stubGlobal("localStorage", dom.window.localStorage);
  const transcript = await import("../src/web/transcript.js"); lineFor = transcript.lineFor; settle = transcript.settleQuestionCards;
  createOrchestra = (await import("../src/web/project/orchestra.js")).createOrchestra;
  state = (await import("../src/web/state.js")).state;
  state.project = { agents: [{ id: "agent", kind: "echo" }] };
});
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });
const question = (id: string, multiSelect = false) => ({ id: 1, kind: "needs_input", agentId: "agent", chat: "main", payload: {
  requestId: id, responseMode: "tool", question: "Which?", questions: [{ id: "colors", question: "Which colors?", multiSelect,
    options: [{ label: "Blue" }, { label: "Red" }] }] } });

describe("structured question client regressions", () => {
  it("folds answered/cancelled cards and preserves resolution when history reloads (#21)", () => {
    const root = document.createElement("div"); root.innerHTML = lineFor(question("answered"));
    const resolved = { kind: "status", payload: { state: "question_answered", requestId: "answered", answers: { colors: "Blue" } } };
    settle(resolved, root);
    expect(root.querySelector(".nicard")!.classList.contains("done")).toBe(true);
    expect([...root.querySelectorAll<HTMLButtonElement>("button")].every(b => b.disabled)).toBe(true);
    root.innerHTML = lineFor(question("answered")); expect(root.querySelector("button")).toBeNull();
    settle({ kind: "status", payload: { state: "question_answered", requestId: "cancelled", answers: {} } }, root);
    root.innerHTML = lineFor(question("cancelled")); expect(root.textContent).toContain("Cancelled"); expect(root.querySelector("button")).toBeNull();
  });
  it("keeps multiple selections and sends them only on explicit submission (#22)", async () => {
    api.mockClear();
    const root = document.createElement("div"); root.innerHTML = lineFor(question("multi", true));
    const card = root.querySelector(".nicard")!, orchestra = createOrchestra({ pid: "p", chatId: "main" });
    const click = (selector: string) => orchestra.needsInputClick({ target: root.querySelector(selector) });
    click('[data-nipick="Blue"]'); click('[data-nipick="Red"]');
    expect(api).not.toHaveBeenCalled(); expect(card.querySelectorAll(".nio.sel")).toHaveLength(2);
    click(".nisend"); await Promise.resolve();
    expect(JSON.parse(api.mock.calls[0]![1].body).answers).toEqual({ colors: ["Blue", "Red"] });
    expect(card.classList.contains("done")).toBe(true);
    click('[data-nipick="Blue"]'); expect(api).toHaveBeenCalledTimes(1);
  });
});
