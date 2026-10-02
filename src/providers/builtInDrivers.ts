import { codexDriver } from "./drivers/codex.js";
import { claudeDriver } from "./drivers/claude.js";
import type { AnyProviderDriver } from "./driver.js";
/** The only list of concrete drivers. Agent factories and discovery derive from it. */
export const builtInDrivers: readonly AnyProviderDriver[] = [claudeDriver, codexDriver];
