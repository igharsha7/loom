import { codexDriver } from "./drivers/codex.js";
import { claudeDriver } from "./drivers/claude.js";
import { opencodeDriver } from "./drivers/opencode.js";
import type { AnyProviderDriver } from "./driver.js";
/** The only list of concrete drivers. Agent factories and discovery derive from it. */
export const builtInDrivers: readonly AnyProviderDriver[] = [claudeDriver, codexDriver, opencodeDriver];

/** Compatibility boundary for journals written before opaque driver records. */
export { fenceLocal as fenceLegacyWriter } from "./drivers/local.js";
