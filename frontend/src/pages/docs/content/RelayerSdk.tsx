import { CodeBlock } from "../../../components/CodeBlock";
import { C, Callout, H2, Lead, RepoPath } from "../prose";

const CREATE = `curl -s "\${auth[@]}" -X POST $QORVEX/api/relayers -d '{"name":"sponsor","failMode":"closed"}'
# → { "relayer": { "id": "rly_…", … }, "token": "qrx_…", "note": "The token is shown once. …" }`;

const BUDGETS = `curl -s "\${auth[@]}" -X PUT $QORVEX/api/relayers/$RELAYER/budgets -d '{
  "failMode": "closed",
  "budgets": [
    {
      "beneficiary": "*",
      "window_sec": 3600,
      "max_cost_yocto": "20000000000000000000000",
      "max_count": { "storage_deposit": 10 }
    }
  ]
}'`;

const USE = `import { QorvexRelayerGuard } from "./qorvex/relayer/sdk";

const guard = new QorvexRelayerGuard({
  relayerId: process.env.QORVEX_RELAYER_ID!,
  apiUrl: "https://qorvex.example.org",
  apiToken: process.env.QORVEX_RELAYER_TOKEN,
});

// Before signing each sponsored action:
const d = await guard.check(treasuryId, "storage_deposit", costYocto, { receiver: tokenId });
if (!d.allow) return refuse(d.reason);
await signAndSend();`;

const PROPOSAL = `const d = await guard.checkProposal(daoId, proposal);
if (!d.allow) return refuse(d.reason);
// e.g. "proposal #1: calls capture.mallory.test.near, which is not on the
//       allowed contracts list; 50 actions in one proposal (max 20)"`;

export default function RelayerSdk() {
  return (
    <>
      <Lead>
        The relayer SDK stops a gas sponsor from paying for abuse. Before the relayer signs, <C>check()</C> returns allow or deny with a reason, based
        on budgets you manage in Qorvex.
      </Lead>
      <p>
        It needs no contract changes. In the sandbox replay of the Trezu drain, 100 sponsored <C>storage_deposit</C> calls into an attacker’s token
        took the sponsor from 0.6 to 0.40575 NEAR. With <C>check()</C>, 8 were sponsored and 92 refused, and the balance stopped at 0.50347 NEAR.
      </p>

      <H2 id="create">1. Create a relayer</H2>
      <p>The response includes the relayer’s API token. It is shown once; put it in the relayer’s environment as <C>QORVEX_RELAYER_TOKEN</C>.</p>
      <CodeBlock label="shell" code={CREATE} />

      <H2 id="budgets">2. Set budgets</H2>
      <p>A budget applies to one beneficiary account, or to all with <C>"*"</C>, over a window:</p>
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
                <C>beneficiary</C>
              </td>
              <td>
                Account ID, or <C>"*"</C>.
              </td>
            </tr>
            <tr>
              <td>
                <C>window_sec</C>
              </td>
              <td>Window length in seconds.</td>
            </tr>
            <tr>
              <td>
                <C>max_cost_yocto</C>
              </td>
              <td>Maximum sponsored cost per window, in yoctoNEAR.</td>
            </tr>
            <tr>
              <td>
                <C>max_count</C>
              </td>
              <td>
                Maximum number of each action per window, e.g. <C>{'{"storage_deposit": 10}'}</C>.
              </td>
            </tr>
            <tr>
              <td>
                <C>allowed_receivers</C>
              </td>
              <td>If set, the action’s receiver must be in this list.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <CodeBlock label="shell" code={BUDGETS} />
      <p>
        The same call takes an optional <C>proposalPolicy</C> (the <C>proposal_policy</C> fields) for <C>checkProposal()</C>, and the fail mode.
      </p>

      <H2 id="check">3. Check before signing</H2>
      <p>
        The SDK is TypeScript, in <RepoPath path="backend/src/relayer/sdk.ts" />. It isn’t published to npm yet: import it from a checkout of the repository, or vendor it together with{" "}
        <RepoPath path="backend/src/relayer/budgets.ts" />, <RepoPath path="backend/src/firewall/policy.ts" /> and the type-only{" "}
        <RepoPath path="shared/src/index.ts" />. It runs on Node.js 22 or newer.
      </p>
      <CodeBlock label="relayer.ts" code={USE} />
      <ul>
        <li>Checks are serialised, so two concurrent requests can’t both squeeze under a cap.</li>
        <li>
          Each decision has an ID, the beneficiary, action, cost, receiver, <C>allow</C>, a human-readable <C>reason</C> and its <C>basis</C> (
          <C>budget</C>, <C>no-budget</C>, <C>proposal-policy</C>, <C>fail-open</C> or <C>fail-closed</C>).
        </li>
      </ul>

      <H2 id="proposals">Checking DAO proposals</H2>
      <p>
        When a relayer sponsors DAO approval votes, the attacker may own the DAO, so a DAO-side firewall can’t help. <C>checkProposal()</C> applies
        your proposal policy before you relay the approval:
      </p>
      <CodeBlock label="relayer.ts" code={PROPOSAL} />

      <H2 id="fail-modes">Caching and fail modes</H2>
      <p>
        Budgets are pulled from Qorvex and cached locally. If Qorvex is unreachable, the last cached budgets keep working. With no budgets at all, the
        SDK fails <C>closed</C> (refuse, the default) or <C>open</C> (allow), as you configured.
      </p>

      <H2 id="decisions">Decision log and alerts</H2>
      <p>
        Every decision is kept locally and shipped to Qorvex in batches (about once a second). Operators read the log at{" "}
        <C>GET /api/relayers/&lt;id&gt;/admin</C>. Repeated refusals trigger an alert through the configured channels.
      </p>
      <Callout tone="warn" title="One process per relayer">
        <p>
          Spend history lives in the SDK’s process. Run one SDK instance per relayer, or put the relayer behind a single signer. A shared store is
          future work.
        </p>
      </Callout>
    </>
  );
}
