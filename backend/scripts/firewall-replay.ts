/**
 * Replays a proposal-firewall policy over the full proposal history of a real
 * Sputnik DAO (read-only, no keys, no transactions).
 *
 *   npm run firewall:replay                                  # the DAO from Trezu issue #1871
 *   npm run firewall:replay -- some-dao.sputnik-dao.near mainnet
 *
 * For every proposal it prints whether the policy would have flagged it, and,
 * for proposals that were acted on, the number of blocks between submission
 * and the last vote (from the proposal's own action log), i.e. how long a
 * firewall would have had to vote. Writes fixtures/replays/<dao>.json.
 */
import fs from "node:fs";
import path from "node:path";
import { NETWORKS } from "../src/config.ts";
import { NearRpc } from "../src/near/rpc.ts";
import { evaluateProposal, type SputnikProposal } from "../src/firewall/policy.ts";
import type { ProposalPolicyRule } from "@qorvex/shared";
import { FIXTURES_DIR, REPO_ROOT } from "../src/paths.ts";

const dao = process.argv[2] ?? "rawwheat-audit1.sputnik-dao.near";
const network = (process.argv[3] ?? "mainnet") as "mainnet" | "testnet";
const rpc = new NearRpc(NETWORKS[network].rpcUrls, { retries: 3, backoffMs: 1000 });

// A conservative default policy, modelled on the allowlist fix proposed in Trezu PR #1869:
// sponsor/treasury calls only to well-known tokens, small batches, little NEAR attached.
const policy: ProposalPolicyRule = {
  id: "trezu-style-default",
  type: "proposal_policy",
  explain: "Treasury calls only to known tokens, at most 20 actions, at most 0.1 NEAR attached",
  response: "reject",
  status: "approved",
  origin: { kind: "human", author: "scripts/firewall-replay.ts" },
  allowed_call_contracts: ["wrap.near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "usdt.tether-token.near"],
  max_actions_per_call: 20,
  max_call_deposit_yocto: "100000000000000000000000",
};

const head = await rpc.block({ finality: "final" });
const last = (await rpc.view<number>(dao, "get_last_proposal_id", {}, { blockId: head.header.height })).value;
const rows: any[] = [];
for (let from = 0; from < last; from += 50) {
  const page = (await rpc.view<SputnikProposal[]>(dao, "get_proposals", { from_index: from, limit: 50 }, { blockId: head.header.height })).value;
  for (const p of page) {
    const ev = evaluateProposal(policy, p, head.header.height);
    const log = ((p as any).last_actions_log ?? []).map((x: any) => Number(x.block_height));
    rows.push({ id: p.id, status: p.status, summary: ev.summary, flagged: !ev.ok, violations: ev.violations, blocksSubmissionToLastVote: log.length > 1 ? log[log.length - 1] - log[0] : null });
  }
}
const flagged = rows.filter((r) => r.flagged);
const flaggedApproved = flagged.filter((r) => r.status === "Approved");
const windows = flaggedApproved.map((r) => r.blocksSubmissionToLastVote).filter((x) => x !== null) as number[];
const out = {
  dao,
  network,
  readAtBlock: head.header.height,
  policy,
  proposals: rows.length,
  flagged: flagged.length,
  flaggedApproved: flaggedApproved.length,
  approvalWindowBlocks: windows.length ? { min: Math.min(...windows), max: Math.max(...windows) } : null,
  rows,
};
for (const r of rows) console.log(`#${r.id} ${r.status.padEnd(10)} ${r.flagged ? "FLAG" : "ok  "} ${r.summary}${r.flagged ? `  <- ${r.violations[0]}` : ""}${r.blocksSubmissionToLastVote !== null ? `  [${r.blocksSubmissionToLastVote} blocks to last vote]` : ""}`);
console.log(`\n${dao}: ${rows.length} proposals, ${flagged.length} flagged by the policy, ${flaggedApproved.length} of those were approved; approval came ${out.approvalWindowBlocks?.min}-${out.approvalWindowBlocks?.max} blocks after submission (read at block ${head.header.height}).`);
const file = path.join(FIXTURES_DIR, "replays", `${dao}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`written ${path.relative(REPO_ROOT, file)}`);
