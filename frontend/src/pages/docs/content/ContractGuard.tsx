import { CodeBlock } from "../../../components/CodeBlock";
import { C, Callout, DocLink, H2, Lead, RepoPath } from "../prose";

const CARGO = `[dependencies]
near-sdk = "5"
qorvex-guard = { path = "../qorvex/contracts/qorvex-guard" }`;

const STATE = `use qorvex_guard::{Guard, Limit, Outflow};

#[near(contract_state)]
pub struct Contract {
    guard: Guard,
    // ... your state
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            // storage prefix, owner, guardian (set later), self-accounting on
            guard: Guard::new(StorageKey::Guard, owner_id, None, true),
        }
    }
}`;

const WITHDRAW = `#[payable]
pub fn withdraw(&mut self, token_id: AccountId, amount: U128) -> PromiseOrValue<bool> {
    // Panics if paused or over the cap. On a self-accounting failure the guard
    // pauses the contract and returns Tripped: return normally, don't panic.
    match self.guard.begin_outflow(&token_id, amount.0) {
        Outflow::Tripped => return PromiseOrValue::Value(false),
        Outflow::Allowed => {}
    }
    self.internal_debit(&user, &token_id, amount.0); // calls self.guard.debit(...)
    // ... ft_transfer, then a callback that calls
    //     self.guard.revert_outflow(&token_id, amount.0) if the transfer failed
}`;

const ADMIN = `/// Guardian contract only. No deposit, so the watcher's function-call key reaches it.
pub fn pause(&mut self, rule_id: Option<String>, evidence_hash: Option<String>) {
    self.guard.pause_by_guardian(format!("guardian: rule {:?} evidence {:?}", rule_id, evidence_hash));
}

/// Owner only, 1 yoctoNEAR.
#[payable]
pub fn unpause(&mut self) { self.guard.unpause(); }

/// Owner only, 1 yoctoNEAR. cap = None removes the limit.
#[payable]
pub fn set_limits(&mut self, token_id: AccountId, cap: Option<U128>, window_sec: Option<u64>) {
    let limit = cap.map(|cap| Limit { cap, window_sec: window_sec.unwrap_or(3600) });
    self.guard.set_limit(token_id, limit);
}

pub fn is_paused(&self) -> bool { self.guard.is_paused() }
pub fn guard_status(&self) -> GuardStatus { self.guard.status() }`;

