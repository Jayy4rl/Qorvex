import { C, DocLink, H2, Lead } from "../prose";

export default function SecurityModel() {
  return (
    <>
      <Lead>
        Qorvex is designed so that a compromised Qorvex can, at worst, pause a contract once an hour or vote against a proposal. It can’t move funds,
        unpause, change limits or approve anything.
      </Lead>

      <H2 id="keys">The keys Qorvex holds</H2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Scope (enforced by NEAR)</th>
              <th>Can’t</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Watcher key</td>
              <td>
                Function-call key on the watcher account: <C>receiver_id</C> = guardian, <C>method_names</C> = <C>["pause"]</C>.
              </td>
              <td>
                Attach deposits; call any other method or contract. The demo and e2e tests check it can’t call <C>set_watchers</C>,{" "}
                <C>register_target</C> or <C>unpause</C>.
              </td>
            </tr>
            <tr>
              <td>Firewall key (DAOs only)</td>
              <td>
                One function-call key per DAO, limited to <C>act_proposal</C>. The firewall role holds only <C>VoteReject</C> permissions.
              </td>
              <td>Approve a proposal, add proposals, or act on any other contract.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <H2 id="boundaries">Trust boundaries</H2>
      <ul>
        <li>
          <strong>Guardian contract:</strong> no unpause, no limit setting, no transfer method. Only its owner, with 1 yoctoNEAR attached, can change the
          watcher list, so a function-call key can’t. At most one automatic pause per target per hour unless the target’s council allows another. Every
          pause is public through <C>pause_history</C>.
        </li>
        <li>
          <strong>Protected contract:</strong> accepts <C>pause</C> only from the guardian. Unpausing and setting limits need the owner and 1
          yoctoNEAR.
        </li>
        <li>
          <strong>The AI:</strong> drafts rules and explains breaches. Rules start as drafts with response <C>alert</C> and need a person to approve
          them. The pause decision is made by deterministic code in the rule evaluator and watcher, with no model call on that path.
        </li>
        <li>
          <strong>Operator API:</strong> one operator token (<C>QORVEX_ADMIN_TOKEN</C>, at least 16 characters). Relayers authenticate with their own
          tokens, stored only as SHA-256 hashes.
        </li>
        <li>
          <strong>If Qorvex goes down:</strong> in-contract limits and the self-accounting check keep working. The relayer SDK keeps its cached budgets.
        </li>
        <li>
          <strong>Verification:</strong> anyone can reproduce any status-page value from the raw RPC read it links to.
        </li>
      </ul>

      <H2 id="risks">Risks and mitigations</H2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Risk</th>
              <th>Mitigation</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>False pause</td>
              <td>Confirmation read before firing, backtest before approval, alert-only by default, auto-pause only for rules with zero backtest fires.</td>
            </tr>
            <tr>
              <td>False confidence from a green page</td>
              <td>The page lists exactly what is checked and at which block, and states that single-transaction drains are out of the watcher’s reach.</td>
            </tr>
            <tr>
              <td>Watcher outage or RPC lag</td>
              <td>Several RPC providers; in-contract limits keep working without the watcher.</td>
            </tr>
            <tr>
              <td>Guardian bug or stolen watcher key</td>
              <td>The guardian can only pause. Owner-only watcher list, hourly pause limit, public pause history. The contract is small enough to review line by line.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <H2 id="limitations">Known limitations</H2>
      <ul>
        <li>
          <strong>Single-transaction drains:</strong> the watcher can’t stop them. Use the <DocLink slug="contract-guard">guard crate</DocLink>.
        </li>
        <li>
          <strong>Pause latency:</strong> 4 blocks on the sandbox against a 3-block target. Testnet hasn’t been measured.
        </li>
        <li>
          <strong>Proposal firewall race:</strong> a single-member DAO that approves its own proposal within about 3 blocks can beat the firewall.
        </li>
        <li>
          <strong>One process:</strong> the store is JSON files and the relayer SDK keeps spend history per process. Run one watcher and one SDK instance
          per relayer.
        </li>
        <li>
          <strong>Sampled backtests:</strong> solvency backtests sample block heights, not every block. Outflow backtests replay only recent blocks.
        </li>
        <li>
          <strong>30-day mainnet backtest:</strong> not measured yet; the public archival node rate-limits heavily.
        </li>
        <li>
          <strong>Wallet signing:</strong> in-browser wallet signing isn’t wired up. Sign the guardian authorisation with near-cli-rs or your wallet.
        </li>
        <li>
          <strong>Attestation:</strong> TEE attestation reports are stored but not independently verified.
        </li>
        <li>
          <strong>Pause-state check:</strong> reads an <C>is_paused</C> view; contracts without one are assumed not paused.
        </li>
        <li>
          <strong>Free block-stream tier:</strong> neardata.xyz rate-limits full mainnet blocks. Set <C>FASTNEAR_API_KEY</C>, switch to RPC following, or
          run a NEAR Indexer node.
        </li>
        <li>
          <strong>Not built:</strong> embeddable badges and user alerts (S3), TEE-attested watchers (L1), multi-watcher quorum (L2), phone push and
          PagerDuty alerts.
        </li>
      </ul>
    </>
  );
}
