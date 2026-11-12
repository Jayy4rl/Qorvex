import { CodeBlock } from "../../../components/CodeBlock";
import { INTENTS_READ_CURL } from "../../landing/demo-run";
import { C, Callout, DocLink, H2, Lead } from "../prose";

export default function StatusPages() {
  return (
    <>
      <Lead>
        A status page lets anyone check a protocol’s health without trusting Qorvex. Every value links to the exact RPC request and response that
        produced it, with a curl command to reproduce it.
      </Lead>

      <H2 id="contents">What a page shows</H2>
      <ul>
        <li>Each approved check, its plain-English sentence and its response (alert, pause or reject).</li>
        <li>
          Live values (for solvency: owed, held and margin) and the block at which the check last passed.
        </li>
        <li>
          Whether the contract is paused, read from its <C>is_paused</C> view, and the guardian’s on-chain <C>pause_history</C>.
        </li>
        <li>Recent breaches with their evidence, and for DAOs, recent proposals with the firewall’s decisions.</li>
        <li>
          For contracts using <DocLink slug="contract-guard">qorvex-guard</DocLink>, its <C>guard_status</C>: limits, window usage and self-accounting
          tallies.
        </li>
        <li>
          A scope statement: checks run in an outside watcher on every block that touches the contract, and a drain completed inside a single
          transaction is out of the watcher’s reach. Only the listed checks are monitored.
        </li>
      </ul>

      <H2 id="publish">Publishing</H2>
      <p>
        Pages are off until you publish them. See <DocLink slug="connecting-contracts" anchor="publish">Publish the status page</DocLink>; send{" "}
        <C>{'{"published": false}'}</C> to take a page down.
      </p>

      <H2 id="api">Public endpoints</H2>
      <p>These endpoints need no token.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Returns</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <C>GET /api/public/protocols</C>
              </td>
              <td>Published protocols: ID, name, network, contract and whether the page is unofficial.</td>
            </tr>
            <tr>
              <td>
                <C>GET /api/status/&lt;id&gt;</C>
              </td>
              <td>The full status view of a published protocol.</td>
            </tr>
            <tr>
              <td>
                <C>GET /api/reads/&lt;readId&gt;</C>
              </td>
              <td>One raw read: provider, request, response and the curl command.</td>
            </tr>
            <tr>
              <td>
                <C>GET /api/events</C>
              </td>
              <td>Server-sent events. Without a token, only events about published protocols.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Callout title="Web view">
        <p>
          The backend returns <C>/status/&lt;id&gt;</C> as each page’s address. The web view for that route is part of the console rebuild; the JSON
          endpoints above are available now.
        </p>
      </Callout>

      <H2 id="verify">Verifying a value yourself</H2>
      <p>
        Every read is a standard NEAR RPC <C>query</C> with <C>request_type: call_function</C>. Arguments are base64-encoded JSON. This read is the
        owed side of the read-only NEAR Intents USDC check, and works from any terminal:
      </p>
      <CodeBlock label="shell" code={INTENTS_READ_CURL} />
      <p>
        Decode <C>result.result</C> (an array of bytes) as UTF-8 JSON to get the amount. Compare it with the value on the page at the same block
        height, which is in the response as <C>result.block_height</C>.
      </p>

      <H2 id="unofficial">Unofficial pages</H2>
      <p>
        Qorvex can publish read-only pages for public protocols it has no relationship with, built only from public data. They are marked unofficial,
        use alert-only rules, and Qorvex holds no key for the contract. The NEAR Intents page created by <C>npm run seed:intents</C> is one.
      </p>
    </>
  );
}
