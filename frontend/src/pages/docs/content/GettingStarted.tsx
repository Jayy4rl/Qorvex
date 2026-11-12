import { Link } from "react-router";
import { CodeBlock } from "../../../components/CodeBlock";
import { C, Callout, DocLink, H2, Lead, RepoPath } from "../prose";

export default function GettingStarted() {
  return (
    <>
      <Lead>
        Run Qorvex on your machine against a local NEAR sandbox. No keys, no testnet funds and no AI API key are needed: the demo uses recorded model
        responses.
      </Lead>

      <H2 id="requirements">Requirements</H2>
      <ul>
        <li>Node.js 22 or newer.</li>
        <li>Linux or macOS on x86_64 or arm64, with about 1 GB of free RAM.</li>
        <li>
          Rust is <strong>not</strong> needed: the built contracts are committed in <RepoPath path="contracts/wasm" />. The first run downloads the
          official nearcore sandbox binary (about 90 MB).
        </li>
      </ul>

      <H2 id="install">Install</H2>
      <p>From the repository root:</p>
      <CodeBlock label="shell" code="npm ci" />

      <H2 id="scripted-demo">Run the scripted demo</H2>
      <p>
        The scripted demo starts a sandbox, deploys the guardian and the demo contracts, connects them to Qorvex, drafts and approves rules, then
        replays two real incidents. It takes about three minutes and prints a summary. The first run also builds this web app.
      </p>
      <CodeBlock label="shell" code="npm run demo -- --auto --exit" />
      <p>In the output you should see, among other lines:</p>
      <CodeBlock
        label="expected output (excerpt)"
        copy={false}
        code={`Demo ledger: approved solvency-usdc as pause (backtest: 0 fires over 25 samples)
Replay: NEAR Intents ghost-balance bug on the ledger (deposit with a failing notification)
  watcher: breach at block 168, ledger paused at block 172 = 4 blocks later, 3.0 s after detection
  attacker withdraw of the ghost balance: rejected (qorvex-guard: contract is paused ...)
Replay: same bug against the vault (qorvex-guard self-accounting on)
  vault paused in the deposit transaction itself (...)
  with Qorvex check(): sponsored 8, refused 92, sponsor balance 0.6 NEAR -> 0.50347 NEAR
Qorvex holds one key: function-call, receiver guardian.test.near, methods ["pause"].`}
      />
      <p>
        Block numbers and transaction hashes differ between runs. The summary is also written to <C>data/demo/summary.txt</C>.
      </p>

      <H2 id="sign-in">Run the server and sign in</H2>
      <p>Without flags, the demo keeps running after setup so you can use the API and the web app:</p>
      <CodeBlock label="shell" code="npm run demo" />
      <p>It prints the server address and the operator token:</p>
      <CodeBlock label="output" copy={false} code={"Qorvex console:   http://localhost:8787/          (operator token: <token>)"} />
      <p>
        Open <C>http://localhost:8787/</C>, choose <Link to="/sign-in">Sign in</Link> and paste the token. Qorvex has no user accounts: there is one
        operator credential per server, <C>QORVEX_ADMIN_TOKEN</C>. If you don’t set it, the server generates a new one on each start.
      </p>
      <Callout tone="warn" title="Console status">
        <p>
          The operator console interface is being rebuilt. Signing in checks your token against the server. Until the console returns, every operator
          action is available through the HTTP API described in <DocLink slug="connecting-contracts">Connecting contracts</DocLink>.
        </p>
      </Callout>

      <H2 id="own-networks">Watch testnet or mainnet</H2>
      <p>
        <C>npm start</C> runs the service without the demo world. Choose networks with <C>QORVEX_NETWORKS</C> and configure each network’s guardian
        and watcher key in <C>.env</C> (see <RepoPath path=".env.example" />
        ).
      </p>
      <CodeBlock label="shell" code={"cp .env.example .env\nQORVEX_NETWORKS=testnet npm start"} />
      <p>
        To deploy the guardian and demo contracts to testnet yourself, fund a testnet account with about 18 NEAR, set <C>TESTNET_ACCOUNT_ID</C> and{" "}
        <C>TESTNET_PRIVATE_KEY</C>, then run <C>npm run deploy:testnet</C> for a dry run and <C>npm run deploy:testnet -- --yes</C> to deploy. It prints
        the <C>QORVEX_TESTNET_*</C> lines for <C>.env</C>.
      </p>
      <p>
        To watch mainnet NEAR Intents read-only, run <C>QORVEX_NETWORKS=mainnet npm start</C>, then in another shell{" "}
        <C>QORVEX_ADMIN_TOKEN=&lt;token&gt; npm run seed:intents</C>. This adds alert-only solvency rules for USDC, USDT and wNEAR on{" "}
        <C>intents.near</C> and publishes an unofficial status page. Qorvex holds no key for <C>intents.near</C>.
      </p>

      <H2 id="develop">Work on the web app</H2>
      <p>
        With the backend running on port 8787, start the Vite dev server. It proxies <C>/api</C> to the backend (override with <C>QORVEX_API</C>).
      </p>
      <CodeBlock label="shell" code={"npm run dev:web\n# open http://localhost:5173/"} />

      <H2 id="checks">Run the tests and checks</H2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Command</th>
              <th>What it runs</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <C>npm run check</C>
              </td>
              <td>Type-checks every workspace, runs the unit tests and builds the web app.</td>
            </tr>
            <tr>
              <td>
                <C>npm test</C>
              </td>
              <td>Backend unit tests plus end-to-end tests on a real local sandbox (about 4 minutes).</td>
            </tr>
            <tr>
              <td>
                <C>npm run test:contracts</C>
              </td>
              <td>Contract unit tests (needs Rust).</td>
            </tr>
          </tbody>
        </table>
      </div>

      <H2 id="next">Next steps</H2>
      <ul>
        <li>
          <DocLink slug="connecting-contracts">Connect a contract</DocLink> and take it from connected to protected.
        </li>
        <li>
          Learn the <DocLink slug="security-policies">rule types and responses</DocLink>.
        </li>
        <li>
          Read the <DocLink slug="security-model">security model</DocLink> before you grant any permission.
        </li>
      </ul>
    </>
  );
}
