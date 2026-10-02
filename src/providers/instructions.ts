import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export class InstructionObservationError extends Error { readonly code = "invalid"; }
/** The built-ins deliberately retain the round-11 union and hash format. */
export async function nativeInstructions(checkout: string): Promise<{ fingerprint: string }> {
  // Conservative union of the harnesses' ancestor and user instruction files.
  // Imports may legitimately resolve outside a subproject or checkout.
  const files = new Map<string, string>(), visited = new Map<string, { text: string; depth: number }>();
  let instructionBytes = 0;
  const readInstruction = (file: string, depth = 0): void => {
    file = path.resolve(file);
    if (!fs.existsSync(file)) { files.set(file, "missing"); return; }
    const actual = fs.realpathSync(file);
    let entry = visited.get(actual);
    if (!entry) {
      const stat = fs.statSync(actual);
      instructionBytes += stat.size;
      if (!stat.isFile() || stat.size > 1_000_000 || instructionBytes > 4_000_000 || visited.size >= 1000)
        throw new InstructionObservationError(`instruction files exceed observation limits: ${file}`);
      entry = { text: fs.readFileSync(actual, "utf8"), depth: 5 };
      visited.set(actual, entry);
    }
    files.set(file, digest(JSON.stringify([actual, entry.text])));
    if (entry.depth <= depth) return;
    entry.depth = depth;
    let fence: string | undefined;
    const text = entry.text.split("\n").filter(line => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (!fence && marker) { fence = marker[1]; return false; }
      if (fence) {
        if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = undefined;
        return false;
      }
      return true;
    }).join("\n");
    if (depth >= 4) return;
    // Missing imports are hashed too,
    // so creating a file after preparation also invalidates the snapshot.
    for (const match of text.matchAll(/(?:^|\s)@((?:\\ |[^\s`"'<>])+)/g)) {
      const imported = match[1]!.replace(/\\ /g, " ");
      readInstruction(imported.startsWith("~/") ? path.join(os.homedir(), imported.slice(2)) : path.resolve(path.dirname(file), imported), depth + 1);
    }
  };
  for (let parent = checkout; ; parent = path.dirname(parent)) {
    for (const name of ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", ".codex/AGENTS.md"])
      readInstruction(path.join(parent, name));
    if (parent === path.dirname(parent)) break;
  }
  const ruleDirectories = new Set<string>();
  const readRules = (directory: string): void => {
    if (!fs.existsSync(directory)) { files.set(path.resolve(directory), "missing"); return; }
    const actual = fs.realpathSync(directory);
    if (ruleDirectories.has(actual)) return;
    if (ruleDirectories.size >= 1000) throw new InstructionObservationError("instruction rule directories exceed observation limits");
    ruleDirectories.add(actual);
    // Record membership as well as content, so additions and removals invalidate.
    const names = fs.readdirSync(directory).sort();
    files.set(path.resolve(directory), digest(JSON.stringify(names)));
    for (const name of names) {
      const file = path.join(directory, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) readRules(file);
      else if (name.endsWith(".md")) readInstruction(file);
    }
  };
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  readRules(path.join(claudeHome, "rules"));
  const managed = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
    : process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode") : "/etc/claude-code";
  readInstruction(path.join(managed, "CLAUDE.md"));
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  for (const file of [path.join(codexHome, "AGENTS.override.md"), path.join(codexHome, "AGENTS.md"),
    path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "CLAUDE.md")]) readInstruction(file);
  return { fingerprint: digest(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)))) };
}
