import { CodeBlock } from "../../../components/CodeBlock";
import { C, Callout, DocLink, H2, Lead, RepoPath } from "../prose";

const SOLVENCY = `{
  "id": "solvency-usdc",
  "type": "solvency",
  "token": "usdc.near",
  "owed": { "view": "mt_supply", "args": { "token_id": "nep141:usdc.near" } },
  "held": { "contract": "usdc.near", "view": "ft_balance_of", "args": { "account_id": "ledger.near" } },
  "explain": "USDC owed to users must never exceed USDC held"
}`;

const OUTFLOW = `{
  "id": "outflow-usdc-1h",
  "type": "outflow_rate",
  "token": "usdc.near",
  "max": "100000000000",
  "window_sec": 3600,
  "explain": "No more than 100,000 USDC may leave the ledger per hour"
}`;

const POLICY = `{
  "id": "treasury-policy",
  "type": "proposal_policy",
  "max_transfer": { "usdc.near": "50000000000" },
  "allowed_call_contracts": ["vault.near"],
  "max_actions_per_call": 20,
  "max_call_deposit_yocto": "100000000000000000000000",
  "alert_on_governance": true,
  "explain": "Treasury transfers of at most 50,000 USDC, calls only to vault.near"
}`;

export default function SecurityPolicies() {
  return (
    <>
      <Lead>
        A policy is a rule Qorvex evaluates deterministically, plus the response you approved for it. Rules are JSON, each with a plain-English
        sentence that appears to operators and on the status page.
      </Lead>

      <H2 id="rule-types">Rule types</H2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Checks</th>
              <th>Evaluated</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <C>solvency</C>
              </td>
              <td>
                Per token: <C>owed ≤ held</C>. Both sides are view-method reads.
              </td>
              <td>On every block with a receipt that touches the contract, then confirmed with a fresh read.</td>
            </tr>
            <tr>
              <td>
                <C>outflow_rate</C>
              </td>
              <td>
                Outflows of a token stay under <C>max</C> (smallest units) per <C>window_sec</C>.
              </td>
              <td>
                Counted from the receipt stream: <C>ft_transfer</C> / <C>ft_transfer_call</C> sent by the contract, or native NEAR transfers when{" "}
                <C>token</C> is <C>"near"</C>.
              </td>
            </tr>
            <tr>
              <td>
                <C>proposal_policy</C>
              </td>
              <td>Sputnik DAO proposals against caps and allow-lists.</td>
              <td>When each new proposal appears.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <H2 id="solvency">Solvency</H2>
      <p>
        <C>owed</C> and <C>held</C> are view references: <C>view</C>, optional <C>args</C>, optional <C>contract</C> (defaults to the protected
        contract) and optional <C>path</C> (a dot path into the JSON result when the amount is nested).
      </p>
      <CodeBlock label="solvency rule" code={SOLVENCY} />
      <p>
        On NEAR Intents, for example, <C>owed</C> is <C>intents.near</C> <C>mt_supply("nep141:&lt;token&gt;")</C> and <C>held</C> is{" "}
        <C>&lt;token&gt;.ft_balance_of("intents.near")</C>.
      </p>

      <H2 id="outflow">Outflow rate</H2>
      <CodeBlock label="outflow_rate rule" code={OUTFLOW} />

      <H2 id="proposal-policy">Proposal policy (DAO firewall)</H2>
      <p>Every new proposal on a protected Sputnik DAO is checked against these limits. All fields are optional.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <C>max_transfer</C>
              </td>
              <td>
                Per-proposal cap by token contract, or <C>"near"</C>. Applies to Transfer proposals and to <C>ft_transfer</C> actions inside
                FunctionCall proposals.
              </td>
            </tr>
            <tr>
              <td>
                <C>allowed_receivers</C>
              </td>
              <td>If set, transfer receivers must be in this list.</td>
            </tr>
            <tr>
              <td>
                <C>allowed_call_contracts</C>
              </td>
              <td>If set, FunctionCall proposals may only call these contracts.</td>
            </tr>
            <tr>
              <td>
                <C>max_actions_per_call</C>
              </td>
              <td>Maximum actions in one FunctionCall proposal. The Trezu drain used 200.</td>
            </tr>
            <tr>
              <td>
                <C>max_call_deposit_yocto</C>
              </td>
              <td>Maximum NEAR attached across all actions of one FunctionCall proposal.</td>
            </tr>
            <tr>
              <td>
                <C>alert_on_governance</C>
              </td>
              <td>Alert, never vote, on policy, role, config and upgrade proposals.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <CodeBlock label="proposal_policy rule" code={POLICY} />
      <p>
        With the <C>reject</C> response, Qorvex votes <C>VoteReject</C> through the firewall role. In the sandbox demo, an over-cap transfer and a
        drain-shaped proposal were each rejected 3 blocks after submission, and a normal invoice passed. Relayers can apply the same policy before
        sponsoring an approval; see <DocLink slug="relayer-sdk" anchor="proposals">checkProposal()</DocLink>.
      </p>

      <H2 id="responses">Responses</H2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Response</th>
              <th>What happens on a breach</th>
              <th>Allowed for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <C>alert</C>
              </td>
              <td>Alert and breach record only. The default for every draft.</td>
              <td>All rule types</td>
            </tr>
            <tr>
              <td>
                <C>pause</C>
              </td>
              <td>Alert, then pause through the guardian after a confirmation read.</td>
              <td>Solvency and outflow-rate rules with zero backtest fires</td>
            </tr>
            <tr>
              <td>
                <C>reject</C>
              </td>
              <td>Vote to reject the proposal through the firewall role.</td>
              <td>Proposal policies</td>
            </tr>
          </tbody>
        </table>
      </div>

      <H2 id="lifecycle">Lifecycle</H2>
      <ul>
        <li>
          Rules start as <C>draft</C> with response <C>alert</C>. Only <C>approved</C> rules are evaluated.
        </li>
        <li>Approval records who approved and when. Every rule records its origin: the AI drafter (with model and draft ID) or a named person.</li>
        <li>Editing a rule runs the validator and backtest again and sends it back to draft.</li>
        <li>The AI can’t edit approved rules and can’t trigger a pause.</li>
      </ul>

      <H2 id="drafting">AI drafting</H2>
      <p>
        Drafting runs on NEAR AI Cloud through its OpenAI-compatible API, using open-weight Qwen models served in TEEs, at temperature 0. The model for
        each job is one setting: <C>QORVEX_DRAFT_MODEL</C> for drafting, <C>QORVEX_EXPLAIN_MODEL</C> for breach explanations, and{" "}
        <C>QORVEX_FALLBACK_MODELS</C> for models tried in order when the primary fails.
      </p>
      <ol className="flow">
        <li>
          <strong>Collect inputs</strong>
          Contract source (NEP-330 or upload), the ABI if published, view methods, a few live state reads and recent receipts.
        </li>
        <li>
          <strong>Draft</strong>
          The model returns JSON in the rule format, each rule with a plain-English sentence.
        </li>
        <li>
          <strong>Validate</strong>
          Every view method a draft references is called and must return a value that parses. This catches invented method names.
        </li>
        <li>
          <strong>Backtest</strong>
          The rule is replayed against the contract’s history.
        </li>
        <li>
          <strong>Retry or drop</strong>
          A failing draft goes back to the model with the error, at most twice, and is then dropped. Only drafts that pass reach the operator.
        </li>
      </ol>
      <p>
        <C>QORVEX_AI_MODE</C> is <C>replay</C> (default: answers only from recorded responses in <RepoPath path="backend/fixtures/ai" />), <C>live</C>{" "}
        or <C>record</C>. With a live key, each drafting run stores the model’s TEE attestation report and chat signature.
      </p>
      <Callout tone="warn" title="Attestation">
        <p>Qorvex stores the attestation report but does not itself verify the NVIDIA NRAS or Intel TDX chain.</p>
      </Callout>

      <H2 id="backtest">Backtests</H2>
      <p>
        Solvency backtests sample block heights across the window rather than every block. Outflow backtests replay recent blocks. On mainnet, the
        window and sample count are <C>QORVEX_MAINNET_BACKTEST_DAYS</C> and <C>QORVEX_MAINNET_BACKTEST_SAMPLES</C>; archival reads are cached, so an
        interrupted backtest resumes. The public archival endpoint rate-limits heavily, so set <C>QORVEX_MAINNET_ARCHIVAL_RPC</C> to a paid endpoint.
      </p>
      <p>Re-run a backtest at any time:</p>
      <CodeBlock label="shell" code={'curl -s "${auth[@]}" -X POST $QORVEX/api/protocols/$ID/rules/$RULE/backtest'} />

      <H2 id="by-hand">Writing a rule by hand</H2>
      <p>Hand-written rules go through the same validator and backtest as AI drafts, and start as drafts.</p>
      <CodeBlock
        label="shell"
        code={'curl -s "${auth[@]}" -X POST $QORVEX/api/protocols/$ID/rules \\\n  -d \'{"author":"alice","rule":{"id":"outflow-usdc-1h","type":"outflow_rate","token":"usdc.near","max":"100000000000","window_sec":3600,"explain":"..."}}\''}
      />
    </>
  );
}
