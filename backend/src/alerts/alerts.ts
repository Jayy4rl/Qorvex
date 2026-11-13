/**
 * Alerts (D5): Telegram and a signed webhook. Sent the moment an incident is
 * contained (after the pause lands) or immediately for alert-only rules.
 *
 * Two sources of channels: the server's own (environment variables), which
 * serve the self-hosted default workspace, and each workspace's own Telegram
 * chat and webhook, set in the console. An alert goes only to the channels of
 * the workspace that owns the contract or relayer.
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
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
  /** Set for webhooks a workspace entered: the address is re-checked before every send. */
  publicOnly = false;
  async send(subject: string, text: string, payload: unknown): Promise<void> {
    if (this.publicOnly) await assertPublicWebhookUrl(this.url);
    const body = JSON.stringify({ subject, text, payload });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.secret) headers["x-qorvex-signature"] = `sha256=${crypto.createHmac("sha256", this.secret).update(body).digest("hex")}`;
    const res = await fetch(this.url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  }
}

/** True for loopback, private, link-local, carrier-grade NAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (v.startsWith("::ffff:")) return true; // other IPv4-mapped forms: refuse rather than decode
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
}

/**
 * A webhook a workspace enters must be https and resolve only to public addresses, so it cannot
 * be pointed at the server's own network. Checked when saved and again before every send.
 */
export async function assertPublicWebhookUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("the webhook address is not a valid URL");
  }
  if (u.protocol !== "https:") throw new Error("the webhook address must start with https://");
  if (u.username || u.password) throw new Error("the webhook address must not contain a username or password");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw new Error("the webhook address must be on the public internet");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`the webhook host ${host} does not resolve`);
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error("the webhook address must be on the public internet");
  return u;
}

/** Channels for a workspace's saved settings. Telegram uses the workspace's own bot, or the server's. */
export function workspaceAlertChannels(row: { telegram_chat_id: string | null; telegram_bot_token: string | null; webhook_url: string | null; webhook_secret: string | null } | undefined): AlertChannel[] {
  if (!row) return [];
  const out: AlertChannel[] = [];
  const bot = row.telegram_bot_token ?? env("TELEGRAM_BOT_TOKEN");
  if (row.telegram_chat_id && bot) out.push(new TelegramChannel(bot, row.telegram_chat_id));
  if (row.webhook_url) {
    const w = new WebhookChannel(row.webhook_url, row.webhook_secret ?? undefined);
    w.publicOnly = true;
    out.push(w);
  }
  return out;
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
  /** Each workspace's own channels (set in the console); wired up once the database is open. */
  workspaceChannels?: (workspaceId: string) => AlertChannel[];

  constructor(private readonly channels: AlertChannel[] = channelsFromEnv()) {}

  /** The server's own channels (environment variables). */
  get configured(): string[] {
    return this.channels.map((c) => c.name);
  }

  /**
   * Send to the channels of the workspace that owns the subject. The server's own channels serve
   * the self-hosted default workspace (and alerts with no workspace); other workspaces get only
   * their own, so one tenant's incidents never reach another's chat.
   */
  async send(subject: string, text: string, payload: unknown, workspaceId?: string): Promise<AlertResult[]> {
    const own = workspaceId && workspaceId !== "default" ? [] : this.channels;
    return this.deliver([...own, ...(workspaceId ? (this.workspaceChannels?.(workspaceId) ?? []) : [])], subject, text, payload);
  }

  /** Only the workspace's own channels (the console's "Send test alert"). */
  async test(workspaceId: string): Promise<AlertResult[]> {
    const chans = this.workspaceChannels?.(workspaceId) ?? [];
    return this.deliver(chans, "Qorvex test alert", "This is a test alert from Qorvex. Incidents for your workspace's contracts and relayers will arrive here.", { test: true, workspaceId });
  }

  private async deliver(channels: AlertChannel[], subject: string, text: string, payload: unknown): Promise<AlertResult[]> {
    return Promise.all(
      channels.map(async (c) => {
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
