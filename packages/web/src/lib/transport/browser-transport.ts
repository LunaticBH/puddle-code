/** Local serving remains the default; remote transport is installed only after host selection. */
export interface CockpitSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener<K extends 'open' | 'message' | 'close'>(
    type: K,
    listener: (event: WebSocketEventMap[K]) => void,
  ): void;
}
export interface BrowserTransport {
  readonly scope: string;
  readonly notificationHost?: string;
  /** Changes on reconnect so multi-request writes cannot cross an encryption generation. */
  readonly generation?: string | null;
  request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal | null,
  ): Promise<Response>;
  socket(): CockpitSocket;
  input(session: string, term: string, data: string): Promise<void>;
}
let installed: BrowserTransport | null = null;
export function browserTransport(): BrowserTransport | null {
  return installed;
}
export function installBrowserTransport(transport: BrowserTransport | null): void {
  installed = transport;
}
export function browserScope(key: string): string {
  return installed ? `${installed.scope}:${key}` : key;
}
