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
| Prevent | Relayer SDK `check(beneficiary, action, cost)` with budgets pulled from the console | [backend/src/relayer/sdk.ts](backend/src/relayer/sdk.ts) |
| Detect and stop | Watcher that streams blocks (neardata.xyz, or RPC on the sandbox), evaluates rules on every receipt touching a protected contract, confirms with a direct read, then pauses | [backend/src/watcher/watcher.ts](backend/src/watcher/watcher.ts) |
| Detect and stop | Guardian contract: the only thing Qorvex's key can call. It records each pause on-chain (rule, evidence hash, watcher) and forwards `pause()` | [contracts/guardian](contracts/guardian/src/lib.rs) |
| AI | Drafts rules with `qwen/qwen3.5-397b-a17b` on NEAR AI Cloud, from source, ABI, methods, live state and recent receipts. Every draft is validated and backtested before a human sees it. Explains breaches with `Qwen/Qwen3.6-35B-A3B-FP8` after the pause lands. Both are open-weight and set by one environment variable each. | [backend/src/ai](backend/src/ai) |
| Verify | Public status page. Every number links to the exact RPC request and raw response, with a `curl` to reproduce it. | [frontend/src/pages/public](frontend/src/pages/public) |
| Operate | Operator console (React + Vite): assets, policies, authority, incidents, relayers, sandbox simulations | [frontend/](frontend/) |

## Try it (no keys, no testnet funds)

Requirements: Node.js 22 or newer (tested on 24.21), Linux or macOS on x86_64/arm64, about 1 GB of free RAM. Rust is **not** needed: the built contracts are committed in [contracts/wasm](contracts/wasm). The first run downloads the official nearcore sandbox binary (~90 MB) through near-kit.

1. **Install:** `npm ci`
2. **Run the whole demo script** (the first `npm run demo` or `npm start` also builds the React frontend into `frontend/dist`, which takes a few seconds): `npm run demo -- --auto --exit`. It takes about 3 minutes and prints a summary. You should see:
   - `Demo ledger: approved solvency-usdc as pause (backtest: 0 fires over 24 samples)`, and `guardian verified=true ... watcher key scope ok=true`.
   - `Replay: NEAR Intents ghost-balance bug on the ledger`, then `watcher: breach at block N, ledger paused at block N+4 = 4 blocks later, ~3 s after detection`. Then `attacker withdraw of the ghost balance: rejected (qorvex-guard: contract is paused ...)`.
   - `vault paused in the deposit transaction itself (...): self-accounting: credited 290000000000 > backing 250000000000`.
   - `without Qorvex: sponsored 100, sponsor balance 0.6 NEAR -> 0.40575 NEAR`, then `with Qorvex check(): sponsored 8, refused 92 ...`, and `first refusal: spend cap: ...`.
   - `Guardian on-chain pause history ...` with `"rule_id":"solvency-usdc"` and `"status":"Paused"`.
3. **Test the watcher by hand in the Watcher Lab:** run `npm run demo` (without `--auto`) and open `http://localhost:8787/lab`; paste the operator token it prints. Go through the seven steps:
   1. connect the ledger
   2. have the AI draft the rules, then approve them
   3. let the guardian pause it
   4. publish the status page
   5. act as an honest user (Alice deposits and withdraws; the feed stays green)
   6. run the Intents ghost-balance exploit as Mallory: a red line, then "PAUSED at block N" and "4 blocks vs ~40 hours", and Mallory's withdrawal is rejected
   7. recover and run it again

   The right-hand panel shows the ledger's owed/held and what the watcher sees on every block.
4. **Use the operator console:** with the same `npm run demo`, open `http://localhost:8787/` and sign in. To work on the UI with hot reload, run `npm run dev:web` and open `http://localhost:5173/` instead; it proxies the API to :8787. See [frontend/README.md](frontend/README.md). Then sign in with the operator token it prints. Everything that runs on the local sandbox carries a striped "Simulated · local sandbox" label. Recorded AI output carries a "Recorded AI response" label.
   1. **Connect.** Click "Connect asset", click "Use" next to the demo ledger, then Connect. You land on the asset page. The state is "Needs attention" and the setup strip shows Source → Policies → Authority → Status page.
   2. **Policies tab.** Click "Load demo source", then "Draft policies". You see two drafted policies (solvency and outflow rate), each with its parameters in plain units, a live value and a backtest (`Fired 0 times across 26 samples`). Choose "Alert + auto-pause" and click Approve. A dialog spells out what Qorvex will do on a breach. "Auto-pause" is disabled for any policy whose backtest fired. "Write a policy by hand" adds a policy through the same validator and backtest.
   3. **Authority tab.** It shows the chain watcher key → guardian → your contract, what Qorvex can and cannot do, and the exact transaction plus a near-cli-rs command. Click "Sign with the sandbox owner key", then "Read back and verify". You see four green checks, including `Watcher key limited to guardian.pause`. The state turns "Healthy".
   4. **Status page tab.** Click "Publish status page". The public page at `/status/<id>` needs no token.
   5. **Simulations** (left nav). Click "Run exploit on the ledger". Within a few seconds, Overview shows "1 paused", Incidents shows "Paused +4 blocks", and the incident page shows evidence (owed 290,000 USDC, held 250,000 USDC, shortfall 40,000 USDC), replayable `curl` reads, a measured timeline (block received +0.67 s … contract paused +3.6 s), the pause transaction and recovery steps. The public page turns "Paused: outflows are stopped".
   6. **DAO firewall.** Connect the Treasury DAO the same way, draft and approve its policy as "Alert + vote to reject", then on its Authority tab click "Propose and approve with the sandbox council" and "Read back and verify". In Simulations, submit "Over-cap transfer", then "Council approves the last proposal". The DAO's Proposals tab shows "Breaks policy · Rejected +3 blocks", and the council's approval fails with `ERR_PROPOSAL_NOT_READY_FOR_VOTE`.
   7. **Relayers.** In Simulations, click "Sponsor drain (Trezu #1871) → With check()": you see `8 sponsored, 92 refused`. Open Relayers → the demo relayer to see budgets, the proposal policy and a decision log where every refusal has its reason.
   8. **Authority** (left nav) compares the three layers (in-contract, external monitoring, relayer) and lists every permission this server holds, per network and per asset.
