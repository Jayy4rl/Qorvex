/**
 * Claim lifecycle: verify, re-verify (on sensitive actions, nightly, when the
 * code hash changes) and lapse. A lapsed claim keeps private monitoring but
 * loses automatic pause and the official public page (change request §4).
 */
import type { AuthorityClaim, NetworkId, Protocol } from "@qorvex/shared";
import type { NearRpc } from "../near/rpc.ts";
import { authorityFrom, councilMatch, detect } from "./authority.ts";
import { DEFAULT_WORKSPACE, type Tenancy } from "./tenancy.ts";

export interface ClaimDeps {
  tenancy: Tenancy;
  rpcFor: (network: NetworkId) => NearRpc | undefined;
  guardianFor: (network: NetworkId) => string | undefined;
  /** Told when a claim lapses (alert the workspace). */
  onLapse?: (claim: AuthorityClaim, why: string) => void;
}

/** Re-read the chain for one workspace's claim. Returns the updated claim (or undefined if there is none). */
export async function reverifyClaim(c: ClaimDeps, workspaceId: string, network: NetworkId, contractId: string): Promise<AuthorityClaim | undefined> {
  const claim = c.tenancy.claim(workspaceId, network, contractId);
  if (!claim) return undefined;
  if (claim.method === "admin-token") return claim;
  const rpc = c.rpcFor(network);
  if (!rpc) return claim;
  let d;
  try {
    d = await detect(rpc, network, contractId, c.guardianFor(network));
  } catch {
    return claim; // RPC trouble is not evidence of a lost claim: keep the last state
  }
  c.tenancy.putDetection(d);
  const still = authorityFrom(d, [claim.evidence.account]);
  if (still) {
    // Keep the last council check if the guardian could not be read this time (RPC trouble is not evidence).
    const council = await councilMatch(rpc, c.guardianFor(network), contractId, claim.evidence.account).catch(() => claim.evidence.council);
    const updated = c.tenancy.putClaim({ ...claim, ...still, evidence: { ...still.evidence, ...(council ? { council } : {}) }, status: "verified", verifiedAt: new Date().toISOString() });
    if (council?.matches) await c.tenancy.claimCanonical(network, contractId, workspaceId);
    return updated;
  }
  const lapsed = c.tenancy.putClaim({ ...claim, status: "lapsed" });
  if (claim.status === "verified") {
    const why = `${claim.evidence.account} no longer controls ${contractId} (${claim.evidence.detail} is no longer true)`;
    c.tenancy.audit({ workspaceId, actor: "qorvex", method: "chain-read", action: "claim.lapsed", target: `${network}:${contractId}`, detail: { why } });
    c.onLapse?.(lapsed, why);
  }
  return lapsed;
}

/** Re-verify every verified claim (run on a timer). */
export async function reverifyAll(c: ClaimDeps): Promise<{ checked: number; lapsed: number }> {
  const rows = c.tenancy.db.prepare("SELECT workspace_id, network, contract_id FROM authority_claims WHERE status = 'verified'").all() as { workspace_id: string; network: NetworkId; contract_id: string }[];
  let lapsed = 0;
  for (const r of rows) {
    const out = await reverifyClaim(c, r.workspace_id, r.network, r.contract_id);
    if (out?.status === "lapsed") lapsed++;
  }
  return { checked: rows.length, lapsed };
}

/**
 * The watcher's pause gate: only the workspace holding verified authority over
 * the contract may trigger the guardian. Records from before multi-tenancy
 * (the "default" workspace of a self-hosted install) keep their behaviour.
 */
export function mayPause(t: Tenancy, p: Protocol): { ok: true } | { ok: false; reason: string } {
  const ws = p.workspaceId ?? DEFAULT_WORKSPACE;
  if (ws === DEFAULT_WORKSPACE) return { ok: true };
  const claim = t.claim(ws, p.network, p.contractId);
  if (claim?.status !== "verified") {
    return { ok: false, reason: claim?.status === "lapsed" ? "this workspace's authority over the contract lapsed: alert only" : "this workspace has no verified authority over the contract: alert only" };
  }
  // Only the workspace holding the contract's official record, proven by the guardian's own council, may pause.
  if (t.canonical(p.network, p.contractId)?.claimedBy !== ws) return { ok: false, reason: "another workspace holds this contract's official record: alert only" };
  if (claim.method !== "admin-token" && !claim.evidence.council?.matches) {
    return { ok: false, reason: "this workspace's account is not the guardian council for this contract: alert only" };
  }
  return { ok: true };
}
