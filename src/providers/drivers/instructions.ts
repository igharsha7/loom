import os from "node:os";
import path from "node:path";
import type { InstructionSources } from "../instructions.js";

export function codexInstructions(): InstructionSources {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return { ancestorFiles: ["AGENTS.override.md", "AGENTS.md", ".codex/AGENTS.md"],
    files: [path.join(home, "AGENTS.override.md"), path.join(home, "AGENTS.md")], ancestorRules: [], rules: [], imports: false };
}
export function claudeInstructions(): InstructionSources {
  const home = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const managed = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
    : process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode") : "/etc/claude-code";
  return { ancestorFiles: ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"], ancestorRules: [".claude/rules"],
    files: [path.join(home, "CLAUDE.md"), path.join(managed, "CLAUDE.md")], rules: [path.join(home, "rules")], imports: true };
}

/** Compatibility entry point for callers that explicitly observe both harnesses. */
export function legacyInstructionSources(): InstructionSources {
  const codex = codexInstructions(), claude = claudeInstructions();
  return { ancestorFiles: [...codex.ancestorFiles, ...claude.ancestorFiles], files: [...codex.files, ...claude.files],
    ancestorRules: claude.ancestorRules, rules: claude.rules, imports: true };
}
