import type { RewindResult } from "../daemon/runtime/turns.js";

/** A released recovery has no restored files or undo checkpoint to advertise. */
export function rewindSummary(out: RewindResult): string {
  if (out.recoveryReleased) return out.message;
  return `rewound · ${out.changed.length} file${out.changed.length === 1 ? "" : "s"} · undo the files with \`loom rewind ${out.undo.id}\``;
}
