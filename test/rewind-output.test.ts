import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { rewindSummary } from "../src/cli/rewind-output.js";
import type { RewindResult } from "../src/daemon/runtime/turns.js";

const released = { recoveryReleased: true, message: "rewind recovery released; the original checkout no longer exists, so no files were restored", changed: [], conversation: [] } as const;

it("reports successful recovery in the CLI without claiming rewind or suggesting an undo", () => {
  const out: RewindResult = { ...released, changed: [], conversation: [] };
  expect(rewindSummary(out)).toBe(released.message);
  expect(rewindSummary(out)).not.toContain("loom rewind");
});

it("keeps the normal CLI rewind summary and undo instruction", () => {
  const checkpoint = { id: "c123", label: "before", commit: "abc", at: 1, branch: null, dirty: 1, store: "git" as const };
  expect(rewindSummary({ restored: checkpoint, undo: { ...checkpoint, id: "c456" }, changed: ["app.txt"], conversation: [] }))
    .toBe("rewound · 1 file · undo the files with `loom rewind c456`");
});

it("reports recovery in the web UI and re-enables the button without claiming a rewind", async () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../src/web/project/orchestra.js"), "utf8");
  const start = source.indexOf("    function askRewind(");
  const end = source.indexOf("\n    /**", start);
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
  const toast = vi.fn(), refreshTree = vi.fn(), confirm = vi.fn().mockReturnValue(true);
  const refused = Object.assign(new Error("files alone?"), { code: "conversation_refused" });
  const api = vi.fn().mockRejectedValueOnce(refused).mockResolvedValueOnce(released);
  const state = { checkpoints: [{ id: "c123", label: "before" }] };
  const btn = { disabled: false };
  const askRewind = runInNewContext(source.slice(start, end) + "\naskRewind;", { state, view: { pid: "project", refreshTree }, window: { confirm }, api, toast, encodeURIComponent });
  askRewind("c123", btn);
  await vi.waitFor(() => expect(btn.disabled).toBe(false));
  expect(api).toHaveBeenLastCalledWith(expect.stringContaining("/c123/rewind"), { method: "POST", body: JSON.stringify({ conversation: false }) });
  expect(toast).toHaveBeenCalledExactlyOnceWith(released.message);
  expect(refreshTree).not.toHaveBeenCalled(); expect(state.checkpoints).toBeNull();
});
