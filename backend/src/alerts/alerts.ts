/**
 * Alerts (D5): Telegram and a signed webhook. Sent the moment an incident is
 * contained (after the pause lands) or immediately for alert-only rules.
 * Channels are configured only through environment variables.
 */
import crypto from "node:crypto";
import { env } from "../config.ts";
import type { AlertResult, Breach } from "@qorvex/shared";

export interface AlertChannel {
  name: string;
  send(subject: string, text: string, payload: unknown): Promise<void>;
}

export class TelegramChannel implements AlertChannel {
  name = "telegram";
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}
  async send(_subject: string, text: string): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export class WebhookChannel implements AlertChannel {
  name = "webhook";
  constructor(
    private readonly url: string,
    private readonly secret?: string,
  ) {}
  async send(subject: string, text: string, payload: unknown): Promise<void> {
    const body = JSON.stringify({ subject, text, payload });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.secret) headers["x-qorvex-signature"] = `sha256=${crypto.createHmac("sha256", this.secret).update(body).digest("hex")}`;
    const res = await fetch(this.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  }
}

export function channelsFromEnv(): AlertChannel[] {
  const out: AlertChannel[] = [];
  const tg = env("TELEGRAM_BOT_TOKEN");
  const chat = env("TELEGRAM_CHAT_ID");
  if (tg && chat) out.push(new TelegramChannel(tg, chat));
  const hook = env("QORVEX_WEBHOOK_URL");
  if (hook) out.push(new WebhookChannel(hook, env("QORVEX_WEBHOOK_SECRET")));
  return out;
}

export function breachMessage(b: Breach, statusUrl?: string): { subject: string; text: string } {
  const ev = b.evaluation;
  if (ev.type === "proposal") {
    const v = b.vote;
    const head =
      v?.status === "landed"
        ? `FIREWALL REJECTED proposal #${ev.proposalId}: ${b.rule.explain}`
        : v?.status === "failed"
          ? `FIREWALL VOTE FAILED on proposal #${ev.proposalId}: review it now`
          : `FIREWALL ALERT on proposal #${ev.proposalId}: ${b.rule.explain}`;
    const text = [
      head,
      `Proposal by ${ev.proposer}: ${ev.summary}.`,
      `Violations: ${ev.violations.join("; ")}.`,
      v?.status === "landed" ? `Voted VoteReject at block ${v.votedAtBlock} (${v.blocksAfterProposal} blocks after submission); proposal is now ${v.proposalStatusAfter}. Tx ${v.txHash}.` : v?.error ? `Vote: ${v.error}.` : "",
      statusUrl ? `Status: ${statusUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { subject: head, text };
  }
  const what =
    ev.type === "solvency"
      ? `owed ${ev.owed} > held ${ev.held} (${b.rule.type === "solvency" ? b.rule.token : ""})`
      : `outflow ${ev.total} > max ${ev.max} in ${ev.windowSec}s`;
  const p = b.pause;
  let head: string;
  let tail: string;
  if (b.response === "pause" && p?.status === "landed") {
    head = `CONTAINED: ${b.rule.explain}`;
    tail = `Broke at block ${b.triggerBlock}; paused at block ${p.pausedAtBlock} (${p.blocksAfterBreach} blocks later) via guardian tx ${p.txHash}.`;
  } else if (b.response === "pause" && p?.status === "skipped") {
    head = `CONTAINED (contract already paused): ${b.rule.explain}`;
    tail = `Broke at block ${b.triggerBlock}. ${p.error ?? ""}`;
  } else if (b.response === "pause") {
    head = `BREACH, PAUSE FAILED: ${b.rule.explain}`;
    tail = `Broke at block ${b.triggerBlock}. Pause error: ${p?.error ?? "unknown"}. Act now.`;
  } else {
    head = `ALERT (alert-only rule): ${b.rule.explain}`;
    tail = `Broke at block ${b.triggerBlock}. Not paused: this rule is alert-only.`;
  }
  const txs = b.triggerReceipts.slice(0, 5).map((r) => r.txHash ?? r.receiptId).join(", ");
  const text = [head, `Rule ${b.ruleId}: ${what}.`, tail, txs ? `Look first at: ${txs}` : "", statusUrl ? `Status: ${statusUrl}` : ""]
    .filter(Boolean)
    .join("\n");
  return { subject: head, text };
}

export class Alerter {
  constructor(private readonly channels: AlertChannel[] = channelsFromEnv()) {}

  get configured(): string[] {
    return this.channels.map((c) => c.name);
  }

  async send(subject: string, text: string, payload: unknown): Promise<AlertResult[]> {
    return Promise.all(
      this.channels.map(async (c) => {
        try {
          await c.send(subject, text, payload);
          return { channel: c.name, ok: true, at: new Date().toISOString() };
        } catch (e) {
          return { channel: c.name, ok: false, error: (e as Error).message, at: new Date().toISOString() };
        }
      }),
    );
  }
}
