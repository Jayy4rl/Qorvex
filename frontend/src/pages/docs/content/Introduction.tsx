import { Link } from "react-router";
import { CodeBlock } from "../../../components/CodeBlock";
import { DOCS, docPath } from "../../../lib/docs-index";
import { C, DocLink, H2, Lead, RepoPath } from "../prose";

const ARCHITECTURE = `                 operator (approves rules)                status page (anyone)
                        │                                        ▲ raw reads + curl
                        ▼                                        │
  NEAR AI Cloud ◄── drafter ── validator+backtest ──► rule store ┼──► relayer SDK check()  (pulls budgets)
  (TEE, Qwen)                                        │          │
                                                      ▼          │
  neardata.xyz / RPC block stream ──► watcher ── confirm read ── pause executor
                                                                  │ function-call key: guardian.pause only
                                                                  ▼
                                          guardian contract ── records pause (rule, evidence hash)
                                                                  │ pause(rule_id, evidence_hash)
                                                                  ▼
                                          protected contract (qorvex-guard: accepts pause only from guardian)`;

export default function Introduction() {
  return (
    <>
      <Lead>
        Qorvex gives NEAR contracts, DAO treasuries and gas relayers spending limits and circuit breakers. It blocks over-limit payments before they
        move, and pauses a contract within seconds when its books stop adding up.
      </Lead>
      <p>
        An open-weight model on NEAR AI Cloud drafts the rules, and a person approves each one. Deterministic code checks them on every block. When a
        rule fails, Qorvex pauses the contract through an on-chain guardian contract, using a key that can call nothing but <C>pause</C>.
      </p>

      <H2 id="who-its-for">Who it’s for</H2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Job to be done</th>
              <th>What Qorvex gives them</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Protocol or treasury operator</td>
              <td>Stop bad outflows, and learn about anything else that breaks after it’s already contained.</td>
              <td>AI-drafted rules, automatic pause through a key that can’t move funds, a proposal firewall for Sputnik DAOs.</td>
            </tr>
            <tr>
              <td>Relayer or gas sponsor</td>
              <td>Stop paying for abuse before the balance is drained.</td>
              <td>An SDK check before each sponsored transaction, with per-beneficiary budgets.</td>
            </tr>
            <tr>
              <td>Depositor</td>
              <td>Know whether a protocol is still fully backed.</td>
              <td>A public status page where every value links to the raw on-chain read.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <H2 id="layers">Layers</H2>
      <p>Qorvex has two enforcement layers, an AI assistant and a public view. You can adopt them independently.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Layer</th>
              <th>Component</th>
              <th>In the repository</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Prevent</td>
              <td>
                <DocLink slug="contract-guard">qorvex-guard</DocLink> Rust crate: per-token, per-window outflow caps, plus a self-accounting check that
                pauses the contract in the same transaction.
              </td>
              <td>
                <RepoPath path="contracts/qorvex-guard" />
              </td>
            </tr>
            <tr>
              <td>Prevent</td>
              <td>
                <DocLink slug="relayer-sdk">Relayer SDK</DocLink>: <C>check(beneficiary, action, cost)</C> with budgets pulled from Qorvex.
              </td>
              <td>
                <RepoPath path="backend/src/relayer/sdk.ts" />
              </td>
            </tr>
            <tr>
              <td>Detect and stop</td>
              <td>
                <DocLink slug="watcher-and-guardian">Watcher</DocLink>: streams blocks, evaluates rules on every receipt that touches a protected contract,
                confirms with a direct read, then pauses.
              </td>
              <td>
                <RepoPath path="backend/src/watcher" />
              </td>
            </tr>
            <tr>
              <td>Detect and stop</td>
              <td>
                <DocLink slug="watcher-and-guardian" anchor="guardian">
                  Guardian contract
                </DocLink>
                : the only contract Qorvex’s key can call. Records each pause on-chain and forwards <C>pause()</C>.
              </td>
              <td>
                <RepoPath path="contracts/guardian" />
              </td>
            </tr>
            <tr>
              <td>Detect and stop</td>
              <td>
                <DocLink slug="security-policies" anchor="proposal-policy">
                  Proposal firewall
                </DocLink>
                : votes to reject Sputnik DAO proposals that break the approved policy.
              </td>
              <td>
                <RepoPath path="backend/src/firewall" />
              </td>
            </tr>
            <tr>
              <td>AI</td>
              <td>
                <DocLink slug="security-policies" anchor="drafting">
                  Rule drafting
                </DocLink>{" "}
                from source, ABI, view methods, live state and recent receipts; breach explanations after the pause has landed.
              </td>
              <td>
                <RepoPath path="backend/src/ai" />
              </td>
            </tr>
            <tr>
              <td>Verify</td>
              <td>
                <DocLink slug="status-pages">Public status pages</DocLink>: every value links to the exact RPC request and response.
              </td>
              <td>
                <RepoPath path="backend/src/server/api.ts" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <H2 id="architecture">Architecture</H2>
      <p>
        Qorvex is an off-chain service plus a small on-chain footprint. It reads chain state freely, but its only power on-chain is a key that can ask
        the guardian contract to call <C>pause</C>.
      </p>
      <CodeBlock label="Architecture" code={ARCHITECTURE} copy={false} />
      <p>
        Rules flow from the operator into the rule store. The watcher streams every block and its receipts; a confirmed breach goes to the pause
        executor, then the guardian contract, then the protected contract. Relayers pull their budgets from the rule store and sign only what{" "}
        <C>check()</C> allows. See the <DocLink slug="security-model">security model</DocLink> for the trust boundaries.
      </p>

      <H2 id="why-near">Why it fits NEAR</H2>
      <ul>
        <li>
          <strong>Function-call access keys</strong> limit the watcher’s key to the guardian’s <C>pause</C> method. The protocol enforces this, so a
          stolen key can do nothing else.
        </li>
        <li>
          <strong>Asynchronous cross-contract calls</strong> mean a contract can’t check its real token balance inside a transaction. The solvency check
          therefore lives in the watcher, while the guard crate enforces limits and self-accounting from the contract’s own state.
        </li>
        <li>
          <strong>Sputnik DAO roles</strong> map onto “Qorvex can vote to reject, the council decides”.
        </li>
        <li>
          <strong>NEP-330 source metadata</strong> feeds the AI drafter, and NEP-141 and NEP-245 balance views feed the solvency rules.
        </li>
      </ul>

      <H2 id="next">Where to go next</H2>
      <ul className="doc-cards">
        {DOCS.filter((d) => d.slug).map((d) => (
          <li key={d.slug}>
            <Link to={docPath(d.slug)}>
              <strong>{d.title}</strong>
              <span>{d.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