export default function ContractGuard() {
  return (
    <>
      <Lead>
        <C>qorvex-guard</C> is a Rust crate for near-sdk contracts. It adds per-token outflow caps, a self-accounting check that pauses the contract in
        the same transaction, and a <C>pause()</C> that only the guardian contract can call.
      </Lead>
      <p>
        The guard keeps working when the Qorvex service is down: caps and self-accounting run entirely from the contract’s own state. It requires a
        code change and redeploy, so teams that can’t touch their contract can start with the <DocLink slug="watcher-and-guardian">watcher</DocLink>{" "}
        or the <DocLink slug="relayer-sdk">relayer SDK</DocLink>.
      </p>

      <H2 id="install">Add the crate</H2>
      <p>
        The crate lives in <RepoPath path="contracts/qorvex-guard" /> of the Qorvex repository and is not published to crates.io. Add it as a path
        or git dependency:
      </p>
      <CodeBlock label="Cargo.toml" code={CARGO} />

      <H2 id="embed">Embed the guard</H2>
      <p>
        Put a <C>Guard</C> in your contract state. The prefix must not collide with your other storage prefixes. With self-accounting off, the tally is
        still kept and visible in views but never trips; caps and the guardian pause still apply.
      </p>
      <CodeBlock label="lib.rs" code={STATE} />

      <H2 id="hooks">Call the hooks</H2>
      <p>The guard needs to see every deposit, credit, debit and outflow. Call these from the matching places in your contract:</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Hook</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <C>assert_not_paused()</C>
              </td>
              <td>At the top of every method that moves value out or credits users.</td>
            </tr>
            <tr>
              <td>
                <C>begin_deposit(token, amount)</C>
              </td>
              <td>
                A deposit arrives, e.g. at the start of <C>ft_on_transfer</C>. It counts as pending backing until settled.
              </td>
            </tr>
            <tr>
              <td>
                <C>settle_deposit(token, amount, refund)</C>
              </td>
              <td>
                The deposit is final and <C>refund</C> goes back to the sender. Runs the self-accounting check; returns <C>false</C> if it tripped.
              </td>
            </tr>
            <tr>
              <td>
                <C>credit(token, amount)</C> / <C>debit(token, amount)</C>
              </td>
              <td>A user’s internal balance goes up or down.</td>
            </tr>
            <tr>
              <td>
                <C>begin_outflow(token, amount)</C>
              </td>
              <td>
                Before sending tokens out. Checks pause, self-accounting and the cap, then records the outflow. Returns <C>Allowed</C> or{" "}
                <C>Tripped</C>.
              </td>
            </tr>
            <tr>
              <td>
                <C>revert_outflow(token, amount)</C>
              </td>
              <td>The outgoing transfer failed and the tokens never left.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <CodeBlock label="guarded withdraw" code={WITHDRAW} />
      <Callout tone="warn" title="Don’t panic on Tripped">
        <p>
          When the self-accounting check fails, the guard has already set the contract to paused. Return normally without sending anything. A panic
          would roll the pause back with the rest of the receipt.
        </p>
      </Callout>

      <H2 id="self-accounting">How self-accounting works</H2>
      <p>
        The guard tracks, per token, deposits still pending, deposits confirmed, outflows sent, and the net amount credited to users. The invariant is{" "}
        <C>credited ≤ pending + confirmed − out</C>.
      </p>
      <p>
        Because deposits count as pending until their callback settles them, a legitimate asynchronous deposit never trips the check. In the NEAR
        Intents pattern, a credit survives its own refund: that breaks the invariant inside the settling callback, and the contract pauses there, in
        the same transaction. In the sandbox demo, the guarded vault paused inside the ghost-deposit transaction itself (
        <C>credited 290000000000 &gt; backing 250000000000</C>).
      </p>

      <H2 id="admin">Pause, unpause and limits</H2>
      <CodeBlock label="admin methods" code={ADMIN} />
      <ul>
        <li>
          <C>pause_by_guardian</C> accepts only the configured guardian account. No deposit is required, so the watcher’s function-call key can reach
          it through the guardian.
        </li>
        <li>
          <C>unpause</C>, <C>set_limit</C> and <C>set_guardian</C> require the owner and exactly 1 yoctoNEAR. Function-call keys can’t attach a
          deposit, so a leaked function-call key can never pass this check.
        </li>
        <li>
          <C>set_limit</C> resets the token’s current window usage. A limit is a cap in the token’s smallest unit per <C>window_sec</C>.
        </li>
      </ul>

      <H2 id="guardian">Register with the guardian</H2>
      <p>
        Your <C>set_guardian</C> method should store the guardian and, in the same transaction, call <C>guardian.register_target(council)</C>{" "}
        attaching 0.01 NEAR for the guardian’s storage. The council (usually the owner or DAO) can allow an extra pause inside the guardian’s one-hour
        cooldown. Qorvex gives you the exact transaction; see <DocLink slug="connecting-contracts" anchor="authorise">Authorise the guardian</DocLink>.
      </p>

      <H2 id="views">Views and events</H2>
      <p>
        <C>guard.status()</C> returns the owner, guardian, self-accounting flag, pause info, limits with window usage, and per-token tallies including{" "}
        <C>credited</C> and <C>backing</C>. Expose it as <C>guard_status</C>: Qorvex reads it to verify the guardian setting. The watcher reads{" "}
        <C>is_paused</C>; contracts without it are assumed not paused. The guard emits NEP-297 events.
      </p>
      <p>
        The deliberately vulnerable <RepoPath path="contracts/demo-ledger" /> shows a full integration. Never deploy it with real funds.
      </p>
    </>
  );
}
