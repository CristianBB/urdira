import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildSemanticProvider, startNeuralSemanticProviderHost } from "../packages/daemon/src/index.js";

class FakeNeuralChild extends EventEmitter {
  readonly kill_signals: NodeJS.Signals[] = [];
  readonly sent_messages: unknown[] = [];
  killed = false;
  connected = true;
  exit_on_send = false;

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent_messages.push(message);
    callback?.(null);
    if (this.exit_on_send) queueMicrotask(() => this.emit("exit", 1, null));
    return true;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.kill_signals.push(signal);
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

const descriptor = { kind: "neural", cache_dir: "/nonexistent/model-cache" } as const;

describe("persistent neural semantic host startup", () => {
  it("rejects an unprovisioned model cache before starting the neural runtime", async () => {
    await expect(buildSemanticProvider(descriptor)).rejects.toThrow("local embedding model cache is not provisioned");
  });

  it("terminates and rejects a child that never completes its readiness handshake", async () => {
    const child = new FakeNeuralChild();

    await expect(startNeuralSemanticProviderHost(descriptor, {
      startup_timeout_ms: 10,
      spawn_child: () => child as unknown as ChildProcess,
    })).rejects.toThrow("did not become ready within 10 ms");

    expect(child.sent_messages).toEqual([{ kind: "init", descriptor }]);
    expect(child.kill_signals).toEqual(["SIGTERM"]);
  });

  it("rejects immediately when the child exits before readiness", async () => {
    const child = new FakeNeuralChild();
    child.exit_on_send = true;

    await expect(startNeuralSemanticProviderHost(descriptor, {
      startup_timeout_ms: 1_000,
      spawn_child: () => child as unknown as ChildProcess,
    })).rejects.toThrow("exited before readiness (1/no-signal)");
  });
});
