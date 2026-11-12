/**
 * Registers the read-only, unofficial NEAR Intents page on mainnet (demo step 3):
 * one solvency rule per token, owed = intents.near mt_supply("nep141:<token>"),
 * held = <token>.ft_balance_of(intents.near). Rules are written by hand (origin:
 * human), backtested over 30 days of archival mainnet state, approved as
 * alert-only (Qorvex holds no key for intents.near), and the page is published.
 *
 *   QORVEX_URL=http://localhost:8787 QORVEX_ADMIN_TOKEN=... npm run seed:intents
 *
 * View methods verified live on 2026-11-10 (intents.near v0.4.5, NEP-245 `mt_supply`).
 */
import http from "node:http";
import { env, loadDotEnv } from "../src/config.ts";

loadDotEnv();
const base = env("QORVEX_URL", "http://localhost:8787")!;
const token = env("QORVEX_ADMIN_TOKEN");
if (!token) throw new Error("set QORVEX_ADMIN_TOKEN");

const TOKENS: { id: string; contract: string; name: string }[] = [
  { id: "usdc", contract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", name: "USDC" },
  { id: "usdt", contract: "usdt.tether-token.near", name: "USDT" },
  { id: "wnear", contract: "wrap.near", name: "wNEAR" },
];

/** node:http instead of fetch: archival backtests can take many minutes, beyond fetch's header timeout. */
function api(method: string, p: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const req = http.request(u, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, timeout: 90 * 60_000 }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        const j = raw ? JSON.parse(raw) : {};
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`${method} ${p}: ${res.statusCode} ${j.error} ${JSON.stringify(j.details ?? "")}`));
        else resolve(j);
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const { protocol } = await api("POST", "/api/protocols", { network: "mainnet", contractId: "intents.near", name: "NEAR Intents (unofficial)", unofficial: true });
console.log(`protocol ${protocol.id}`);
for (const t of TOKENS) {
  const ruleId = `solvency-${t.id}`;
  const existing = (await api("GET", `/api/protocols/${protocol.id}`)).rules.find((r: any) => r.rule.id === ruleId);
  if (!existing) {
    console.log(`adding ${ruleId} (runs a 30-day archival backtest; this can take several minutes)...`);
    const r = await api("POST", `/api/protocols/${protocol.id}/rules`, {
      author: "Qorvex (seed-intents.ts)",
      rule: {
        id: ruleId,
        type: "solvency",
        token: t.contract,
        owed: { view: "mt_supply", args: { token_id: `nep141:${t.contract}` } },
        held: { contract: t.contract, view: "ft_balance_of", args: { account_id: "intents.near" } },
        explain: `${t.name} owed to NEAR Intents users must never exceed the ${t.name} intents.near holds`,
      },
    });
    console.log(`  live: ${r.live}; backtest: ${r.backtest.fires} fires over ${r.backtest.samples} samples (${r.backtest.days} days), ${r.backtest.errors} read errors`);
  }
  await api("POST", `/api/protocols/${protocol.id}/rules/${ruleId}/approve`, { response: "alert", approvedBy: "Qorvex (seed)" });
}
await api("POST", `/api/protocols/${protocol.id}/publish`);
console.log(`published: ${base}/status/${protocol.id}`);
