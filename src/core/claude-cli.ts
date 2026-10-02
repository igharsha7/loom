/** Legacy public helper; the concrete command belongs to its driver. */
import { providerRegistry } from "../providers/registry.js";
export type { ClaudeCliOptions } from "../providers/claude/cli.js";
export function claudeText(prompt: string, opts: { model?: string; timeoutMs?: number } = {}): Promise<string> {
  const driver = providerRegistry.require("claude-code");
  if (!driver.internalText) throw new Error("internal reasoning is unavailable");
  return driver.internalText(prompt, opts);
}
