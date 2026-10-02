import { spawn } from "node:child_process";
/**
 * Fallback ids for a codex too old to have `codex debug models`.
 *
 * Not the shipped set — a *previous* shipped set, which is exactly what a codex
 * without the subcommand would be running. The current one is asked of the CLI;
 * see codexModelCatalog. Anything served from here is reported as
 * `source: "builtin"`.
 */
export const CODEX_MODELS = [
  "gpt-5.5", "gpt-5.5-codex", "gpt-5.2-codex", "gpt-5.1-codex-max",
  "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5-codex", "o4-mini",
];

/**
 * Claude Code's model aliases. The only builtin list left, and it is builtin
 * because the CLI genuinely cannot answer the question.
 *
 * `claude --help` has no `models` subcommand and lists none: what it documents
 * is the shape of the argument — "Provide an alias for the latest model (e.g.
 * 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')".
 * And `claude models` is not an error, which is the trap: `models` is taken as a
 * *prompt*, so the "enumeration" is a billed turn of an LLM writing prose about
 * models, with whatever ids it believes today. A model list that costs money and
 * can hallucinate is not a model list.
 *
 * So: aliases only. They are what the CLI's own help names, they resolve to the
 * latest snapshot by definition, and they can't go stale the way a pinned
 * "claude-sonnet-5" did — an id that used to sit in this array and has never
 * been a model. Full ids belong in the picker's custom field, where they're your
 * claim rather than ours.
 */
export const CLAUDE_MODELS = ["opus", "sonnet", "haiku", "fable"];

/** Where a model list came from, so a caller can say which. */
export type ModelSource = "cli" | "builtin" | "api" | "none";

export type ModelList = { models: string[]; source: ModelSource };

/**
 * Whatever a CLI prints on stdout, or "" if it can't be run. Never throws.
 *
 * This is `spawn` and not `execFile` for a reason that cost an afternoon:
 * `execFile` calls back when the child's *streams* close, and `agy models`
 * leaves a language-server process holding stdout open after it exits, so
 * execFile waits out its whole timeout and hands back an empty string — the
 * Antigravity picker looked exactly like a CLI that reports no models, on a
 * machine where `agy models` prints eleven. Measured, repeatedly, one fresh
 * process per attempt: execFile 25s/0 lines, spawn 5.3s/11 lines.
 *
 * So: resolve on `exit`, with a short grace period for data still in the pipe,
 * and take `close` when it comes first (it does for every other CLI here).
 * stderr is drained and dropped — unread, a chatty CLI can fill its pipe and
 * block on the write.
 */
export function runCapture(cmd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve) => {
    const MAX = 8 * 1024 * 1024;
    let out = "";
    let settled = false;
    let hard: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      clearTimeout(drain);
      resolve(out);
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return void resolve(""); // not a runnable path
    }
    hard = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < MAX) out += d.toString();
    });
    child.stderr.on("data", () => { });
    child.on("error", finish); // not installed
    child.on("close", finish); // streams closed — everything it wrote is here
    child.on("exit", () => {
      // ...unless something it spawned still holds the pipe. Give the buffered
      // bytes a moment to arrive, then take what we have.
      drain = setTimeout(finish, 300);
    });
  });
}

/**
 * codex's own model catalog, which it will print as JSON: `codex debug models`.
 *
 * Not a documented list command — it's under `debug` — but it is the CLI
 * answering about itself rather than us remembering, and it's the same catalog
 * the picker in codex's own TUI is built from. Each entry carries a `slug` (the
 * value `-m` takes) and a `visibility`; `hide` means internal (codex-auto-review
 * is one), and offering an agent a model its own UI won't is offering a
 * failure. ~65ms and 184KB on this machine — the base instructions for every
 * model ride along in that JSON, hence the buffer.
 *
 * Empty on any older codex that has no `debug models`, which is the caller's cue
 * to fall back and say so.
 */
export function codexModelCatalog(bin: string): Promise<string[]> {
  return runCapture(bin, ["debug", "models"]).then((stdout) => {
    try {
      const parsed = JSON.parse(stdout) as {
        models?: Array<{ slug?: unknown; visibility?: unknown }>;
      };
      const slugs = (parsed.models ?? [])
        .filter((m) => m.visibility !== "hide")
        .map((m) => String(m.slug ?? "").trim())
        .filter(Boolean);
      return [...new Set(slugs)];
    } catch {
      return []; // not JSON — an older codex, or one that errored
    }
  });
}

