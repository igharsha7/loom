import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { nativeInstructions } from "../../src/providers/instructions.js";
import { tmpDir } from "../helpers.js";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("observes nested user rules, membership changes and imported files (A2)", async () => {
  const checkout = tmpDir("instructions"), home = tmpDir("claude-home");
  vi.stubEnv("CLAUDE_CONFIG_DIR", home);
  const before = await nativeInstructions(checkout);
  fs.mkdirSync(path.join(home, "rules", "nested"), { recursive: true });
  const rule = path.join(home, "rules", "nested", "rule.md");
  fs.writeFileSync(rule, "@../../import.md"); fs.writeFileSync(path.join(home, "import.md"), "one");
  const added = await nativeInstructions(checkout); expect(added).not.toEqual(before);
  fs.writeFileSync(path.join(home, "import.md"), "two");
  const changed = await nativeInstructions(checkout); expect(changed).not.toEqual(added);
  fs.unlinkSync(rule); expect(await nativeInstructions(checkout)).not.toEqual(changed);
});

it("observes managed CLAUDE.md without writing system instructions (A2)", async () => {
  const checkout = tmpDir("managed"), original = fs.existsSync;
  const managed = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/CLAUDE.md"
    : process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode", "CLAUDE.md") : "/etc/claude-code/CLAUDE.md";
  let content = "one";
  vi.spyOn(fs, "existsSync").mockImplementation(file => String(file) === managed || original(file));
  const real = fs.realpathSync, stat = fs.statSync, read = fs.readFileSync;
  vi.spyOn(fs, "realpathSync").mockImplementation(((file: fs.PathLike) => String(file) === managed ? managed : real(file)) as typeof real);
  vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike) => String(file) === managed ? { size: content.length, isFile: () => true } : stat(file)) as typeof stat);
  vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => String(file) === managed ? content : (read as any)(file, ...args)) as typeof read);
  const before = await nativeInstructions(checkout); content = "two";
  expect(await nativeInstructions(checkout)).not.toEqual(before);
});

it("skips imports inside backtick and tilde fences but observes real imports (A3)", async () => {
  const checkout = tmpDir("fences");
  fs.writeFileSync(path.join(checkout, "large.md"), "x".repeat(1_000_001));
  fs.writeFileSync(path.join(checkout, "CLAUDE.md"), "```md\n@large.md\n```\n~~~\n@large.md\n~~~\n@real.md");
  fs.writeFileSync(path.join(checkout, "real.md"), "one");
  const before = await nativeInstructions(checkout);
  fs.writeFileSync(path.join(checkout, "real.md"), "two");
  expect(await nativeInstructions(checkout)).not.toEqual(before);
});

it("observes ignored project rules outside git, including nested imports (#6)", async () => {
  const checkout = tmpDir("project-rules"), home = tmpDir("project-rules-home");
  vi.stubEnv("CLAUDE_CONFIG_DIR", home);
  const rule = path.join(checkout, ".claude", "rules", "nested", "rule.md");
  const before = await nativeInstructions(checkout);
  fs.mkdirSync(path.dirname(rule), { recursive: true }); fs.writeFileSync(rule, "one");
  const added = await nativeInstructions(checkout); expect(added).not.toEqual(before);
  fs.writeFileSync(rule, "two"); expect(await nativeInstructions(checkout)).not.toEqual(added);
});

it("ignores single and multiple backtick code spans when parsing imports (#8)", async () => {
  const checkout = tmpDir("inline-imports");
  fs.writeFileSync(path.join(checkout, "large.md"), "x".repeat(1_000_001));
  fs.writeFileSync(path.join(checkout, "CLAUDE.md"), "use `@large.md` and `` @large.md `nested` ``\n@real.md");
  const before = await nativeInstructions(checkout);
  fs.writeFileSync(path.join(checkout, "real.md"), "one");
  expect(await nativeInstructions(checkout)).not.toEqual(before);
});

it("bounds rule entries, skips irrelevant stats, and isolates Codex from Claude (#7)", async () => {
  const checkout = tmpDir("bounded-rules"), home = tmpDir("bounded-home");
  vi.stubEnv("CLAUDE_CONFIG_DIR", home); vi.stubEnv("CODEX_HOME", tmpDir("bounded-codex"));
  const rules = path.join(home, "rules"); fs.mkdirSync(rules);
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(rules, `${i}.txt`), "irrelevant");
  fs.symlinkSync("missing", path.join(rules, "dangling.txt"));
  const stat = vi.spyOn(fs, "statSync");
  await nativeInstructions(checkout);
  expect(stat.mock.calls.filter(([file]) => String(file).endsWith(".txt"))).toHaveLength(1);
  fs.symlinkSync(rules, path.join(rules, "cycle"));
  await nativeInstructions(checkout);
  for (let i = 100; i < 10_001; i++) fs.writeFileSync(path.join(rules, `${i}.txt`), "");
  await expect(nativeInstructions(checkout)).rejects.toThrow(/observation limits/);
  const { codexDriver } = await import("../../src/providers/drivers/codex.js");
  await expect(codexDriver.continuity.instructionDependencies(checkout)).resolves.toHaveProperty("fingerprint");
});

it("follows supported external rule symlinks with cycle detection and content limits (#7)", async () => {
  const checkout = tmpDir("linked-project"), home = tmpDir("linked-home"), external = tmpDir("linked-rules");
  vi.stubEnv("CLAUDE_CONFIG_DIR", home);
  fs.mkdirSync(path.join(home, "rules"));
  fs.symlinkSync(external, path.join(home, "rules", "external"));
  fs.symlinkSync(path.join(home, "rules"), path.join(external, "cycle"));
  const rule = path.join(external, "rule.md"); fs.writeFileSync(rule, "one");
  const before = await nativeInstructions(checkout); fs.writeFileSync(rule, "two");
  expect(await nativeInstructions(checkout)).not.toEqual(before);
  fs.writeFileSync(rule, "x".repeat(1_000_001));
  await expect(nativeInstructions(checkout)).rejects.toThrow(/observation limits/);
});
