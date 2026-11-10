/**
 * NEAR AI Cloud client (A1): the OpenAI-compatible chat completions API at
 * https://cloud-api.near.ai/v1, called with plain fetch.
 *
 * Record/replay (A9):
 *  - replay (default): answers come only from fixtures committed under
 *    fixtures/ai/; no network, no API key. A missing fixture is an error,
 *    never a made-up answer.
 *  - live: call the API.
 *  - record: call the API and save the exchange as a fixture.
 *
 * Fixtures are keyed by a caller-supplied `replayKey` (job, model, contract,
 * code hash, attempt...) rather than by the full prompt, because prompts
 * include live chain values that change between runs. The full request and
 * response are stored in the fixture for inspection.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AiConfig } from "../config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  model: string;
  chatId?: string;
  source: "live" | "replay" | "record";
  fixture?: string;
}

export class FixtureMissingError extends Error {}

export interface Fixture {
  replayKey: unknown;
  request: unknown;
  response: unknown;
  text: string;
  chatId?: string;
  recordedAt: string;
  /** Model that actually answered (a fallback if the primary was rate-limited). */
  modelUsed?: string;
}

export class NearAiClient {
  constructor(public readonly cfg: AiConfig) {}

  fixturePath(replayKey: unknown): string {
    const h = crypto.createHash("sha256").update(JSON.stringify(replayKey)).digest("hex").slice(0, 32);
    return path.join(this.cfg.fixturesDir, `${h}.json`);
  }

  get canCallLive(): boolean {
    return this.cfg.mode !== "replay" && !!this.cfg.apiKey;
  }

  async chat(model: string, messages: ChatMessage[], replayKey: unknown, opts: { json?: boolean; maxTokens?: number } = {}): Promise<ChatResult> {
    const file = this.fixturePath({ model, ...(replayKey as object) });
    if (this.cfg.mode === "replay") {
      if (!fs.existsSync(file)) {
        throw new FixtureMissingError(
          `no recorded NEAR AI response for this request (${path.basename(file)}). Set NEARAI_API_KEY and QORVEX_AI_MODE=record (or live) to call NEAR AI Cloud.`,
        );
      }
      const fx = JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
      return { text: fx.text, model: fx.modelUsed ?? model, chatId: fx.chatId, source: "replay", fixture: path.basename(file) };
    }
    if (!this.cfg.apiKey) throw new Error("NEARAI_API_KEY is not set (required for QORVEX_AI_MODE=live/record)");
    let request: Record<string, unknown> = {};
    let response: any;
    let usedModel = model;
    const errors: string[] = [];
    // Primary model first, then fallbacks; each retried with backoff on 429/5xx.
    for (const m of [model, ...this.cfg.fallbackModels.filter((x) => x !== model)]) {
      request = { model: m, messages, temperature: 0, max_tokens: opts.maxTokens ?? 4000 };
      if (!this.cfg.thinking) request.chat_template_kwargs = { enable_thinking: false };
      if (opts.json) request.response_format = { type: "json_object" };
      for (let attempt = 0; attempt < 3 && !response; attempt++) {
        const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(180_000),
        }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as unknown as Response);
        const bodyText = await res.text();
        if (res.ok) {
          response = JSON.parse(bodyText);
          usedModel = m;
          break;
        }
        errors.push(`${m}: HTTP ${res.status} ${bodyText.slice(0, 160)}`);
        if (res.status !== 429 && res.status < 500 && res.status !== 0) break; // not retryable for this model
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
      if (response) break;
    }
    if (!response) throw new Error(`NEAR AI: no model answered. ${errors.join(" | ")}`);
    const msg = response.choices?.[0]?.message ?? {};
    const text: string = msg.content ?? "";
    if (!text) throw new Error(`NEAR AI ${usedModel} returned no content (finish_reason ${response.choices?.[0]?.finish_reason})`);
    const chatId: string | undefined = response.id;
    if (this.cfg.mode === "record") {
      fs.mkdirSync(this.cfg.fixturesDir, { recursive: true });
      const fx: Fixture = { replayKey: { model, ...(replayKey as object) }, request, response, text, chatId, recordedAt: new Date().toISOString(), modelUsed: usedModel };
      fs.writeFileSync(file, JSON.stringify(fx, null, 2));
    }
    return { text, model: usedModel, chatId, source: this.cfg.mode, fixture: this.cfg.mode === "record" ? path.basename(file) : undefined };
  }

  /**
   * A8: fetch the model's TEE attestation report for a fresh nonce, and the
   * signature of a completed chat. Stored as-is; full verification (NVIDIA
   * NRAS + Intel TDX quote) is left to the operator's verifier of choice.
   */
  async attestation(model: string, chatId?: string): Promise<{ nonce: string; signingAddress?: string; report?: unknown; signature?: unknown; error?: string }> {
    const nonce = crypto.randomBytes(32).toString("hex");
    if (!this.cfg.apiKey || this.cfg.mode === "replay") return { nonce, error: "attestation needs a live NEAR AI API key" };
    try {
      const headers = { accept: "application/json", authorization: `Bearer ${this.cfg.apiKey}` };
      const res = await fetch(`${this.cfg.baseUrl}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`, { headers, signal: AbortSignal.timeout(60_000) });
      const report = (await res.json()) as any;
      let signature: unknown;
      if (chatId) {
        const s = await fetch(`${this.cfg.baseUrl}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers, signal: AbortSignal.timeout(30_000) });
        signature = s.ok ? await s.json() : { error: `HTTP ${s.status}` };
      }
      return { nonce, signingAddress: report?.model_attestations?.[0]?.signing_address ?? report?.signing_address, report, signature, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (e) {
      return { nonce, error: (e as Error).message };
    }
  }
}

/** Pull the first JSON object out of a model reply (tolerates code fences). */
export function parseJsonReply(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error("reply is not JSON");
  }
}
