export interface StreamAction {
  kind: "FunctionCall" | "Transfer" | "Other";
  method?: string;
  /** Parsed JSON args when they are JSON, otherwise undefined. */
  args?: unknown;
  deposit?: string;
}

export interface StreamReceipt {
  receiptId: string;
  predecessor: string;
  receiver: string;
  txHash?: string;
  actions: StreamAction[];
  /** Execution status when the source knows it. */
  status: "success" | "failure" | "unknown";
  logs: string[];
}

export interface BlockEvent {
  height: number;
  hash: string;
  timestampMs: number;
  receipts: StreamReceipt[];
  /** Which source produced it (for the breach log). */
  source: string;
  /** Wall-clock time the watcher received the block. */
  receivedAtMs: number;
}

export interface BlockSource {
  readonly name: string;
  /** Start streaming from `fromHeight` (or the current head). Resolves when stopped. */
  run(onBlock: (b: BlockEvent) => Promise<void>, fromHeight?: number): Promise<void>;
  stop(): void;
}

export function parseActions(actions: unknown[]): StreamAction[] {
  return (actions ?? []).map((a) => {
    if (a && typeof a === "object") {
      const o = a as Record<string, any>;
      if (o.FunctionCall) {
        let args: unknown;
        try {
          args = JSON.parse(Buffer.from(o.FunctionCall.args ?? "", "base64").toString("utf8"));
        } catch {
          args = undefined;
        }
        return { kind: "FunctionCall", method: o.FunctionCall.method_name, args, deposit: String(o.FunctionCall.deposit ?? "0") };
      }
      if (o.Transfer) return { kind: "Transfer", deposit: String(o.Transfer.deposit ?? "0") };
    }
    return { kind: "Other" };
  });
}
