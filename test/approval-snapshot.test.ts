import { expect, it, vi } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { tmpDir, waitUntil } from "./helpers.js";

it("keeps the approval's thread in the pending HTTP snapshot (#6)", async () => {
  process.env.LOOM_HOME = tmpDir("approval-snapshot-home");
  const daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const log = { append: vi.fn() };
  const runtime = vi.spyOn(daemon as any, "runtime").mockResolvedValue({ chatOf: () => "side", log });
  try {
    const pending = (daemon as any).askHuman({ project: "p", agent: "a", tool: "Bash", input: {}, sessionOption: true });
    const approvals = (daemon as any).approvals as Map<string, { chat: string; sessionOption?: boolean; settle: (decision: { behavior: "allow" }) => void }>;
    await waitUntil(() => approvals.size === 1);
    const approval = [...approvals.values()][0]!;
    expect(approval).toMatchObject({ chat: "side", sessionOption: true });
    expect(log.append.mock.calls[0]![0]).toMatchObject({ chat: approval.chat });
    approval.settle({ behavior: "allow" });
    expect(await pending).toEqual({ behavior: "allow" });
  } finally { runtime.mockRestore(); await daemon.close(); }
});
