# Qorvex

Spending limits and circuit breakers for NEAR contracts, DAO treasuries and gas relayers. An open-weight Qwen model on NEAR AI Cloud (`qwen/qwen3.5-397b-a17b`, served in a TEE) drafts the rules and a human approves each one. Deterministic code checks them on every block. When a contract's books stop adding up, a pause-only key pauses it through an on-chain guardian contract.

Built for NEAR HACKATHON (Nov 2026). Tracks: `security` (primary), `defi`, `social`.

## The problem

Two NEAR products lost money in autumn 2026 in ways a basic invariant or spend cap would have caught:

| When | Incident | What a check would have done |
| --- | --- | --- |
| Sep 29 to Oct 1 | [NEAR Intents ghost balances](https://thecoding.substack.com/p/near-intents-ghost-fund-postmortem). A deposit whose notification failed was refunded but stayed credited. This created $3.8M of unbacked balances, which were withdrawn over ~40 hours before anyone noticed. | The solvency rule `owed <= held` fails on the first ghost credit. |
| Oct 19 | [Trezu sponsor relayer drained twice](https://github.com/NEAR-DevHub/trezu/issues/1871). The relayer paid for up to 200 `storage_deposit` calls per proposal into an attacker's token contract. | A per-beneficiary budget refuses the calls before the relayer signs. |

NEAR cross-contract calls are asynchronous, so a contract cannot check its real token balance inside a transaction. A full solvency check needs an outside watcher. Before this project, every team had to build one itself.

## What Qorvex does

| Layer | Component | Where |
| --- | --- | --- |
| Prevent | `qorvex-guard` Rust crate: per-token per-window outflow caps, plus a **self-accounting check that pauses the contract in the same transaction** | [contracts/qorvex-guard](contracts/qorvex-guard/src/lib.rs) |
| Prevent | Relayer SDK `check(beneficiary, action, cost)` with budgets pulled from the console | [src/relayer/sdk.ts](src/relayer/sdk.ts) |
| Detect and stop | Watcher that streams blocks (neardata.xyz, or RPC on the sandbox), evaluates rules on every receipt touching a protected contract, confirms with a direct read, then pauses | [src/watcher/watcher.ts](src/watcher/watcher.ts) |
| Detect and stop | Guardian contract: the only thing Qorvex's key can call. It records each pause on-chain (rule, evidence hash, watcher) and forwards `pause()` | [contracts/guardian](contracts/guardian/src/lib.rs) |
| AI | Drafts rules with `qwen/qwen3.5-397b-a17b` on NEAR AI Cloud, from source, ABI, methods, live state and recent receipts. Every draft is validated and backtested before a human sees it. Explains breaches with `Qwen/Qwen3.6-35B-A3B-FP8` after the pause lands. Both are open-weight and set by one environment variable each. | [src/ai](src/ai) |
| Verify | Public status page. Every number links to the exact RPC request and raw response, with a `curl` to reproduce it. | [web/status.js](web/status.js) |

## Try it (no keys, no testnet funds)

Requirements: Node.js 22 or newer (tested on 24.21), Linux or macOS on x86_64/arm64, about 1 GB of free RAM. Rust is **not** needed: the built contracts are committed in [contracts/wasm](contracts/wasm). The first run downloads the official nearcore sandbox binary (~90 MB) through near-kit.

1. **Install:** `npm ci`
2. **Run the whole demo script:** `npm run demo -- --auto --exit`. It takes about 3 minutes and prints a summary. You should see:
   - `Demo ledger: approved solvency-usdc as pause (backtest: 0 fires over 24 samples)`, and `guardian verified=true ... watcher key scope ok=true`.
   - `Replay: NEAR Intents ghost-balance bug on the ledger`, then `watcher: breach at block N, ledger paused at block N+4 = 4 blocks later, ~3 s after detection`. Then `attacker withdraw of the ghost balance: rejected (qorvex-guard: contract is paused ...)`.
   - `vault paused in the deposit transaction itself (...): self-accounting: credited 290000000000 > backing 250000000000`.
   - `without Qorvex: sponsored 100, sponsor balance 0.6 NEAR -> 0.40575 NEAR`, then `with Qorvex check(): sponsored 8, refused 92 ...`, and `first refusal: spend cap: ...`.
   - `Guardian on-chain pause history ...` with `"rule_id":"solvency-usdc"` and `"status":"Paused"`.
3. **Explore in the browser:** `npm run demo` (without `--auto`). Open `http://localhost:8787/` and paste the operator token it prints.
   1. **Connect a contract.** Choose `sandbox`, enter `ledger.test.near`, click Connect. You should see "No NEP-330 source link: upload the source".
   2. **Upload the source.** Choose `contracts/demo-ledger/src/lib.rs`, click Upload.
   3. **Draft rules.** Click "Draft rules with NEAR AI". Without `NEARAI_API_KEY` and without a recorded response you get a clear error, not an invented draft (see "AI and recorded responses" below). Use "Write a rule by hand" instead: set the token to `usdc.test.near` and the account to `ledger.test.near`. The rule is validated, its views are called, and a backtest runs.
   4. **Review the rule.** It shows a live value (`owed ... · held ... · margin ...`) and its backtest (`would have fired 0 times over 24 samples`).
   5. **Approve it.** Choose "alert and pause", click Approve. "Alert and pause" is disabled for any rule whose backtest fired.
   6. **Authorise the guardian.** Under "Authorise the guardian" you see the exact transaction and a near-cli-rs command. Click "Sign with the sandbox owner key (local demo only)", then "Read back and verify". You should see `"ok": true` and `"watcherKeyPermission": {"FunctionCall": {"receiver_id": "guardian.test.near", "method_names": ["pause"], ...}}`.
   7. **Publish and open the status page.** Click "Publish status page", then the link. Click any number: the evidence page shows the JSON-RPC request, the raw response and a `curl` that returns the same bytes.
   8. **Replay the Intents bug.** In "Local demo", click "Ghost-balance bug → ledger". Within a few seconds the status page turns red ("Paused at block N"). The incident shows "Qorvex: breach to pause 4 blocks" next to "NEAR Intents: ~40 hours", and the on-chain pause history gets a row.
   9. **Replay the Trezu drain.** Click "Trezu drain, with check()", then open the relayer under "Relayers". The decision log shows 8 `allow` and 92 `deny`, each with its reason. Edit the budgets JSON and save it: the SDK picks up the change within its cache TTL.
4. **Run the tests:**
   - `npm test`: 30 unit tests and 10 end-to-end tests on a real local sandbox (~2 min).
   - `cd contracts && cargo test`: 28 contract unit tests.
5. **Watch mainnet NEAR Intents, read-only:** `QORVEX_NETWORKS=mainnet npm start`, then in another shell `QORVEX_ADMIN_TOKEN=<token printed by the server> npm run seed:intents`. The seed adds three solvency rules on `intents.near`: owed is `mt_supply("nep141:<token>")` and held is `<token>.ft_balance_of("intents.near")`, for USDC, USDT and wNEAR. Each is backtested against 30 days of archival state, approved alert-only and published at `/status/<id>`. The public `archival-rpc.mainnet.near.org` rate-limits heavily (HTTP 429), so the first backtest can take an hour or stall. It resumes from the cache on rerun, or set `QORVEX_MAINNET_ARCHIVAL_RPC` to a paid archival endpoint. Live values were checked on 2026-11-10: owed ≤ held held for all three tokens. The page is marked unofficial, and Qorvex holds no key for `intents.near`.

## How it works

```
                 console (operator)                       status page (anyone)
                        │ approve rules                          ▲ raw reads + curl
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
                                          protected contract (qorvex-guard: accepts pause only from guardian)
```

**Trust model**

- **The only key Qorvex holds:** a function-call access key on the watcher account, with `receiver_id = guardian` and `method_names = ["pause"]`. It cannot attach deposits. The demo and the e2e tests check that this key cannot call `set_watchers`, `register_target` or `unpause`.
- **The guardian's limits:** it has no unpause, no limit setting and no transfer method. Only the owner, with 1 yoctoNEAR attached, can change the watcher list (G2), so a function-call key cannot do it. It allows at most one automatic pause per target per hour unless the target's council allows another (G4). Every pause is public through `pause_history(target)` (G3).
- **The protected contract's controls:** it accepts `pause` only from the guardian. Unpausing and setting limits need the owner and 1 yoctoNEAR.
- **What the AI does:** it only drafts rules and explains breaches. Rules start as `draft` with response `alert` and need a human to approve them. The pause decision is made by [src/rules/evaluate.ts](src/rules/evaluate.ts) and [src/watcher/watcher.ts](src/watcher/watcher.ts), with no model call on that path.
- **If Qorvex goes down:** in-contract limits and the self-accounting check keep working.

**Self-accounting (P3) and async deposits.** The guard counts deposits as *pending* until the deposit callback settles them, and credits users against `pending + confirmed - out`. A legitimate async deposit therefore never trips it. In the Intents pattern, a credit survives its own refund. That breaks `credited <= backing` in the settling callback, and the guard pauses there. It returns normally instead of panicking, so the pause is not rolled back.

**Demo contracts.** [demo-ledger](contracts/demo-ledger/src/lib.rs) is deliberately vulnerable: it carries the "refund after credit" bug. It is deployed twice: `ledger` with self-accounting off (the watcher catches the bug) and `vault` with self-accounting on (the vault pauses itself). [demo-token](contracts/demo-token/src/lib.rs) is a standard NEP-141 token built on near-contract-standards.

## Measured results (local sandbox, nearcore 2.13.4)

| Metric | PRD target | Measured |
| --- | --- | --- |
| Self-accounting breach to pause | same transaction | Same transaction: the pause is in a receipt of the ghost-deposit transaction (asserted in e2e) |
| Watcher breach to pause | within 3 blocks | **4 blocks, ~3 s.** Breakdown from the breach timeline: the block reaches the watcher 0.74 s after it is produced (RPC polling), evaluation + confirmation + signing take ~9 ms, and the transaction lands one block later than ideal. That gives tx at N+2, guardian receipt at N+3, target pause at N+4. Three blocks needs a node-local indexer (NEAR Indexer framework) instead of polling. |
| Setup time | under 15 min | Connected to protected in ~4 s of API time in the scripted demo (human review time not included) |
| Replayed incidents caught | 2 | 2: Intents ghost balance (both layers) and the Trezu sponsor drain |
| False alarms, 30-day mainnet Intents backtest | 0 | **Not measured yet.** The rules and the seed script work, but the public archival node (`archival-rpc.mainnet.near.org`) answered HTTP 429 to every request after the first ~30 reads in this session. Backtest samples sit on a fixed block grid and every archival read is cached, so `npm run seed:intents` resumes where it stopped. A paid archival endpoint (`QORVEX_MAINNET_ARCHIVAL_RPC`) removes the limit. |

## Configuration

Every setting is in [.env.example](.env.example). Secrets are read from the environment only; `.env` and `data/` are git-ignored. The main ones:

- `QORVEX_ADMIN_TOKEN`: operator API and console token.
- `QORVEX_<NET>_GUARDIAN`, `QORVEX_<NET>_WATCHER_ACCOUNT`, `QORVEX_<NET>_WATCHER_KEY`: per network. `QORVEX_<NET>_WATCHER_KEY` must be the pause-only function-call key.
- `NEARAI_API_KEY`, `QORVEX_AI_MODE` (`replay` | `live` | `record`), `QORVEX_DRAFT_MODEL`, `QORVEX_EXPLAIN_MODEL`.
- `FASTNEAR_API_KEY`: optional, raises neardata.xyz rate limits for the block stream.
- Alerts: `TELEGRAM_BOT_TOKEN` with `TELEGRAM_CHAT_ID`, and `QORVEX_WEBHOOK_URL` with `QORVEX_WEBHOOK_SECRET` (HMAC-SHA256 in `x-qorvex-signature`).

## Deploying to testnet

1. **Fund an account.** Fund a testnet account with ~18 NEAR from the [faucet](https://docs.near.org/getting-started/faucet). Put `TESTNET_ACCOUNT_ID` and `TESTNET_PRIVATE_KEY` in `.env`.
2. **Dry run.** `npm run deploy:testnet` prints the plan and changes nothing.
3. **Deploy.** `npm run deploy:testnet -- --yes` creates the accounts, deploys the guardian, token and both ledgers, adds the pause-only key, and authorises the guardian on both ledgers. It prints the three `QORVEX_TESTNET_*` lines for `.env`.
4. **Start watching.** `QORVEX_NETWORKS=testnet npm start`. The testnet watcher streams optimistic blocks from `testnet.neardata.xyz`.
5. **Rebuilding contracts** needs Rust and `cargo install --locked cargo-near`, then `npm run build:contracts`.

## AI and recorded responses (A1, A2, A9)

- **Models:** inference runs on NEAR AI Cloud (`https://cloud-api.near.ai/v1`) at temperature 0, with open-weight Qwen models that the live catalog marks verifiable (served in TEEs). Drafting uses `qwen/qwen3.5-397b-a17b`, the largest Qwen there (128k context, enough for source + ABI). Explanations use `Qwen/Qwen3.6-35B-A3B-FP8`, a small, fast MoE. The PRD's example IDs (Qwen3.5-122B-A10B, Qwen3-30B-A3B-Instruct) are not in the catalog (checked 2026-11-10 at `/v1/model/list`). Each model is one environment variable (`QORVEX_DRAFT_MODEL`, `QORVEX_EXPLAIN_MODEL`); `z-ai/glm-5.3` is a drop-in open-weight alternative for drafting.
- **Replay mode** (the default) answers only from fixtures in [fixtures/ai](fixtures/ai). A missing fixture is an error, never a made-up answer. The demo then adds the same rules by hand and says so in its output.
- **Recording fixtures:** set `NEARAI_API_KEY` and run `QORVEX_AI_MODE=record npm run demo -- --auto --exit`. Fixtures are keyed by job, model, contract, code hash, source digest and attempt.
- **Attestation (A8):** with a live key, each drafting run stores the model's TEE attestation report (`/v1/attestation/report`) and the chat signature. The console then shows a "drafted in an attested enclave" badge. Qorvex stores the report but does not itself verify the NVIDIA NRAS / Intel TDX chain.

## Requirement coverage

| ID | Status |
| --- | --- |
| P1, P2, P3 | Done: crate with unit tests, used by the demo ledger, e2e on the sandbox |
| P4, P5 | Done: SDK with serialized checks, console-edited budgets, local cache, fail open/closed, decision log, alert on repeated refusals |
| D1 | Done: neardata.xyz block stream (testnet, mainnet), RPC block+chunk following (sandbox). Only receipts that touch a protected account trigger evaluation. |
| D2 | Solvency and outflow-rate done. Sponsor spend is covered by relayer budgets. Treasury-transfer policy: not built. |
| D3, D4, D5, D6 | Done. Telegram and webhook implemented; webhook is tested, Telegram has not been tested against the live API. Phone push and PagerDuty not built. |
| G1, G2, G3, G4 | Done, unit and e2e tested |
| A1 to A6 | Done. The full pipeline is tested with recorded/stub model output; **no live NEAR AI call has been made yet** (no API key in this environment). |
| A7 | Done; runs after the pause lands |
| A8 | Stored and shown; not independently verified |
| A9 | Mechanism done. **Fixtures still need recording with an API key.** |
| S1, S2 | Done |
| S3, L1, L2 | Not built (future work) |

## Known limitations

- **Pause latency:** the watcher takes 4 blocks on the sandbox, against the 3-block target (see above). Testnet has not been measured yet.
- **One process:** the store is JSON files and the relayer SDK keeps spend history per process. Run one watcher and one SDK instance per relayer, or move both to a shared database.
- **Sampled backtests:** solvency backtests sample block heights, not every block. Outflow backtests replay only recent blocks.
- **Wallet signing:** the console shows the guardian-authorisation transaction and a near-cli-rs command. In-browser wallet signing (near-connect) is not wired up; the sandbox demo signs with the demo owner key.
- **Free neardata.xyz tier:** it rate-limits full mainnet block documents (observed HTTP 429). The stream backs off, and a 30-second heartbeat keeps read-only pages evaluated. For per-block mainnet streaming, set `FASTNEAR_API_KEY`, switch to `QORVEX_<NET>_STREAM=rpc` (block + chunk following over the RPC list), or run a NEAR Indexer node.
- **Pause-state check:** it reads an `is_paused` view. Contracts without one are assumed not paused.
- **The demo ledger is vulnerable on purpose:** never deploy it with real funds.

## Libraries, prior work and AI use (Q-005)

- **Started in the hackathon window:** all code was written from scratch on 2026-11-10. There is no pre-hackathon baseline.
- **Libraries:** near-sdk 5.29 and near-contract-standards (Rust), near-kit 0.20.2 (TypeScript signing and sandbox), vitest, tsx, TypeScript. No other runtime dependencies: the HTTP server, RPC client, rule engine and UI are plain Node.js and browser JavaScript.
- **AI code:** the code was written with an AI coding assistant (Claude Code) from the team's PRD, and reviewed and tested as described above.

## License

MIT, see [LICENSE](LICENSE).
