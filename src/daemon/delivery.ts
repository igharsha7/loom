/** Client transport only: no persistence, Brain or harness dependencies. */
export interface ClientScope { project?: string; scope?: string[] }
export interface FrameConnection {
  readonly readyState: number;
  send(frame: string, callback?: (error?: Error) => void): void;
}

export type FrameAudience =
  | { kind: "project"; projectId?: string }
  | { kind: "log"; projectId?: string }
  | { kind: "admin" };

function visible(scope: ClientScope, audience: FrameAudience): boolean {
  if (audience.kind === "admin") return !scope.scope;
  const project = audience.projectId;
  if (audience.kind === "log") {
    return !scope.scope || Boolean(project && scope.scope.includes(project));
  }
  if (!project) return true; // existing daemon-wide frames
  return (!scope.project || scope.project === project) && (!scope.scope || scope.scope.includes(project));
}

/** Serialize once, preserve order and isolate failed clients. The caller owns
 * connection registration and replay; this module never drops canonical events.
 */
export class ClientDelivery<T extends FrameConnection> {
  constructor(
    private readonly clients: ReadonlyMap<T, ClientScope>,
    private readonly onFailure: (client: T, error: unknown) => void = () => {},
  ) {}

  /** Whether any open connection would receive this project's frames. */
  watching(projectId: string): boolean {
    for (const [client, scope] of this.clients)
      if (client.readyState === 1 && visible(scope, { kind: "project", projectId })) return true;
    return false;
  }

  publish(payload: Record<string, unknown>, audience: FrameAudience): void {
    const frame = JSON.stringify(payload);
    for (const [client, scope] of this.clients) {
      if (client.readyState !== 1 || !visible(scope, audience)) continue;
      const failed = (error: unknown) => {
        try { this.onFailure(client, error); } catch { /* diagnostics cannot break delivery */ }
      };
      try {
        client.send(frame, (error) => { if (error) failed(error); });
      } catch (error) {
        failed(error);
      }
    }
  }
}
