import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/web/state.js", () => ({ state: { pid: "p", token: "token", project: null, timers: [], approvals: null } }));
vi.mock("../src/web/connection.js", () => ({ api: vi.fn(), checkBuild: vi.fn() }));
vi.mock("../src/web/agents.js", () => ({ labelOf: String, kindOf: () => "echo", agentGlyph: () => "", agentLabel: String,
  BRAND_TITLES: {}, brandMark: () => "", hasBrand: () => false, AGENT_LABELS: {} }));
vi.mock("../src/web/notifications.js", () => ({ toast: vi.fn(), announce: vi.fn(), notifyDone: vi.fn(), notifyNeedsInput: vi.fn() }));
vi.mock("../src/web/console.js", () => ({ addLogRecord: vi.fn() }));
vi.mock("../src/web/preview.js", () => ({ maybeReloadPreview: vi.fn(), onServerFrame: vi.fn(), onSpecFrame: vi.fn() }));
vi.mock("../src/web/statusbar.js", () => ({ drawStatusbar: vi.fn() }));
vi.mock("../src/web/team.js", () => ({ onTeamFrame: vi.fn(), orchGoalName: String }));
import { api } from "../src/web/connection.js";
import { state } from "../src/web/state.js";
import { approvalClick, openApprovalsPop } from "../src/web/approvals.js";
import { lineFor } from "../src/web/transcript.js";
import { createApprovalEvents } from "../src/web/project/approval-events.js";
import { createThread } from "../src/web/project/thread.js";

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); state.approvals = null; });
function mount(historyLoaded = true) {
  const dom = new JSDOM('<div><div id="feed"></div></div><button class="apbadge" id="badge"></button>', { url: "http://loom.test" });
  vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.window.document); vi.stubGlobal("localStorage", dom.window.localStorage);
  vi.stubGlobal("location", dom.window.location);
  const sockets: any[] = [];
  vi.stubGlobal("WebSocket", class { constructor() { sockets.push(this); } });
  const view: any = { pid: "p", chatId: "main", historyLoaded, pendingWs: [], syncStars: vi.fn(), markDays: vi.fn(), loadQueue: vi.fn(),
    onOrchEvent: vi.fn(), onFleetEvent: vi.fn(), updateModelLabel: vi.fn(), drawRail: vi.fn() };
  const thread = createThread(view);
  Object.assign(view, thread, createApprovalEvents({ ...view, reconcileApprovals: thread.reconcileApprovals }));
  return { dom, view, thread, sockets };
}
const request = { id: "gap", chat: "main", agent: "a", tool: "Bash", input: {}, sessionOption: true };

it.each(["main", "side"])("recovers a snapshot-only approval in %s after history and on socket hello (#6)", async chat => {
  const { view, thread, sockets } = mount(false);
  view.chatId = chat;
  const pending = { ...request, chat };
  vi.mocked(api).mockImplementation(async path => path.includes("/events?") ? { events: [] } : { approvals: [pending] });
  view.loadApprovals(); await Promise.resolve();
  expect(document.querySelector("#feed .apcard")).toBeNull();
  await thread.loadHistory();
  expect(document.querySelectorAll('#feed [data-approval="gap"]')).toHaveLength(1);
  document.getElementById("feed")!.innerHTML = "";
  thread.connect(); sockets[0].onopen();
  expect(document.querySelector("#feed .apcard")).toBeNull();
  sockets[0].onmessage({ data: JSON.stringify({ type: "hello" }) }); await Promise.resolve();
  expect(document.querySelectorAll('#feed [data-approval="gap"]')).toHaveLength(1);
  sockets[0].onmessage({ data: JSON.stringify({ type: "hello" }) }); await Promise.resolve();
  expect(document.querySelectorAll('#feed [data-approval="gap"]')).toHaveLength(1);
  vi.mocked(api).mockResolvedValue({ events: [{ id: 1, kind: "approval", agentId: "a", ts: Date.now(),
    payload: { phase: "requested", approvalId: "gap", tool: "Bash", input: {} } }] });
  await thread.loadEarlier();
  expect(document.querySelectorAll('#feed [data-approval="gap"]')).toHaveLength(1);
});

it("preserves session permission in the live badge and transcript card (#9)", async () => {
  const { view } = mount();
  const event = { kind: "approval", agentId: "a", chat: "main", ts: Date.now(),
    payload: { phase: "requested", approvalId: "session", tool: "Bash", input: {}, sessionOption: true } };
  view.onApprovalEvent(event);
  document.getElementById("feed")!.innerHTML = lineFor(event);
  openApprovalsPop(document.getElementById("badge"));
  expect(document.querySelectorAll('[data-apact="allow_session"]')).toHaveLength(2);
  await new Promise(resolve => setTimeout(resolve, 1));
});

it("clicks a stale card and folds it after the HTTP 404 rejection (#11)", async () => {
  const { dom, view } = mount();
  state.approvals = { pid: "p", list: [request] }; view.reconcileApprovals();
  vi.mocked(api).mockRejectedValue(new Error("no such approval (HTTP 404)"));
  document.addEventListener("click", approvalClick);
  document.querySelector<HTMLButtonElement>('[data-apact="allow"]')!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector(".apcard.done .apres")?.textContent).toContain("answered elsewhere"));
  expect(vi.mocked(api)).toHaveBeenCalledWith("/api/projects/p/approvals/gap", expect.objectContaining({ method: "POST", body: '{"decision":"allow"}' }));
  expect(state.approvals.list).toEqual([]);
});


it("keeps answered history folded while a new request owns the badge and pending card", async () => {
  const { dom, view, thread, sockets } = mount(false);
  const old = { id: 1, kind: "approval", agentId: "a", ts: Date.now(),
    payload: { phase: "requested", approvalId: "old", tool: "Mount gap", input: {} } };
  const decided = { ...old, id: 2, payload: { phase: "decided", approvalId: "old", tool: "Mount gap", behavior: "allow" } };
  vi.mocked(api).mockImplementation(async path => path.includes("/events?") ? { events: [old, decided] } : { approvals: [] });
  await thread.loadHistory();
  view.loadApprovals(); await Promise.resolve();
  expect(document.querySelector('.apcard.done[data-approval="old"]')).not.toBeNull();
  expect(document.querySelector('[data-approval="old"] [data-apact="allow"]')).not.toBeNull();
  expect(state.approvals.list).toEqual([]);
  thread.connect();
  const current = { ...old, id: 3, agentId: "plannerbot", payload: { ...old.payload, approvalId: "new", tool: "Bash" } };
  sockets[0].onmessage({ data: JSON.stringify({ type: "event", event: current }) });
  // This is the failing DOM test's former selector: it sees historical Mount gap.
  expect(document.querySelector('#feed .apcard .aptool')?.textContent).toBe("Mount gap");
  expect(state.approvals.list.map((a: any) => a.id)).toEqual(["new"]);
  const card = document.querySelector('.apcard:not(.done)')!;
  expect(card.getAttribute("data-approval")).toBe("new");
  expect(card.querySelector('.aptool')?.textContent).toBe("Bash");
  vi.mocked(api).mockResolvedValue({ ok: true });
  document.addEventListener("click", approvalClick);
  card.querySelector('button[data-apact="allow"]')!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await vi.waitFor(() => expect(card.classList.contains("done")).toBe(true));
  expect(vi.mocked(api)).toHaveBeenLastCalledWith("/api/projects/p/approvals/new", expect.objectContaining({ body: '{"decision":"allow"}' }));
  expect(state.approvals.list).toEqual([]);
  expect(document.querySelector('[data-approval="old"] .apres')?.textContent).toContain("allowed");
});
