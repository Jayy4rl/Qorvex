/**
 * On-chain authority (change request §4 and §6.2).
 *
 * `detect` runs read-only probes against a contract: code hash, full-access
 * keys, near-plugins Pausable/ACL views, owner views, qorvex-guard's
 * `guard_status`, Sputnik `get_policy`, NEP-141 metadata and this network's
 * guardian registration. It is plain code; no model is involved.
 *
 * `verifyAuthority` decides whether one of a user's NEAR accounts controls
 * the contract, from fresh chain reads (never from stored state):
 *   - it is the owner (owner view, or qorvex-guard owner),
 *   - it is a near-plugins super-admin,
 *   - it sits on the council of the DAO that owns or administers it,
 *   - it is the contract account itself.
 *
 * `authorisationTxs` builds the wallet transactions for the recommended path.
 */
import type { AuthorityClaim, Detection, NetworkId, ProtectionLevel, WalletTx } from "@qorvex/shared";
import type { NearRpc } from "../near/rpc.ts";

const EMPTY_CODE = "11111111111111111111111111111111";
const GUARDIAN_PLUGINS_DEPOSIT = "50000000000000000000000"; // 0.05 NEAR (guardian ADAPTER_REGISTRATION_DEPOSIT)

async function tryView<T>(rpc: NearRpc, contract: string, method: string, args: object = {}): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: (await rpc.view<T>(contract, method, args, { finality: "final" })).value };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 160) };
  }
}

/** Accounts that can approve proposals in a Sputnik policy (roles with an approve or `*` permission). */
export function daoCouncil(policy: any): string[] {
  const out = new Set<string>();
  for (const r of policy?.roles ?? []) {
    const perms: string[] = r.permissions ?? [];
    const approves = perms.some((p) => p === "*:*" || p.endsWith(":VoteApprove") || p === "*:VoteApprove");
    if (approves && Array.isArray(r.kind?.Group)) for (const a of r.kind.Group) out.add(a);
  }
  return [...out];
}

