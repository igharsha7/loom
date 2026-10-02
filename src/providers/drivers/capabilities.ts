import type { AdapterCapabilities } from "../contracts.js";
export const codexCapabilities: AdapterCapabilities = { sessionModelSwitch: "in-session", supportsConversationRollback: true,
  manualCompaction: true, planMode: "native", compaction: { type: "request" }, writerSettlement: "tracked", fencing: "process-group" };
export const claudeCapabilities: AdapterCapabilities = { sessionModelSwitch: "in-session", supportsConversationRollback: true,
  manualCompaction: false, planMode: "native", compaction: { type: "slash-command", command: "/compact" }, writerSettlement: "tracked", fencing: "process-group" };
