import { CodeBlock } from "../../../components/CodeBlock";
import { C, Callout, DocLink, H2, Lead, RepoPath } from "../prose";

export default function WatcherGuardian() {
  return (
    <>
      <Lead>
        The watcher follows the chain from outside, evaluates approved rules, and contains confirmed breaches. The guardian contract is the narrow
        on-chain door it uses to pause.
      </Lead>

      <H2 id="breach-flow">What happens on a breach</H2>
      <ol className="flow">
        <li>
          <strong>Stream</strong>
          The watcher follows every block. On testnet and mainnet it streams from neardata.xyz (<C>QORVEX_&lt;NET&gt;_STREAM=neardata</C>), or follows
          blocks and chunks over RPC (<C>rpc</C>, always used on the sandbox). Only receipts that touch a protected account trigger evaluation.
        </li>
        <li>
          <strong>Evaluate</strong>
          Approved solvency and outflow-rate rules are evaluated in the block the receipt lands in. A periodic heartbeat also re-evaluates solvency
          rules so read-only pages stay current when the stream is rate-limited.
        </li>
        <li>
          <strong>Confirm</strong>
          Before firing, the watcher re-reads the failing values with one direct RPC view call at the latest block. It fires as soon as the failure is
          confirmed, without waiting for more blocks.
        </li>
        <li>
          <strong>Pause</strong>
          For a rule approved as <C>pause</C>, the executor signs <C>guardian.pause(target, rule_id, evidence_hash)</C> with the watcher’s function-call
          key and broadcasts the same signed bytes to every configured RPC provider at once. It never waits on the AI.
        </li>
        <li>
          <strong>Alert and record</strong>
          An alert reports the incident as contained, and the breach log records the rule, observed values, block, transactions involved and the pause
          transaction.
        </li>
        <li>
          <strong>Explain</strong>
          After the pause has landed, the explanation model writes what broke, by how much, and which accounts and transactions to check first.
        </li>
      </ol>

      <H2 id="latency">Measured latency</H2>
      <p>On the local sandbox (nearcore 2.13.4), replaying the NEAR Intents ghost-balance bug:</p>
      <CodeBlock
        label="breach timeline"
        copy={false}
        code={`block 168 produced
  → received by the watcher   +658 ms   (RPC polling)
  → evaluated                 +11 ms
  → confirmed and signed      +19 ms   → broadcast
pause tx in block 170 → guardian receipt in 171 → target paused in 172

4 blocks, 3.0 s after detection`}
      />
      <p>
        The PRD target is 3 blocks; the transaction lands one block later than ideal. Reaching 3 blocks needs a node-local indexer (the NEAR Indexer
        framework) instead of polling. Testnet latency has not been measured yet.
      </p>
      <Callout tone="warn" title="What the watcher can’t do">
        <p>
          A drain that finishes inside a single transaction is out of the watcher’s reach. That’s what the in-contract{" "}
          <DocLink slug="contract-guard">guard</DocLink> is for.
        </p>
      </Callout>

      <H2 id="guardian">The guardian contract</H2>
      <p>
        The guardian (<RepoPath path="contracts/guardian" />) is Qorvex’s only contract. It records each pause on-chain and forwards it. It has no
        unpause, no limit setting and no transfer method.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Method</th>
              <th>Who can call it</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <C>pause(target, rule_id, evidence_hash)</C>
              </td>
              <td>Approved watchers, no deposit</td>
              <td>
                Records the pause (rule, evidence hash, watcher, block), then calls the target’s <C>pause()</C>.
              </td>
            </tr>
            <tr>
              <td>
                <C>register_target(council)</C>
              </td>
              <td>The target contract itself, with 0.01 NEAR for storage</td>
              <td>Registers a contract and names its council.</td>
            </tr>
            <tr>
              <td>
                <C>allow_repeat_pause(target)</C>
              </td>
              <td>The target’s council</td>
              <td>Allows one more automatic pause inside the cooldown.</td>
            </tr>
            <tr>
              <td>
                <C>set_watchers(add, remove)</C>
              </td>
              <td>Owner only, 1 yoctoNEAR</td>
              <td>Changes the watcher list. No function-call key can call it.</td>
            </tr>
            <tr>
              <td>
                <C>pause_history(target, from_index, limit)</C>
              </td>
              <td>Anyone (view)</td>
              <td>Every pause with its block, rule ID, evidence hash, watcher and status.</td>
            </tr>
            <tr>
              <td>
                <C>get_target</C>, <C>watchers</C>, <C>is_watcher</C>, <C>owner</C>
              </td>
              <td>Anyone (view)</td>
              <td>Registration and configuration reads.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        <strong>Cooldown.</strong> The guardian allows at most one automatic pause per target per hour unless the target’s council allows another. This
        stops repeated griefing pauses from a compromised watcher.
      </p>
      <CodeBlock
        label="pause_history entry from the demo"
        copy={false}
        code={`{"index":0,"target":"ledger.test.near","rule_id":"solvency-usdc",
 "evidence_hash":"f2e0cfb4955c8826fdd0a74748f74ac435172ab70aa39b5cebd1b4647dbc389b",
 "watcher":"watcher.test.near","block_height":"171","status":"Paused","council_override":false}`}
      />

      <H2 id="recovery">Recovery</H2>
      <p>
        Qorvex cannot unpause. The operator investigates using the breach record, fixes the bug, and unpauses with the owner key or a DAO vote (1
        yoctoNEAR attached). If the books still don’t balance, a guarded contract trips again on the next outflow.
      </p>

      <H2 id="alerts">Alerts</H2>
      <p>
        Alerts go out the moment an incident is contained (after the pause lands), or immediately for alert-only rules. Channels are configured only
        through environment variables:
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Channel</th>
              <th>Variables</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Telegram</td>
              <td>
                <C>TELEGRAM_BOT_TOKEN</C>, <C>TELEGRAM_CHAT_ID</C>
              </td>
              <td>Implemented; not yet tested against the live Telegram API.</td>
            </tr>
            <tr>
              <td>Webhook</td>
              <td>
                <C>QORVEX_WEBHOOK_URL</C>, <C>QORVEX_WEBHOOK_SECRET</C>
              </td>
              <td>
                Signed with HMAC-SHA256 in the <C>x-qorvex-signature</C> header. Tested.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Set <C>PUBLIC_URL</C> so alert links point at your deployment. Phone push and PagerDuty are not built.
      </p>

      <H2 id="firewall-path">DAO proposals</H2>
      <p>
        For Sputnik DAOs, the same stream feeds the proposal firewall. Each new proposal is checked against the DAO’s approved{" "}
        <DocLink slug="security-policies" anchor="proposal-policy">proposal policy</DocLink>; a violation with the <C>reject</C> response is answered
        with <C>act_proposal(VoteReject)</C> from the firewall key, which is limited to <C>act_proposal</C> on that DAO.
      </p>
    </>
  );
}