export async function detect(rpc: NearRpc, network: NetworkId, contractId: string, guardianId?: string): Promise<Detection> {
  const probes: Detection["probes"] = [];
  const note = (name: string, ok: boolean, value?: unknown) => probes.push({ name, ok, value, source: "detected" });

  let codeHash: string | null = null;
  try {
    const acc = await rpc.viewAccount(contractId);
    codeHash = acc.code_hash;
    note("view_account", true, { code_hash: acc.code_hash });
  } catch (e) {
    note("view_account", false, (e as Error).message.slice(0, 160));
  }
  const hasContract = !!codeHash && codeHash !== EMPTY_CODE;

  let fullAccessKeys = 0;
  try {
    const keys = (await rpc.call("query", { request_type: "view_access_key_list", finality: "final", account_id: contractId })).result;
    fullAccessKeys = (keys.keys ?? []).filter((k: any) => k.access_key?.permission === "FullAccess").length;
    note("view_access_key_list", true, { fullAccessKeys });
  } catch (e) {
    note("view_access_key_list", false, (e as Error).message.slice(0, 160));
  }

  const base = { network, contractId, at: new Date().toISOString(), hasContract, codeHash, fullAccessKeys };
  if (!hasContract) {
    return { ...base, kind: "unknown", plugins: null, guard: null, owner: null, dao: null, token: null, guardianRegistration: null, level: 0, recommended: { level: 0, path: "watch-only", explain: "No contract is deployed on this account.", signer: null, viaDao: false }, probes };
  }

  const [paused, roles, supers, guardStatus, ownView1, ownView2, policy, ft] = await Promise.all([
    tryView<string[] | null>(rpc, contractId, "pa_all_paused"),
    tryView<string[]>(rpc, contractId, "acl_role_variants"),
    tryView<string[]>(rpc, contractId, "acl_get_super_admins", { skip: 0, limit: 20 }),
    tryView<any>(rpc, contractId, "guard_status"),
    tryView<string>(rpc, contractId, "get_owner"),
    tryView<string>(rpc, contractId, "owner"),
    tryView<any>(rpc, contractId, "get_policy"),
    tryView<any>(rpc, contractId, "ft_metadata"),
  ]);
  note("pa_all_paused (near-plugins Pausable)", paused.ok, paused.ok ? paused.value : undefined);
  note("acl_role_variants (near-plugins ACL)", roles.ok, roles.ok ? roles.value : undefined);
  note("acl_get_super_admins", supers.ok, supers.ok ? supers.value : undefined);
  note("guard_status (qorvex-guard)", guardStatus.ok, guardStatus.ok ? { owner: guardStatus.value?.owner, guardian: guardStatus.value?.guardian } : undefined);
  note("get_owner", ownView1.ok, ownView1.ok ? ownView1.value : undefined);
  note("owner", ownView2.ok, ownView2.ok ? ownView2.value : undefined);
  note("get_policy (Sputnik DAO)", policy.ok && Array.isArray(policy.value?.roles), policy.ok ? { roles: (policy.value?.roles ?? []).map((r: any) => r.name) } : undefined);
  note("ft_metadata (NEP-141)", ft.ok, ft.ok ? { symbol: ft.value?.symbol, decimals: ft.value?.decimals } : undefined);

  const plugins =
    paused.ok || roles.ok
      ? {
          pausable: paused.ok,
          pausedFeatures: paused.ok ? (paused.value ?? []) : [],
          roles: roles.ok ? roles.value : [],
          superAdmins: supers.ok ? supers.value : [],
          pauseRole: roles.ok ? (roles.value.find((r) => /pause/i.test(r) && !/unpause/i.test(r)) ?? null) : null,
        }
      : null;
  const guard = guardStatus.ok && guardStatus.value ? { owner: String(guardStatus.value.owner), guardian: guardStatus.value.guardian ?? null, selfAccounting: !!guardStatus.value.self_accounting } : null;
  const isDao = policy.ok && Array.isArray(policy.value?.roles);
  const dao = isDao ? { council: daoCouncil(policy.value), roles: policy.value.roles.map((r: any) => r.name) } : null;
  const token = ft.ok && ft.value?.symbol ? { symbol: String(ft.value.symbol), decimals: Number(ft.value.decimals) } : null;

  // Who controls it: explicit owner views first, then the first near-plugins super-admin that is not the contract itself.
  let ownerId: string | null = null;
  let via = "";
  if (guard) [ownerId, via] = [guard.owner, "guard_status.owner"];
  else if (ownView1.ok && typeof ownView1.value === "string") [ownerId, via] = [ownView1.value, "get_owner"];
  else if (ownView2.ok && typeof ownView2.value === "string") [ownerId, via] = [ownView2.value, "owner"];
  else if (plugins?.superAdmins.length) {
    const sa = plugins.superAdmins.find((a) => a !== contractId) ?? plugins.superAdmins[0];
    [ownerId, via] = [sa, "acl_get_super_admins"];
  }
  let owner: Detection["owner"] = null;
  if (ownerId) {
    const op = ownerId === contractId ? policy : await tryView<any>(rpc, ownerId, "get_policy");
    const ownerIsDao = op.ok && Array.isArray((op.value as any)?.roles);
    note(`get_policy on owner ${ownerId}`, ownerIsDao, ownerIsDao ? { council: daoCouncil(op.ok ? op.value : null) } : undefined);
    owner = { accountId: ownerId, via, isDao: ownerIsDao, council: ownerIsDao && op.ok ? daoCouncil(op.value) : [] };
  }

  let guardianRegistration: Detection["guardianRegistration"] = null;
  if (guardianId) {
    const t = await tryView<any>(rpc, guardianId, "get_target", { target: contractId });
    if (t.ok && t.value) {
      const adapter = typeof t.value.adapter === "string" ? t.value.adapter : Object.keys(t.value.adapter ?? { QorvexGuard: 1 })[0];
      guardianRegistration = { adapter, council: t.value.council, scopes: t.value.scopes ?? ["ALL"] };
    }
    note(`get_target on guardian ${guardianId}`, t.ok && !!t.value, guardianRegistration ?? undefined);
  }

  const kind: Detection["kind"] = guard ? "qorvex-guard" : isDao ? "sputnik-dao" : plugins ? "near-plugins" : token ? "fungible-token" : "unknown";
  let level: ProtectionLevel = 0;
  if (guard && guardianId && guard.guardian === guardianId && guardianRegistration) level = 3;
  else if (guardianRegistration) level = 2;
  else if (guard || plugins?.pausable) level = 1;

  const signer = owner?.accountId ?? null;
  const viaDao = !!owner?.isDao;
  let recommended: Detection["recommended"];
  if (guard) {
    recommended = { level: 3, path: "set-guardian", explain: `The contract embeds qorvex-guard. Its owner (${guard.owner}) calls set_guardian once: the contract registers itself with the guardian in the same transaction.`, signer: guard.owner, viaDao };
  } else if (plugins?.pausable && plugins.pauseRole) {
    recommended = {
      level: 2,
      path: "near-plugins-grant",
      explain: `The contract uses near-plugins Pausable. ${signer ?? "A super-admin"} grants the ${plugins.pauseRole} role to the guardian (acl_grant_role), then registers the contract with the guardian, which reads both settings back from the contract.`,
      signer,
      viaDao,
    };
  } else if (isDao) {
    recommended = { level: 1, path: "dao-firewall", explain: "This is a Sputnik DAO. Qorvex adds a reject-only role that votes down proposals breaking your policy; it can never approve.", signer: null, viaDao: true };
  } else {
    recommended = {
      level: plugins?.pausable ? 1 : 0,
      path: "watch-only",
      explain: plugins?.pausable
        ? "near-plugins Pausable was found but no pause role, so alerts carry a ready-to-sign pause instead."
        : "No pause method was recognised. Qorvex can watch and alert; to pause automatically, embed qorvex-guard or near-plugins Pausable.",
      signer,
      viaDao,
    };
  }
  return { ...base, kind, plugins, guard, owner, dao, token, guardianRegistration, level, recommended, probes };
}

