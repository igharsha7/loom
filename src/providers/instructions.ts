import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { legacyInstructionSources } from "./drivers/instructions.js";
import { createHash } from "node:crypto";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** Markdown spans close only on a run with the same number of backticks. */
function withoutCodeSpans(text: string): string {
  const runs = [...text.matchAll(/`+/g)];
  const next = new Array<number>(runs.length).fill(-1), last = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const width = runs[i]![0].length;
    next[i] = last.get(width) ?? -1; last.set(width, i);
  }
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < runs.length; i++) {
    const end = next[i]!;
    if (end < 0) continue;
    parts.push(text.slice(from, runs[i]!.index), " ");
    from = runs[end]!.index + runs[end]![0].length;
    i = end;
  }
  parts.push(text.slice(from));
  return parts.join("");
}
export class InstructionObservationError extends Error { readonly code = "invalid"; }
export interface InstructionSources {
  ancestorFiles: string[]; files: string[]; ancestorRules: string[]; rules: string[]; imports: boolean;
}
/** Generic bounded observer; concrete sources belong to the driver. */
export async function nativeInstructions(checkout: string, sources?: InstructionSources): Promise<{ fingerprint: string }> {
  sources ??= legacyInstructionSources();
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
    const text = withoutCodeSpans(entry.text.split("\n").filter(line => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (!fence && marker) { fence = marker[1]; return false; }
      if (fence) {
        if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = undefined;
        return false;
      }
      return true;
    }).join("\n"));
    if (depth >= 4 || !sources.imports) return;
    // Missing imports are hashed too,
    // so creating a file after preparation also invalidates the snapshot.
    for (const match of text.matchAll(/(?:^|\s)@((?:\\ |[^\s`"'<>])+)/g)) {
      const imported = match[1]!.replace(/\\ /g, " ");
      readInstruction(imported.startsWith("~/") ? path.join(os.homedir(), imported.slice(2)) : path.resolve(path.dirname(file), imported), depth + 1);
    }
  };
  const ruleDirectories = new Set<string>();
  let entries = 0;
  const deadline = Date.now() + 1000;
  const readRules = (directory: string, depth = 0): void => {
    if (depth > 32 || Date.now() > deadline) throw new InstructionObservationError("instruction rule scan exceeds observation limits");
    if (!fs.existsSync(directory)) { files.set(path.resolve(directory), "missing"); return; }
    const actual = fs.realpathSync(directory);
    if (ruleDirectories.has(actual)) return;
    if (ruleDirectories.size >= 1000) throw new InstructionObservationError("instruction rule directories exceed observation limits");
    ruleDirectories.add(actual);
    // Record membership as well as content, so additions and removals invalidate.
    const names: fs.Dirent[] = [];
    const dir = fs.opendirSync(directory);
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++entries > 10_000 || Date.now() > deadline) throw new InstructionObservationError("instruction rule entries exceed observation limits");
        names.push(entry);
      }
    } finally { dir.closeSync(); }
    names.sort((a, b) => a.name.localeCompare(b.name));
    files.set(path.resolve(directory), digest(JSON.stringify(names.filter(entry => entry.isDirectory() || entry.isSymbolicLink() || entry.name.endsWith(".md")).map(entry => entry.name))));
    for (const entry of names) {
      if (Date.now() > deadline) throw new InstructionObservationError("instruction rule scan exceeds observation limits");
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) readRules(file, depth + 1);
      else if (entry.isSymbolicLink()) {
        // Claude supports symlinks. Bound traversal and deduplicate real paths;
        // broken irrelevant links must not block a turn.
        let stat;
        try { stat = fs.statSync(file); } catch { if (entry.name.endsWith(".md")) readInstruction(file); continue; }
        if (stat.isDirectory()) readRules(file, depth + 1);
        else if (entry.name.endsWith(".md")) readInstruction(file);
      } else if (entry.name.endsWith(".md")) readInstruction(file);
    }
  };
  for (let parent = path.resolve(checkout); ; parent = path.dirname(parent)) {
    for (const name of sources.ancestorFiles) readInstruction(path.join(parent, name));
    for (const name of sources.ancestorRules) readRules(path.join(parent, name));
    if (parent === path.dirname(parent)) break;
  }
  for (const file of sources.files) readInstruction(file);
  for (const directory of sources.rules) readRules(directory);
  return { fingerprint: digest(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)))) };
}
