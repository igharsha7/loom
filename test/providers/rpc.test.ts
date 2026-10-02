import type { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { CodexRpc } from "../../src/providers/codex/rpc.js";

it("rejects pending and future RPCs on an asynchronous stdin EPIPE (round 15 #5)", async () => {
  const error = Object.assign(new Error("broken stdin"), { code: "EPIPE" });
  let finish!: (error?: Error | null) => void;
  const stdin = new Writable({ write(_data, _encoding, callback) { finish = callback; } });
  const stdout = new PassThrough();
  const rpc = new CodexRpc({ stdin, stdout } as ChildProcess, { notification: vi.fn(), request: async () => ({}) });
  const first = expect(rpc.request("first", {}, 0)).rejects.toBe(error);
  const second = expect(rpc.request("second", {}, 0)).rejects.toBe(error);
  // write() has already returned; the transport error arrives on a later tick.
  queueMicrotask(() => finish(error));
  await Promise.all([first, second]);
  await expect(rpc.request("later", {}, 0)).rejects.toBe(error);
  expect(() => { rpc.notify("late"); stdin.emit("error", error); }).not.toThrow();
  stdout.destroy();
});

it("closes RPC when stdin is unwritable or write throws (round 15 #5)", async () => {
  for (const writable of [true, false]) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const error = new Error("write failed");
    if (writable) vi.spyOn(stdin, "write").mockImplementation(() => { throw error; });
    else stdin.end();
    const rpc = new CodexRpc({ stdin, stdout } as ChildProcess, { notification: vi.fn(), request: async () => ({}) });
    await expect(rpc.request("test", {}, 0)).rejects.toThrow(writable ? "write failed" : "not writable");
    stdout.destroy(); stdin.destroy();
  }
});
