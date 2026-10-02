import { AdapterBase } from "./base.js";
import type { SendInput } from "../types.js";

/** Preserve a saved roster entry without preventing the project from opening. */
export class UnavailableAdapter extends AdapterBase {
  async available(): Promise<boolean> { return false; }
  async start(): Promise<void> { }
  async stop(): Promise<void> { }
  async interrupt(): Promise<void> { }
  async send(_input: SendInput): Promise<void> {
    throw new Error(`provider driver "${this.kind}" is unavailable — restore it, disable this agent, or choose another agent; saved bindings are preserved`);
  }
  async selfCheck() { return [{ name: "installed", ok: false, detail: `provider driver "${this.kind}" is unavailable; saved bindings are preserved` }]; }
}
