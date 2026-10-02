import type { ProviderAdapter } from "./adapter.js";
import type { AdapterCapabilities, ProviderSession } from "./contracts.js";
import type { AgentCheck } from "../adapters/base.js";
import type { McpServerEntry } from "../types.js";
import type { PermissionProfile } from "../core/permissions.js";

export interface Decoder<T> { parse(value: unknown): T }
export interface InstructionSnapshot { fingerprint: string }
export interface SessionPolicy { kind: string; options: Record<string, unknown>; workspaceId: string }
export interface ProviderContinuity {
  supported: boolean;
  protocolRevision: string;
  defaultContextWindow: number;
  compatibilityKey(input: SessionPolicy): string;
  instructionDependencies(cwd: string): Promise<InstructionSnapshot>;
}
export interface ProviderHealth {
  kind: string; available: boolean; version: string | null; tested: boolean;
  binary: string | null; fingerprint: string | null; error?: string; checkedAt: number;
}
export interface ContinuationIdentity { driverKind: string; continuationKey: string }
/** Opaque to consumers; value must be JSON-serializable for crash recovery.
 * A successful fence must prove this exact identity's writers cannot write again. */
export interface WriterIdentity { type: string; value: unknown }
export interface WriterRecovery { driverKind: string; continuationKey: string; identity: WriterIdentity }
export interface ProviderEnvironment {
  cwd: string;
  mcpServers(): Array<{ key: string; entry: McpServerEntry }>;
  canAsk(): boolean;
}
export interface InstanceInput<C> { instanceId: string; config: C; environment: ProviderEnvironment }
export interface ProviderInstance {
  instanceId: string;
  driverKind: string;
  continuationIdentity: ContinuationIdentity;
  accountKey: string;
  adapter: ProviderAdapter;
  continuity: ProviderContinuity;
  health(): Promise<ProviderHealth>;
  dispose(): Promise<void>;
  recoveryIdentity(session: ProviderSession): WriterRecovery | undefined;
}
/** Static driver values, materialized instances and cursor ownership are separate,
 * as in t3code. Loom injects plain closures rather than Effect services/scopes. */
export interface ProviderDriver<C = Record<string, unknown>> {
  kind: string;
  metadata: { displayName: string; supportsMultipleInstances: boolean };
  configSchema: Decoder<C>;
  defaultConfig(): C;
  capabilities: AdapterCapabilities;
  permissions: PermissionProfile;
  continuity: ProviderContinuity;
  limits: { provider: string; reachedScope: "account" | "window" };
  continuationIdentity(instanceId: string, config: C): ContinuationIdentity;
  accountKey(config: C): string;
  models?(config: C): Promise<{ models: string[]; source: "cli" | "builtin" | "api" | "none" }>;
  available(config: C): Promise<boolean>;
  health(config: C): Promise<ProviderHealth>;
  selfCheck(config: C): Promise<AgentCheck[]>;
  create(input: InstanceInput<C>): Promise<ProviderInstance>;
  recoveryIdentity(session: ProviderSession): WriterIdentity | undefined;
  /** True only after every writer is fenced; false preserves the recovery hold. */
  fence(identity: WriterIdentity): Promise<boolean>;
}

/** Config is erased only in the registry's heterogeneous collection. Each
 * driver's decoder validates it before its typed factory receives it. */
export type AnyProviderDriver = ProviderDriver<any>;