/**
 * Does one of `accounts` control the contract? Re-reads the chain via `detect`.
 * Returns the first matching method, or null.
 */
export function authorityFrom(d: Detection, accounts: string[]): Pick<AuthorityClaim, "method" | "evidence"> | null {
  const has = (a: string | null | undefined) => !!a && accounts.includes(a);
  for (const a of accounts) {
    if (a === d.contractId && d.fullAccessKeys > 0) return { method: "contract-account", evidence: { account: a, detail: `${a} is the contract account and holds a full-access key on it` } };
  }
  if (d.owner && !d.owner.isDao && has(d.owner.accountId)) return { method: "owner-account", evidence: { account: d.owner.accountId, detail: `${d.owner.accountId} is the owner (read from ${d.owner.via})` } };
  const sa = d.plugins?.superAdmins.find((x) => has(x));
  if (sa) return { method: "near-plugins-admin", evidence: { account: sa, detail: `${sa} is a near-plugins super-admin of ${d.contractId}` } };
  const council = [...(d.owner?.isDao ? d.owner.council : []), ...(d.dao?.council ?? [])];
  const member = council.find((x) => has(x));
  if (member) {
    const dao = d.dao ? d.contractId : d.owner!.accountId;
    return { method: "dao-council", evidence: { account: member, detail: `${member} is on the council of ${dao}, which ${d.dao ? "is" : "controls"} the contract` } };
  }
  return null;
}

const yocto1 = "1";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

/**
 * Wallet transactions for the recommended path. When the controller is a DAO,
 * each call becomes an `add_proposal` the council votes on (the bond is read
 * from the DAO's policy by the caller and passed in).
 */
