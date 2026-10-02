import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/web/agents.js", () => ({ labelOf: String }));
vi.mock("../src/web/connection.js", () => ({ api: vi.fn() }));
vi.mock("../src/web/format.js", () => ({ esc: (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;"), pageGone: () => false }));
vi.mock("../src/web/notifications.js", () => ({ askConfirm: async () => true, toast: vi.fn() }));
vi.mock("../src/web/state.js", () => ({ state: { project: { agents: [] } } }));
import { api } from "../src/web/connection.js";
import { createQueue } from "../src/web/project/queue.js";
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
function mount() {
  const dom = new JSDOM('<div id="cqueue"></div>'); vi.stubGlobal("document", dom.window.document);
  const view = { pid: "p", queue: { items: [], paused: false } } as any;
  const queue = createQueue(view);
  const snapshot = (revision: number, texts = ["one", "two"], paused = false) => ({ projectId: "p", version: { epoch: "daemon", revision },
    queue: texts.map(text => ({ id: text, text })), paused });
  return { dom, view, queue, snapshot };
}
it("rejects a delayed HTTP snapshot after a newer socket order and pause (#3)", async () => {
  const { queue, view, snapshot } = mount();
  let resolve!: (snapshot: any) => void;
  vi.mocked(api).mockReturnValue(new Promise(r => { resolve = r; }));
  queue.onQueueFrame(snapshot(1)); queue.loadQueue();
  queue.onQueueFrame(snapshot(3, ["two", "one"], true));
  resolve(snapshot(2)); await Promise.resolve();
  expect(view.queue.items.map((i: any) => i.id)).toEqual(["two", "one"]); expect(view.queue.paused).toBe(true);
  document.querySelector<HTMLButtonElement>('[data-q="pause"]')!.click();
  expect(JSON.parse(vi.mocked(api).mock.calls.at(-1)![1]!.body as string)).toEqual({ paused: false });
});
it("keeps the editing draft, focus and selection through duplicates and other items draining (#4)", () => {
  const { dom, queue, snapshot } = mount(); queue.onQueueFrame(snapshot(1));
  document.querySelector<HTMLElement>('[data-q="edit"]')!.click();
  const box = document.querySelector<HTMLTextAreaElement>('[data-qedit]')!;
  box.value = "unsaved draft"; box.focus(); box.setSelectionRange(3, 7);
  queue.onQueueFrame(snapshot(1)); queue.onQueueFrame(snapshot(2, ["one"]));
  expect(document.querySelector('[data-qedit]')).toBe(box); expect(box.value).toBe("unsaved draft");
  expect(document.activeElement).toBe(box); expect([box.selectionStart, box.selectionEnd]).toEqual([3, 7]);
  box.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(document.querySelector('[data-qedit]')).toBeNull(); expect(document.querySelector('.cqtext')!.textContent).toBe("one");
});

it("rejects an old daemon HTTP response after a new daemon socket frame (#3)", async () => {
  const { queue, view, snapshot } = mount();
  let resolve!: (snapshot: any) => void;
  vi.mocked(api).mockReturnValue(new Promise(r => { resolve = r; }));
  queue.loadQueue();
  queue.onQueueFrame({ ...snapshot(1, ["two"], true), version: { epoch: "new", revision: 1 } });
  resolve(snapshot(99)); await Promise.resolve();
  expect(view.queue.items.map((i: any) => i.id)).toEqual(["two"]); expect(view.queue.paused).toBe(true);
});

it("keeps the latest HTTP read across a restart before any socket frame (#4)", async () => {
  const { queue, view, snapshot } = mount();
  const replies: Array<(value: any) => void> = [];
  vi.mocked(api).mockImplementation(() => new Promise(resolve => replies.push(resolve)));
  queue.loadQueue(); queue.loadQueue();
  replies[1]!({ ...snapshot(1), version: { epoch: "new", revision: 1 } }); await Promise.resolve();
  replies[0]!({ ...snapshot(8), version: { epoch: "old", revision: 8 } }); await Promise.resolve();
  queue.onQueueFrame({ ...snapshot(2, ["current"]), version: { epoch: "new", revision: 2 } });
  expect(view.queue.version).toEqual({ epoch: "new", revision: 2 });
  expect(view.queue.items.map((i: any) => i.text)).toEqual(["current"]);
});
