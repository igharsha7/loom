import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import { cliAvailable, cliOutput, firstLine } from "../../adapters/base.js";
import type { ProviderAdapter } from "../adapter.js";
import type { InstanceInput, ProviderContinuity, ProviderDriver, ProviderInstance, WriterIdentity } from "../driver.js";
import type { ProviderSession } from "../contracts.js";
import { nativeInstructions } from "../instructions.js";
import { processGroupIdentity, stopRecordedProcessGroup } from "../process.js";
import { NativeDispatchRejected } from "../settlement.js";

export const nativeConfigSchema = z.looseObject({ bin: z.string().optional(), model: z.string().optional(), effort: z.string().optional(),
  extraArgs: z.array(z.string()).optional(), permissions: z.enum(["bypass", "auto", "ask"]).optional(),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(), permissionMode: z.string().optional(),
  accountKey: z.string().min(1).max(256).optional(), continuationKey: z.string().min(1).max(1024).optional() });
export type NativeConfig = z.infer<typeof nativeConfigSchema>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function continuity(kind: string, window: number): ProviderContinuity {
  return { supported: true, protocolRevision: "turn-input-v2", defaultContextWindow: window, instructionDependencies: nativeInstructions,
    compatibilityKey({ options, workspaceId }) {
      // Preserve the pre-registry hashes: both built-ins switch models in session.
      const { model: _model, ...stable } = options;
      return hash([kind, stable, workspaceId, "turn-input-v2"]);
    } };
}
export function localRecoveryIdentity(session: ProviderSession): WriterIdentity | undefined {
  if (session.writerIdentity) return session.writerIdentity;
  if (!session.processGroupId) return undefined;
  const processIdentity = processGroupIdentity(session.processGroupId);
  if (processIdentity === null) throw new NativeDispatchRejected("native process exited before compaction submission");
  return { type: "process-group", value: { processGroupId: session.processGroupId, processIdentity } };
}
export async function fenceLocal(identity: WriterIdentity): Promise<boolean> {
  if (identity.type !== "process-group" || !identity.value || typeof identity.value !== "object") return false;
  return stopRecordedProcessGroup(identity.value as { processGroupId?: number; processIdentity?: string });
}
const exec = promisify(execFile);
export function localChecks(kind: string, binary: (override?: string) => string | null, protocol: string, cliName = kind, installHint = "") {
  return {
    available: (config: NativeConfig) => { const bin = binary(config.bin); return bin ? cliAvailable(bin) : Promise.resolve(false); },
    async health(config: NativeConfig) {
      const checkedAt = Date.now(), bin = binary(config.bin);
      const down = (error: string) => ({ kind, available: false, version: null, tested: false, binary: bin, fingerprint: null, error, checkedAt });
      if (process.platform === "win32") return down("native continuity requires verified process containment; Windows Job Objects are not implemented yet");
      if (!bin) return down(`${kind} CLI was not found`);
      let version: string | null;
      try {
        const { stdout } = await exec(bin, ["--version"], { timeout: 5000, maxBuffer: 4096 });
        version = stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
      } catch (error) { return down(`${kind} did not answer a version probe: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`); }
      const identity = fs.existsSync(bin) ? [fs.realpathSync(bin), fs.statSync(bin).size] : [bin];
      return { kind, available: true, version, tested: false, binary: bin, fingerprint: hash([identity, version, protocol]), checkedAt };
    },
    async selfCheck(config: NativeConfig) {
      const bin = binary(config.bin);
      if (!bin) return [{ name: "installed", ok: false, detail: `${cliName} CLI not found — install it${installHint}` }];
      const out = await cliOutput(bin, ["--version"]);
      return [{ name: "installed", ok: out?.code === 0, detail: out?.code === 0 ? firstLine(out.out) || bin : `${cliName} didn't answer --version` }];
    },
  };
}
export function localInstance(driver: ProviderDriver<NativeConfig>, input: InstanceInput<NativeConfig>, adapter: ProviderAdapter): ProviderInstance {
  const continuationIdentity = driver.continuationIdentity(input.instanceId, input.config);
  return { instanceId: input.instanceId, driverKind: driver.kind, continuationIdentity, accountKey: driver.accountKey(input.config),
    adapter, continuity: driver.continuity, health: () => driver.health(input.config), dispose: () => adapter.stopAll(),
    recoveryIdentity: session => { const identity = driver.recoveryIdentity(session); return identity ? { ...continuationIdentity, identity } : undefined; } };
}
