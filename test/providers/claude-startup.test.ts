import { afterEach, expect, it, vi } from "vitest";
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeProviderAdapter } from "../../src/providers/claude/adapter.js";
import { MemorySessionDirectory } from "../../src/providers/directory.js";
import { ProviderService } from "../../src/providers/service.js";
import { tmpDir } from "../helpers.js";

afterEach(() => vi.resetAllMocks());

it.each(["before", "around"])("rejects a Claude stream ending %s initialization and can start again (round 15 #3)", async timing => {
  let initialize!: (value: any) => void, end!: () => void;
  const initialized = new Promise<any>(resolve => { initialize = resolve; });
  const ended = new Promise<void>(resolve => { end = resolve; });
  const fake = { initializationResult: () => initialized, close: vi.fn(),
    async *[Symbol.asyncIterator]() { await ended; } };
  vi.mocked(query).mockReturnValueOnce(fake as any);
  const adapter = new ClaudeProviderAdapter("startup", { bin: process.execPath });
  const events: any[] = []; adapter.onEvent(e => events.push(e));
  const service = new ProviderService(new MemorySessionDirectory()); service.register(adapter);
  const input = { threadId: "main", instanceId: "startup", cwd: tmpDir("startup"), runtimeMode: "auto-accept-edits" as const };
  const rejected = expect(service.ensureSession(input)).rejects.toThrow(/exited during initialization/);
  end();
  if (timing === "around") queueMicrotask(() => initialize({}));
  await rejected;
  initialize({});
  expect(adapter.hasSession("main")).toBe(false);
  expect(events.some(e => e.type === "session.started")).toBe(false);
  expect(fake.close).toHaveBeenCalled();
  let close!: () => void;
  const live = new Promise<void>(resolve => { close = resolve; });
  vi.mocked(query).mockReturnValueOnce({ initializationResult: async () => ({}), close,
    async *[Symbol.asyncIterator]() { await live; } } as any);
  try {
    expect((await service.ensureSession(input)).session.status).toBe("ready");
    expect(adapter.hasSession("main")).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  } finally { await service.stopAll(); }
});
