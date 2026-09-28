import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { codexBin } from "../../adapters/codex.js";
import { claudeBin } from "../../adapters/claude-code.js";
import { ContinuityError, digest } from "./contracts.js";

const exec = promisify(execFile);
/** Conservative protocol profiles. A CLI upgrade is not evidence that its
 * event/session semantics match the fixtures; add a fixture before enabling it. */
export const VERIFIED_PROTOCOLS = {
  codex: { versions: ["0.142.4", "0.155.0"], protocol: "codex-exec-json-v1", acceptance: "turn.started or native output", context: "turn-input", retrieval: "immutable local evidence JSON", compaction: "unknown" },
  "claude-code": { versions: ["2.1.83", "2.1.193"], protocol: "claude-print-stream-json-v1", acceptance: "assistant/tool/result output", context: "turn-input", retrieval: "immutable local evidence JSON", compaction: "unknown" },
} as const;

export async function probeContinuity(kind: string, options: Record<string, unknown>): Promise<Record<string, string>> {
  if (process.platform === "win32") throw new ContinuityError("unsupported", "native continuity requires verified process containment; Windows Job Objects are not implemented yet");
  if (kind !== "codex" && kind !== "claude-code") throw new ContinuityError("unsupported", `no verified ${kind} protocol`);
  const override = typeof options.bin === "string" ? options.bin : undefined;
  const bin = kind === "codex" ? codexBin(override) : claudeBin(override);
  if (!bin) throw new ContinuityError("unsupported", `${kind} binary is unavailable`);
  let version: string;
  try {
    const { stdout } = await exec(bin, ["--version"], { timeout: 5000, maxBuffer: 4096 });
    version = stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? "unknown";
  } catch { throw new ContinuityError("unsupported", `${kind} did not answer a bounded version probe; native continuity is unavailable`); }
  const profile = VERIFIED_PROTOCOLS[kind];
  if (!(profile.versions as readonly string[]).includes(version))
    throw new ContinuityError("unsupported", `${kind} ${version} has no checked continuity fixture; supported versions: ${profile.versions.join(", ")}`);
  const identity = fs.existsSync(bin) ? [fs.realpathSync(bin), fs.statSync(bin).mtimeMs, fs.statSync(bin).size] : [bin];
  return { version, protocol: profile.protocol, binary: bin, fingerprint: digest(JSON.stringify([identity, version, profile.protocol])) };
}
