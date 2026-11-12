/**
 * Values shown in the landing page's product preview. Every value comes from the recorded
 * local-sandbox demo run (`npm run demo -- --auto --exit`, summary in data/demo/summary.txt)
 * or from the README's measured results. Nothing here is live data, and the page says so.
 */

export const DEMO_SOURCE = "Recorded local-sandbox demo run · npm run demo -- --auto --exit";

/** Rules the AI drafted for the demo ledger and treasury DAO, as approved in the run. */
export const DEMO_RULES = [
  { id: "solvency-usdc", kind: "SV", type: "Solvency", response: "Pause", backtest: "0 fires · 25 samples" },
  { id: "outflow-usdc-1h", kind: "OF", type: "Outflow rate", response: "Alert", backtest: "0 fires · 129 samples" },
  { id: "treasury-policy", kind: "PP", type: "Proposal policy", response: "Reject", backtest: "0 of 1 proposals flagged" },
] as const;

/** Intents ghost-balance replay against the demo ledger (watcher path). */
export const DEMO_BREACH = {
  breachBlock: 168,
  pausedBlock: 172,
  blocks: 4,
  secondsAfterDetection: 3.0,
  /** Block-by-block events from the run's timeline line. */
  timeline: [
    { block: 168, label: "Breach detected", detail: "received +658 ms · evaluated +11 ms · signed +19 ms" },
    { block: 169, label: "Pause tx broadcast", detail: "awaiting inclusion" },
    { block: 170, label: "Pause tx lands", detail: "guardian.pause" },
    { block: 171, label: "Guardian records", detail: "rule + evidence hash" },
    { block: 172, label: "Contract paused", detail: "outflows stopped" },
  ],
  evidence: { owed: "290,000", held: "250,000", shortfall: "40,000", token: "USDC" },
  evidenceHash: "f2e0cfb4955c8826fdd0a74748f74ac435172ab70aa39b5cebd1b4647dbc389b",
  ruleId: "solvency-usdc",
} as const;

/** Trezu #1871 replay: 100 sponsored storage_deposit calls into the attacker's token. */
export const DEMO_RELAYER = {
  without: { sponsored: 100, refused: 0, from: "0.6", to: "0.40575" },
  with: { sponsored: 8, refused: 92, from: "0.6", to: "0.50347" },
  firstRefusal: "spend cap: 0.018 NEAR spent + 0.00225 NEAR > 0.02 NEAR per 3600s",
} as const;

/** A real, reproducible mainnet read used by the read-only NEAR Intents status page (seed-intents). */
export const INTENTS_READ_CURL = `curl -s -X POST https://free.rpc.fastnear.com \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":"q1","method":"query","params":{
       "request_type":"call_function","finality":"final",
       "account_id":"intents.near","method_name":"mt_supply",
       "args_base64":"eyJ0b2tlbl9pZCI6Im5lcDE0MToxNzIwODYyOGY4NGY1ZDZhZDMzZjBkYTNiYmJlYjI3ZmZjYjM5OGVhYzUwMWEzMWJkNmFkMjAxMWUzNjEzM2ExIn0="}}'`;
