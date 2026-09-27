import { readProjectState, writeProjectState } from "./registry.js";

/** Native harness state, scoped to one configured instance and working directory.
 * Never interpret a native session ID as a Loom conversation ID. Keep the existing
 * state.json layout so installed adapters resume exactly where they did before.
 */
export class AgentStateStore {
  constructor(private readonly projectDir: string, private readonly agentId: string) {}

  read(): Readonly<Record<string, unknown>> {
    return readProjectState(this.projectDir).agents[this.agentId] ?? {};
  }

  /** Re-read on every update: an async adapter must not overwrite newer chat,
   * baton, or another adapter's state using an old project-wide snapshot.
   */
  patch(patch: Record<string, unknown>): void {
    const state = readProjectState(this.projectDir);
    const agent = { ...state.agents[this.agentId] };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete agent[key];
      else agent[key] = value;
    }
    state.agents[this.agentId] = agent;
    writeProjectState(this.projectDir, state);
  }
}
