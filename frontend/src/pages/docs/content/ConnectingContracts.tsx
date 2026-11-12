import { CodeBlock } from "../../../components/CodeBlock";
import { C, Callout, DocLink, H2, H3, Lead } from "../prose";

export default function ConnectingContracts() {
  return (
    <>
      <Lead>
        Connecting takes a contract from <strong>connected</strong> to <strong>protected</strong>: Qorvex reads its source, drafts rules, you approve
        them, the owner authorises the guardian, and you publish a status page.
      </Lead>
      <p>
        Each step below is one call to the operator API, authenticated with the operator token. In the scripted sandbox demo, connecting to protected
        took about 5 seconds of API time, not counting human review.
      </p>
      <CodeBlock label="shell" code={'export QORVEX=http://localhost:8787\nexport TOKEN=<operator token>\nauth=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")'} />

      <H2 id="connect">1. Connect</H2>
      <p>
        Give the account ID and network (<C>mainnet</C>, <C>testnet</C> or <C>sandbox</C>). Qorvex checks that a contract is deployed, reads its NEP-330
        source metadata if present, and detects Sputnik DAOs from their <C>get_policy</C> view.
      </p>
      <CodeBlock label="shell" code={'curl -s "${auth[@]}" -X POST $QORVEX/api/protocols \\\n  -d \'{"network":"testnet","contractId":"ledger.you.testnet","name":"Ledger"}\''} />
      <p>
        The response contains the protocol (<C>protocol.id</C>, which the next calls use), the NEP-330 metadata, <C>needsUpload</C> and, for a DAO, its
        role names.
      </p>

      <H2 id="source">2. Provide the source</H2>
      <p>
        If <C>needsUpload</C> is true, the contract publishes no source link. Upload the source files (up to 50) so the drafter can read them:
      </p>
      <CodeBlock
        label="shell"
        code={'curl -s "${auth[@]}" -X POST $QORVEX/api/protocols/$ID/source \\\n  -d \'{"files":[{"path":"src/lib.rs","content":"..."}]}\''}
      />

      <H2 id="draft">3. Draft rules</H2>
      <p>
        The drafter collects the source, ABI, view methods, a few live state reads and recent receipts, then asks the model for rules. Each draft is
        validated and backtested before it is stored. See <DocLink slug="security-policies" anchor="drafting">AI drafting</DocLink>.
      </p>
      <CodeBlock label="shell" code={'curl -s "${auth[@]}" -X POST $QORVEX/api/protocols/$ID/draft'} />
      <Callout title="Replay mode">
        <p>
          With <C>QORVEX_AI_MODE=replay</C> (the default), drafting answers only from recorded responses. For a contract with no recording, the call
          returns HTTP 409 instead of inventing an answer. Set a <C>NEARAI_API_KEY</C> and <C>QORVEX_AI_MODE=live</C> to draft for new contracts, or{" "}
          <DocLink slug="security-policies" anchor="by-hand">write rules by hand</DocLink>.
        </p>
      </Callout>

      <H2 id="approve">4. Review and approve</H2>
      <p>
        Read the drafted rules with their live values and backtests, then approve each one with a response. Rejecting a draft keeps it out of
        evaluation.
      </p>
      <CodeBlock
        label="shell"
        code={`curl -s "\${auth[@]}" $QORVEX/api/protocols/$ID
curl -s "\${auth[@]}" -X POST $QORVEX/api/protocols/$ID/rules/solvency-usdc/approve \\
  -d '{"response":"pause","approvedBy":"alice"}'`}
      />
      <ul>
        <li>
          <C>pause</C> is accepted only for solvency and outflow-rate rules whose backtest fired zero times. A rule that fired can be approved as{" "}
          <C>alert</C> only.
        </li>
        <li>
          <C>reject</C> is only for <C>proposal_policy</C> rules on DAOs.
        </li>
        <li>Editing an approved rule sends it back to draft: it needs approval again.</li>
      </ul>

      <H2 id="authorise">5. Authorise the guardian</H2>
      <p>
        Rules that pause need the contract to accept <C>pause()</C> from the Qorvex guardian. Ask Qorvex for the exact transaction:
      </p>
      <CodeBlock label="shell" code={'curl -s "${auth[@]}" $QORVEX/api/protocols/$ID/guardian'} />
      <p>
        It returns a single <C>set_guardian</C> call with 1 yoctoNEAR attached, and the matching near-cli-rs command. The contract owner signs it. In
        the same transaction, the contract registers itself with the guardian (attaching 0.01 NEAR for storage), naming its owner as council. Then
        verify:
      </p>
      <CodeBlock label="shell" code={'curl -s "${auth[@]}" -X POST $QORVEX/api/protocols/$ID/guardian/verify'} />
      <p>
        Verification reads back the contract’s <C>guard_status</C>, the guardian registration, whether the watcher is approved, and the watcher key’s
        scope (<C>receiver_id</C> = guardian, <C>method_names</C> = <C>["pause"]</C>). When the guardian is set and registered, the protocol becomes{" "}
        <strong>protected</strong>.
      </p>
      <Callout tone="warn" title="Wallet signing">
        <p>
          In-browser wallet signing is not wired up. Sign the transaction with near-cli-rs or your usual wallet. On the local sandbox,{" "}
          <C>POST …/guardian/sign-demo</C> signs with the demo owner key.
        </p>
      </Callout>

      <H2 id="publish">6. Publish the status page</H2>
      <CodeBlock label="shell" code={'curl -s "${auth[@]}" -X POST $QORVEX/api/protocols/$ID/publish -d \'{"published":true}\''} />
      <p>
        The response gives the page path, <C>/status/&lt;id&gt;</C>. See <DocLink slug="status-pages">Public status pages</DocLink>.
      </p>

      <H2 id="daos">Sputnik DAOs: the proposal firewall</H2>
      <p>
        A connected DAO gets the proposal firewall instead of a pause. The DAO adds a role whose only permissions are <C>transfer:VoteReject</C> and{" "}
        <C>call:VoteReject</C>, with Qorvex’s firewall account as its only member and a threshold of one vote. Sputnik counts votes per role, so one
        firewall vote rejects a proposal, and the role can never approve.
      </p>
      <CodeBlock
        label="shell"
        code={`curl -s "\${auth[@]}" $QORVEX/api/protocols/$ID/firewall          # the add_proposal transaction
curl -s "\${auth[@]}" -X POST $QORVEX/api/protocols/$ID/firewall/verify`}
      />
      <ol>
        <li>
          A council member submits the returned <C>ChangePolicyAddOrUpdateRole</C> proposal, and the DAO approves it.
        </li>
        <li>
          Verify: Qorvex reads the policy back and checks that the firewall key is limited to <C>act_proposal</C> on this DAO.
        </li>
        <li>
          Approve the DAO’s <C>proposal_policy</C> rule with <C>{'"response":"reject"'}</C>.
        </li>
      </ol>
      <p>The DAO removes the role the same way it added it: with a policy proposal.</p>

      <H2 id="unofficial">Read-only pages for contracts you don’t control</H2>
      <p>
        Connect with <C>{'"unofficial": true'}</C> to watch a public contract without any key. Unofficial protocols have no guardian, accept only
        alert-only rules, and their status pages are marked unofficial. <C>npm run seed:intents</C> does this for NEAR Intents.
      </p>

      <H2 id="network-config">Network configuration</H2>
      <H3>Per network (NET = TESTNET, MAINNET or SANDBOX)</H3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <C>QORVEX_&lt;NET&gt;_GUARDIAN</C>
              </td>
              <td>Account of the guardian contract.</td>
            </tr>
            <tr>
              <td>
                <C>QORVEX_&lt;NET&gt;_WATCHER_ACCOUNT</C>
              </td>
              <td>Watcher account approved on the guardian.</td>
            </tr>
            <tr>
              <td>
                <C>QORVEX_&lt;NET&gt;_WATCHER_KEY</C>
              </td>
              <td>
                The watcher’s function-call key: receiver = guardian, methods = <C>["pause"]</C>.
              </td>
            </tr>
            <tr>
              <td>
                <C>QORVEX_&lt;NET&gt;_FIREWALL_ACCOUNT</C>
              </td>
              <td>Reject-only member of protected DAOs.</td>
            </tr>
            <tr>
              <td>
                <C>QORVEX_&lt;NET&gt;_FIREWALL_KEYS</C>
              </td>
              <td>
                JSON map of DAO to key; one function-call key per DAO, <C>act_proposal</C> only.
              </td>
            </tr>
            <tr>
              <td>
                <C>QORVEX_&lt;NET&gt;_RPC_URLS</C>, <C>QORVEX_&lt;NET&gt;_STREAM</C>
              </td>
              <td>
                RPC providers, and the block source (<C>neardata</C> or <C>rpc</C>).
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