export function authorisationTxs(d: Detection, guardianId: string, opts: { daoBond?: string; scopes?: string[] } = {}): WalletTx[] {
  const calls: Call[] = [];
  if (d.recommended.path === "set-guardian") {
    calls.push({ receiverId: d.contractId, methodName: "set_guardian", args: { guardian_id: guardianId }, deposit: yocto1, gas: "60000000000000", explain: `Let the Qorvex guardian pause ${d.contractId} (the contract registers itself with the guardian).` });
  } else if (d.recommended.path === "near-plugins-grant" && d.plugins?.pauseRole) {
    calls.push({ receiverId: d.contractId, methodName: "acl_grant_role", args: { role: d.plugins.pauseRole, account_id: guardianId }, deposit: "0", gas: "30000000000000", explain: `Give the guardian the ${d.plugins.pauseRole} role on ${d.contractId}. It can pause; it cannot unpause.` });
    calls.push({
      receiverId: guardianId,
      methodName: "register_plugins_target",
      args: { target: d.contractId, role: d.plugins.pauseRole, scopes: opts.scopes ?? ["ALL"] },
      deposit: GUARDIAN_PLUGINS_DEPOSIT,
      gas: "100000000000000",
      explain: `Register ${d.contractId} with the guardian (0.05 NEAR storage). The guardian reads back that you are an admin and that it holds the role, and refunds the deposit if not.`,
    });
  } else {
    return [];
  }
  return wrapForController(d, calls, opts.daoBond);
}

type Call = { receiverId: string; methodName: string; args: Record<string, unknown>; deposit: string; gas: string; explain: string };

/** Calls signed directly by the controller, or each wrapped in an add_proposal when a DAO controls the contract. */
function wrapForController(d: Detection, calls: Call[], daoBond?: string): WalletTx[] {
  if (!d.recommended.viaDao || !d.owner) {
    return calls.map((c) => ({ receiverId: c.receiverId, explain: c.explain, actions: [{ type: "FunctionCall", params: { methodName: c.methodName, args: c.args, gas: c.gas, deposit: c.deposit } }] }));
  }
  const dao = d.owner.accountId;
  return calls.map((c) => ({
    receiverId: dao,
    explain: `Propose to the ${dao} council: ${c.explain}`,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "add_proposal",
          args: { proposal: { description: c.explain, kind: { FunctionCall: { receiver_id: c.receiverId, actions: [{ method_name: c.methodName, args: b64(c.args), deposit: c.deposit, gas: c.gas }] } } } },
          gas: "100000000000000",
          deposit: daoBond ?? "0",
        },
      },
    ],
  }));
}

/**
 * Recovery after a pause, for the owner (or the DAO) to sign. Qorvex never
 * unpauses: these are transactions it prepares, nothing more.
 *  1. (if the guardian is in its 1-hour cooldown) the council allows one more automatic pause,
 *  2. unpause: qorvex-guard `unpause` (owner, 1 yoctoNEAR) or near-plugins `pa_unpause_feature(key)`.
 * Fixing the bug and restoring the books comes first and is the team's job.
 */
export function recoveryTxs(d: Detection, guardianId: string | undefined, o: { scope?: string; inCooldown?: boolean; daoBond?: string } = {}): { txs: WalletTx[]; notes: string[] } {
  const calls: Call[] = [];
  const notes = ["Find and fix the cause first: unpausing a contract whose books still do not add up lets the drain continue."];
  if (guardianId && d.guardianRegistration && o.inCooldown) {
    calls.push({ receiverId: guardianId, methodName: "allow_repeat_pause", args: { target: d.contractId }, deposit: "1", gas: "30000000000000", explain: `Let the guardian pause ${d.contractId} again within the hour if the rule breaks again (signed by the council, ${d.guardianRegistration.council}).` });
  }
  if (d.guard || d.kind === "qorvex-guard") {
    calls.push({ receiverId: d.contractId, methodName: "unpause", args: {}, deposit: "1", gas: "30000000000000", explain: `Unpause ${d.contractId} (owner only, 1 yoctoNEAR).` });
  } else if (d.plugins?.pausable) {
    calls.push({ receiverId: d.contractId, methodName: "pa_unpause_feature", args: { key: o.scope ?? "ALL" }, deposit: "0", gas: "30000000000000", explain: `Unpause ${o.scope ?? "ALL"} on ${d.contractId} (needs an account with the unpause role).` });
  } else {
    notes.push("Qorvex does not know this contract's unpause method: use your own admin tooling.");
  }
  return { txs: wrapForController(d, calls, o.daoBond), notes };
}
