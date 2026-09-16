import { LocalIpcClient, type IpcResponse, type LocalIpcClientOptions, type LocalIpcRequestOptions } from "./protocol.js";

/** Thin typed client for the daemon's private local IPC endpoint. */
export class DaemonClient {
  private readonly client: LocalIpcClient;

  constructor(endpoint: string, options: Omit<LocalIpcClientOptions, "endpoint"> = {}) {
    this.client = new LocalIpcClient({ ...options, endpoint });
  }

  async call(call: string, payload: unknown, options: LocalIpcRequestOptions = {}): Promise<IpcResponse> {
    return this.client.request(call, payload, options);
  }
}