5. **Run the tests and checks:**
   - `npm run check`: type-checks every workspace, runs the 67 unit tests and builds the frontend (~30 s).
   - `npm test`: the unit tests plus 16 end-to-end tests on a real local sandbox (~4 min).
   - `npm run test:contracts` (needs Rust): 34 contract unit tests.
6. **Watch mainnet NEAR Intents, read-only:** `QORVEX_NETWORKS=mainnet npm start`, then in another shell `QORVEX_ADMIN_TOKEN=<token printed by the server> npm run seed:intents`. The seed adds three solvency rules on `intents.near`: owed is `mt_supply("nep141:<token>")` and held is `<token>.ft_balance_of("intents.near")`, for USDC, USDT and wNEAR. Each is backtested against 30 days of archival state, approved alert-only and published at `/status/<id>`. The public `archival-rpc.mainnet.near.org` rate-limits heavily (HTTP 429), so the first backtest can take an hour or stall. It resumes from the cache on rerun, or set `QORVEX_MAINNET_ARCHIVAL_RPC` to a paid archival endpoint. Live values were checked on 2026-11-10: owed ≤ held held for all three tokens. The page is marked unofficial, and Qorvex holds no key for `intents.near`.

## Repository layout

An npm workspace with three packages and the Rust contracts:

| Path | What | Checks |
| --- | --- | --- |
| [backend/](backend/) | `@qorvex/backend`: the Qorvex service (HTTP API, watcher, block streams, rules, proposal firewall, AI drafting, alerts, relayer SDK) in `src/`; the local demo world, scripted demo actors and the mock relayer in `src/demo/`; CLI scripts (`demo`, `deploy-testnet`, `seed-intents`, `firewall-replay`) in `scripts/`; recorded AI responses and the mainnet replay evidence in `fixtures/`; unit and sandbox e2e tests in `test/` | `npm run typecheck -w @qorvex/backend`, `npm test` |
| [frontend/](frontend/) | `@qorvex/frontend`: operator console, public status pages and Watcher Lab (React + Vite). See [frontend/README.md](frontend/README.md). | `npm run build:web` |
| [shared/](shared/) | `@qorvex/shared`: the domain model and API response types, type-only. The backend produces these shapes and the frontend renders them, so both compile against one definition. | `npm run typecheck` |
| [contracts/](contracts/) | Rust: `qorvex-guard` crate, `guardian` contract, demo ledger and token; built wasm in `contracts/wasm/`, the vendored Sputnik DAO wasm in `contracts/vendor/`; `build.sh` rebuilds the wasm | `npm run test:contracts` |

Runtime data (stores, caches, sandbox and testnet keys) goes to `data/` at the repository root, which is git-ignored. Paths in configuration (`QORVEX_DATA_DIR`, `QORVEX_AI_FIXTURES`, `QORVEX_DEMO_DIR`) are relative to the repository root, so the scripts behave the same from any working directory.

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
- **What the AI does:** it only drafts rules and explains breaches. Rules start as `draft` with response `alert` and need a human to approve them. The pause decision is made by [backend/src/rules/evaluate.ts](backend/src/rules/evaluate.ts) and [backend/src/watcher/watcher.ts](backend/src/watcher/watcher.ts), with no model call on that path.
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

- `QORVEX_ADMIN_TOKEN`: operator API and console token (at least 16 characters; generated per run when unset).
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
- **Replay mode** (the default) answers only from fixtures in [backend/fixtures/ai](backend/fixtures/ai). A missing fixture is an error, never a made-up answer. The demo then adds the same rules by hand and says so in its output.
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
- **Block source:** NEAR Lake (AWS S3) is deprecated and no longer indexes new blocks, so Qorvex does not use it. The watcher streams from Neardata (`mainnet.neardata.xyz` / `testnet.neardata.xyz`), which docs.near.org now recommends for hosted block data, or follows blocks and chunks over RPC (`QORVEX_<NET>_STREAM=rpc`, and always on the sandbox). The docs recommend a NEAR Indexer node when latency is critical; that is the path to the 3-block pause target.
- **Pause-state check:** it reads an `is_paused` view. Contracts without one are assumed not paused.
- **The demo ledger is vulnerable on purpose:** never deploy it with real funds.

## Libraries, prior work and AI use (Q-005)

- **Started in the hackathon window:** all code was written from scratch on 2026-11-10. There is no pre-hackathon baseline.
- **Libraries:** near-sdk 5.29 and near-contract-standards (Rust); near-kit 0.20.2 (TypeScript signing and sandbox) for the backend, whose HTTP server, RPC client and rule engine are plain Node.js; React 19, react-router 7 and TanStack Query 5 for the frontend, built with Vite; vitest, tsx and TypeScript for development.
- **AI code:** the code was written with an AI coding assistant (Claude Code) from the team's PRD, and reviewed and tested as described above.

## License

MIT, see [LICENSE](LICENSE).
