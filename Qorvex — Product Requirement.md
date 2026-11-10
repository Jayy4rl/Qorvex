# Qorvex — Product Requirements

Nov 10, 2026 · @Valerie Nwajei

## Summary

Qorvex gives NEAR contracts, DAO treasuries and gas relayers spending limits and circuit breakers, with AI that drafts the rules. It blocks over-limit payments before they move, and pauses a contract within seconds when its books stop adding up.

- **Pitch:** The NEAR Intents exploit ran for 40 hours before anyone noticed. Qorvex would have stopped it on the first ghost credit, in the same transaction or within seconds, using a key that cannot move funds.
- **Two layers:** *Prevent* (limits checked before money moves) and *Detect and stop* (an outside watcher that pauses on a broken invariant).
- **AI's role:** It drafts the rules and explains alerts. Humans approve every rule. Fixed, deterministic code decides when to pause.
- **Tracks:** AI Security & Defense (primary), Unstoppable DeFi, Social Money.
- **Deadline:** Submissions close Nov 14, 23:59 UTC. A working prototype, a public repository and a demo post are required.

## Problem and evidence

Two of NEAR's flagship products lost money this autumn in ways a basic limit or invariant would have caught. In both cases the fix was manual and only after the fact.

| Date (2026) | Incident | What failed | What would have helped |
| --- | --- | --- | --- |
| Oct 19 | [Trezu sponsor relayer drained twice](https://github.com/NEAR-DevHub/trezu/issues/1871) | Attacker-triggered sponsor-paid `storage_deposit` calls, up to 200 per proposal. After a manual fix the relayer was drained again within about an hour, and sponsored actions failed for every Trezu and NEAR Business user. | A per-beneficiary spend cap, checked before the relayer pays |
| Sep 29 to Oct 1 | [NEAR Intents ghost balances](https://thecoding.substack.com/p/near-intents-ghost-fund-postmortem) | A deposit-callback bug created $3.8M of unbacked balances, which were withdrawn through Omni. It ran for 40 hours before anyone noticed, then took 29 minutes to pause. Monitoring compared bridge-side assets, not internal user balances against tokens held ([ChainCatcher](https://www.chaincatcher.com/en/article/2294625)). | A solvency invariant with an automatic pause |

**Why the gap persists**

- After the exploit, Intents added its own self-pausing balance invariant. That fix is specific to Intents, and no reusable equivalent exists for other NEAR contracts.
- EVM chains have runtime monitors (Forta, OpenZeppelin Defender, Hypernative, Hexagate). No NEAR-native equivalent was found. This is an absence finding and still needs confirming.
- Writing invariants by hand is specialist work, so most teams never do it.
- NEAR cross-contract calls are asynchronous, so a contract cannot synchronously check its real token balance during a transaction. A full solvency check therefore needs an outside watcher, which teams have to build themselves.

## Users and jobs to be done

Qorvex has three users. Operators set it up and would pay; relayer operators install it as a check; depositors only ever see the public page.

| User | Examples | Job to be done | What Qorvex gives them | Demand evidence |
| --- | --- | --- | --- | --- |
| Protocol or treasury operator | Teams running ledger-style contracts (Intents-like), DeFi protocols such as Rhea, DAOs on Sputnik or Trezu | Stop bad outflows in the same transaction, and be alerted within seconds, already contained, when anything else breaks | AI-drafted rules, a live dashboard, automatic pause through a key that can't move funds | Strong (Intents exploit) |
| Relayer or payment-service operator | Trezu's sponsor relayer, payout services, gas sponsors | Stop paying for abuse before the balance is drained | An SDK check before each payment, with per-beneficiary budgets | Strong (Trezu issue #1871) |
| Depositor or end user | People with funds in a NEAR protocol (Intents had over 520,000 users in the 30 days to end of October) | Know whether the protocol is still fully backed | A public status page, with every value linked to the raw on-chain read | Unverified (no user requests found) |

## Goals, non-goals and success metrics

The goal is to shrink both the time a broken contract runs unnoticed and the amount it can lose, without handing anyone new power over funds.

**Goals**

1. Block outflows that break a limit or the contract's own accounting in the same transaction, before the money moves.
2. Detect a broken solvency invariant within about three blocks of the receipt that broke it, pause automatically, and alert the moment it is contained.
3. Get a contract from "connected" to "protected" in under 15 minutes, using rules drafted by an open-weight model on NEAR AI Cloud and checked automatically against the contract's history.
4. Let anyone verify a protocol's backing from the raw on-chain reads.

**Non-goals**

- Holding, moving or custodying funds. Qorvex can at most pause.
- AI deciding to pause or changing live rules. The AI only drafts and explains.
- Unpausing. That stays with the protocol's admin or DAO vote.
- Stopping a drain that happens inside a single transaction from the watcher alone. That is what in-contract limits are for.
- Formal verification and price-oracle checks such as collateral ratios (v1).

**Success metrics**

| Metric | Hackathon target | Post-hackathon |
| --- | --- | --- |
| Time from breach to pause | Same transaction for self-accounting breaches; within 3 blocks for watcher breaches on testnet, via the guardian contract. Shown live next to "40 hours" | Median across protected contracts |
| False alarms | 0 solvency-rule fires when backtested against 30 days of mainnet Intents history | False-pause rate per contract-month |
| Setup time | Under 15 minutes from contract ID to approved rules in the demo | Median onboarding time |
| Adoption | Two replayed incidents caught and stopped | Contracts protected, value covered, relayer requests checked |

## Functional requirements

There are 29 requirements across six components. Everything marked **Must** ships by Nov 14; **Should** ships if time allows; **Later** is listed as future work in the README.

| ID | Component | Requirement | Priority |
| --- | --- | --- | --- |
| P1 | Prevent: contract guard | A Rust crate, `qorvex-guard`, that wraps a contract's outflow methods and rejects any call that would exceed a per-token, per-time-window cap. | Must |
| P2 | Prevent: contract guard | Limits are stored in contract state and can be changed only by the owner or DAO. Usage resets each window. | Must |
| P3 | Prevent: contract guard | **Self-accounting check (instant pause).** The crate keeps its own tally of confirmed deposits per token. After every state change it checks that what has been credited to users does not exceed that tally. On failure, the method sets the contract to paused and returns without making the outflow, so the pause takes effect in the same transaction. (Rejecting the call by panicking would roll back the pause as well.) | Must |
| P4 | Prevent: relayer SDK | `check(beneficiary, action, cost)` returns allow or deny with a reason before the relayer signs. Every decision is logged. | Must |
| P5 | Prevent: relayer SDK | Budgets are edited in the console and pulled by the SDK, with a local cache so a Qorvex outage fails closed or open according to the operator's setting. | Should |
| D1 | Detect and stop: watcher | **Streaming, not polling.** Subscribes to the block and receipt stream (NEAR Lake or an equivalent indexer feed) and evaluates every receipt that touches a protected contract in the block it lands in. | Must |
| D2 | Detect and stop: watcher | Rule types: solvency (owed ≤ held, per token) and outflow rate (Must); sponsor spend and treasury transfer policy (Should). | Must |
| D3 | Detect and stop: watcher | Before firing, re-read the failing values with one direct RPC view call at the latest block. Fire as soon as the failure is confirmed, without waiting for more blocks. | Must |
| D4 | Detect and stop: pause executor | Calls the guardian contract's `pause` method using a function-call key limited to that one method, submitted through several RPC providers at once. Target: the protected contract is paused within 3 blocks of the receipt that broke the rule (one extra hop through the guardian; to be measured). The pause never waits on the AI. | Must |
| D5 | Detect and stop: alerts | The alert goes out at the same moment as the pause and reports a contained incident, for example "drain detected and paused at block X". Telegram and webhook are Must; phone push and PagerDuty are Should. | Must |
| D6 | Detect and stop: breach log | Records the rule, the observed values, block height, the transactions involved and the pause transaction hash. | Must |
| G1 | Guardian contract | A Qorvex guardian contract (for example guardian.qorvex.near) with pause(target, rule\_id, evidence\_hash), callable only by approved watcher accounts. It records the pause on-chain, then calls the target's pause(). It cannot unpause, change limits or move funds. | Must |
| G2 | Guardian contract | Owner-only set\_watchers to add or remove watcher accounts. It requires a 1 yoctoNEAR deposit, so no function-call key can call it. | Must |
| G3 | Guardian contract | View method pause\_history(target): every pause with its block, rule ID, evidence hash and watcher. The status page links to it. | Must |
| G4 | Guardian contract | Pause limit: at most one automatic pause per target per hour unless the target's council confirms, which stops repeated griefing pauses. | Should |
| A1 | AI: provider | Inference runs on NEAR AI Cloud through its OpenAI-compatible API (`https://cloud-api.near.ai/v1`). The model for each job is a configuration setting, so swapping it means changing one line. | Must |
| A2 | AI: models | Rule drafting uses a larger open-weight model that is good with code (for example Qwen3.5-122B-A10B or GLM). Breach explanations use a smaller, faster model (for example Qwen3-30B-A3B-Instruct). Confirm both IDs against the live catalog. | Must |
| A3 | AI: drafting inputs | Contract source (from NEP-330 metadata or an upload), the ABI if published, the list of view methods, a few live state reads and recent transactions. | Must |
| A4 | AI: drafting output | JSON only, matching Qorvex's rule format, at temperature 0. Each rule includes a plain-English sentence. | Must |
| A5 | AI: automatic validation | Before a human sees a draft, every view method it references is called and must return a value that parses, and the backtest is run. A failing draft goes back to the model with the error, at most twice, and is then dropped. | Must |
| A6 | AI: human approval | Every rule needs human approval before it goes live. The AI cannot edit active rules or trigger a pause. | Must |
| A7 | AI: breach explanation | Written after the pause has landed, never before: what broke, by how much, and which accounts and transactions to check first. | Should |
| A8 | AI: attestation | Store the TEE attestation for each drafting call and show a "drafted in an attested enclave" badge in the console. | Should |
| A9 | AI: reproducible demo | Recorded model responses are committed to the repo so the demo runs without an API key. Live inference is switched on with an environment variable. | Must |
| S1 | Status page | A public page per protocol showing each check, its live values, the block it last passed and the pause state. | Must |
| S2 | Status page | Every value links to the exact RPC call and raw response, so anyone can verify it. | Must |
| S3 | Status page | An embeddable badge and email or Telegram alerts for users. | Later |
| L1 | Hardening | The watcher runs in a TEE (NEAR AI Cloud or OutLayer) so its alerts and reads are attested. | Later |
| L2 | Hardening | Watcher quorum in the guardian contract: several independent watchers must agree before a pause, plus a Chain Signatures pause for vaults on other chains. | Later |

## Architecture

Qorvex is an off-chain service plus a small on-chain footprint. It reads chain state freely, but its only power on-chain is a key that can ask its guardian contract to call `pause`.

&#91;embedded content: Qorvex architecture: off-chain service, on-chain guard and pause key\]

Rules flow down from the console into the watcher. The watcher streams every block and its receipts, and a breach goes to the pause executor, then the guardian contract, then the protected contract. Relayers pull their budgets from the rule store (left lane) and sign only what `check()` allows.

**Contracts and accounts**

Qorvex deploys one contract of its own, the guardian. Everything else on-chain belongs to the protocol, or to you for the demo.

| Contract or account | Owner | Where it lives | Role |
| --- | --- | --- | --- |
| Protected contract with `qorvex-guard` | The protocol | The protocol's own account | Its product. The guard adds caps, the self-accounting check and a `pause()` that accepts only the guardian contract |
| Qorvex guardian contract | Qorvex | `guardian.qorvex.near` (a testnet account for the demo) | Records each pause with its rule and evidence hash, then forwards `pause()`. Cannot unpause, change limits or move funds |
| Watcher accounts | Qorvex | Keys limited to the guardian's `pause` method | Sign pause requests |
| Demo ledger and test token | You, for the hackathon | Testnet | An Intents-style ledger with the refund-after-credit bug planted, and a NEP-141 token for deposits |

The demo ledger's methods: `ft_on_transfer` (deposits), `withdraw` (wrapped by the guard), `pause` (guardian contract only), `unpause` and `set_limits` (owner only, with a 1 yoctoNEAR deposit), and the views `total_owed`, `confirmed_deposits`, `is_paused` and `limits`.

**Trust model**

- Qorvex holds no key that can move funds. Watchers' keys can only call the guardian contract's `pause` method, with no deposits. The guardian records each pause and forwards it, and cannot unpause or move funds.
- The contract accepts `pause()` only from the guardian contract. Unpausing and changing limits stay with the owner or DAO.
- In-contract limits keep working even if the Qorvex service is down.
- The AI only advises, through drafts and explanations. Deterministic code evaluates the rules and fires the pause.
- Anyone can reproduce any status-page value from the raw RPC read it links to.

**Why it fits NEAR**

- Function-call access keys limit watcher keys to the guardian's pause method, enforced by the protocol itself, so a stolen key can do nothing else.
- Cross-contract calls are asynchronous, so a contract can't check its real token balance inside a transaction. The solvency check therefore lives in the watcher, while the guard crate enforces limits and the self-accounting check using the contract's own state.
- Sputnik DAO roles map directly onto "the watcher can pause, the council unpauses".
- NEP-330 source metadata feeds the AI drafter, and NEP-141 and NEP-245 balance views feed the solvency rules.

**Suggested stack:** Rust with near-sdk for the guard crate and test contracts. TypeScript for the watcher, SDK and console, reading the block stream through NEAR Lake (or an equivalent feed) and confirming over RPC. NEAR AI Cloud for the AI, configured as below.

**AI configuration**

The AI runs on [NEAR AI Cloud](https://near.ai/cloud), which serves open-weight models inside TEEs through an [OpenAI-compatible API](https://ai-sdk.dev/providers/openai-compatible-providers/nearai) at `https://cloud-api.near.ai/v1`. Protocols' contract source stays private, and each call can be attested.

| Job | When it runs | Model (a setting) | Settings |
| --- | --- | --- | --- |
| Rule drafting | Once per contract, at setup | Larger open-weight model, e.g. Qwen3.5-122B-A10B or GLM | JSON output in the rule format, temperature 0 |
| Breach explanation | After the pause has landed, never before | Smaller model, e.g. Qwen3-30B-A3B-Instruct | Plain text, temperature 0 |

Check model IDs against the live catalog (`curl https://cloud-api.near.ai/v1/model/list`) before fixing them.

Drafting pipeline:

1. Collect the inputs: source, ABI, view methods, live state reads, recent transactions.
2. The model returns draft rules as JSON.
3. The validator calls every referenced view method, checks the values parse, and runs the backtest. Failures go back to the model with the error at most twice, then are dropped. This catches made-up method names, the most likely AI error.
4. The operator approves, edits or rejects what survives.

Example draft rule (method names are illustrative and depend on the contract):

```json
{"type":"solvency","token":"usdc.near",
 "owed":{"view":"mt_total_supply","args":{"token_id":"nep141:usdc.near"}},
 "held":{"contract":"usdc.near","view":"ft_balance_of","args":{"account_id":"ledger.near"}},
 "explain":"USDC owed to users must never exceed USDC held"}
```

## User flows

The operator does all the setup once. After that, Qorvex runs without anyone watching, and people only act when something trips.

**Operator: setting up protection**

1. **Connect.** Enter the contract's account ID and choose testnet or mainnet. Qorvex fetches the source from NEP-330 metadata, or asks for an upload.
2. **Review drafts.** The AI, an open-weight model on NEAR AI Cloud, shows what it found (tokens, liability views, outflow methods) and proposes rules. Drafts that fail the automatic checks never reach the operator. Each rule shows:
   1. a plain-English sentence, such as "USDC owed to users must never exceed USDC held";
   2. the exact rule;
   3. its live value, such as "owed 1,204,331 · held 1,210,002 · margin 0.47%" (illustrative figures);
   4. a backtest, such as "would have fired 0 times in the last 30 days".

   The operator edits, approves or rejects each one.
3. **Choose the response** for each rule: alert only, or alert and pause.
4. **Authorise the guardian** if any rule pauses. In one transaction, the operator registers the contract with the Qorvex guardian contract and sets its `pause` role to the guardian. The operator signs it in their wallet, and Qorvex reads both settings back to confirm.
5. **Add limits inside the contract** (optional). Wrap outflow methods with `qorvex-guard` so you can set caps per time window and turn on the self-accounting check.
6. **Publish** the status page.

**Breach: what happens**

1. If the contract uses the guard crate, its self-accounting check trips first: the outflow is not made and the contract pauses itself in the same transaction. Otherwise, the watcher sees the receipt that breaks a rule in the block it lands in, and confirms it with one direct RPC read.
2. The pause executor asks the guardian contract to send `pause()`, submitted through several RPC providers at once. The guardian records the rule and evidence hash, then forwards the call, which lands within about three blocks. The contract stops outflows.
3. At the same moment, an alert reports the incident as contained, with the rule, the values, the block, the transactions involved, the AI explanation and the pause transaction.
4. The status page turns red and shows the block the contract was paused at.
5. The operator investigates using the incident timeline, fixes the bug, and unpauses through their own admin key or DAO vote. The rule shows as healthy again once it passes.

**Relayer operator**

1. Install the SDK and set budgets in the console, for example a maximum NEAR per treasury per hour, or a maximum number of `storage_deposit` calls per proposal.
2. Before signing each sponsored transaction, the relayer calls `check()`.
3. Requests over budget are refused with a reason. The operator is alerted when refusals repeat.
4. The operator reviews the log and keeps or raises the limit.

**Depositor**

1. Opens the status page from a link or badge in the protocol's app.
2. Sees each check, owed against held, and the block it last passed.
3. Clicks any value to see the raw RPC request and response, and can reproduce it with one `curl` call.
4. Subscribes to alerts (Later).

## Go-to-market and revenue

DAOs are not the market. The market is anything that moves money automatically: relayers, contracts holding user funds and, later, agent wallets. Platforms are the distribution channel, so Qorvex sells to a few platforms rather than to thousands of individual DAOs. Willingness to pay has not been tested. Everything below is a hypothesis to validate with design partners.

**Segments, in order of attack**

| Segment | Who | Why they buy | Evidence |
| --- | --- | --- | --- |
| 1. Gas relayers and sponsors | Trezu and NEAR Business relayers, wallets and apps that sponsor gas for gasless onboarding (meta transactions) | A drained relayer breaks the product for every user, and the SDK is easy to add to an off-chain service | Strong (Trezu #1871) |
| 2. Contracts holding user funds | Ledger-style protocols, DeFi (lending, vaults, DEXs), bridges, launchpads that hold deposits | One exploit costs more than years of subscriptions. A public backing page builds depositor trust | Strong for Intents-style ledgers; Partial elsewhere |
| 3. Platforms that create many accounts | Sputnik DAO factory, Trezu, NEAR Business, agent platforms (Agent Market, OutLayer) | Spending limits become a default toggle for every account they create, which is distribution, not a sale per DAO | Inferred |
| 4. Agent wallets | Agents that spend on users' behalf | Limits and pause are what make delegating money to an agent acceptable | Hypothesis: judges say agent payments are still small in 2026 |
| 5. Other chains | Vaults and accounts controlled through Chain Signatures, and Intents' cross-chain flows | The same rules, enforced on assets outside NEAR | Later |

**Motion**

1. **Design partners (first 3 months).** Free, hands-on setup for Trezu/DevHub (the incident evidence) and one or two DeFi teams. The goal is installs, plus a validated answer to "would you pay?"
2. **Open-source core.** The guard crate, SDK and rule format are open source. Security buyers need to audit what can pause their contract, and open code spreads through templates and docs.
3. **Platform integrations.** Ship spending limits as a default setting in the Sputnik DAO factory and Trezu, and as an option in NEAR's contract templates. One integration covers thousands of accounts.
4. **The status page as pull.** Publish read-only backing pages for major protocols from public data (clearly marked as unofficial). Protocols then claim and verify their page, and depositors start asking why a protocol has none.
5. **Incident replays.** After every public exploit on any chain, publish a replay showing whether Qorvex's rules would have caught it. Security budgets are spent right after incidents.

**Revenue (hypotheses, not validated)**

| Stream | What's paid for | Who pays |
| --- | --- | --- |
| Free | Open-source guard and SDK, alert-only watcher with slower checks, testnet | Everyone (adoption) |
| Pro subscription | Per protected contract: per-block checks, automatic pause, public status page, backtests | Protocols, treasuries |
| Usage-based | Per 1,000 relayer `check()` calls, plus hosted policy management | Relayers, payment services, agent platforms |
| Enterprise | TEE-attested watchers, several independent watchers, custom rules, response SLA. Possibly priced by value protected | Large protocols, bridges |
| Platform licence | A revenue share or flat fee for a default integration | DAO and agent platforms |
| Grants (bridge funding, not a business) | Free tier treated as public goods | NEAR Foundation, DevHub, House of Stake |

**The honest ceiling.** The number of NEAR contracts holding meaningful value is limited, so revenue from NEAR alone would be small. A real business needs segment 4 (agent wallets) or segment 5 (other chains). On other chains Qorvex competes with established EVM monitors. The rule engine is chain-agnostic, but the pause-only key and Sputnik integration are specific to NEAR.

## Hackathon scope, demo and plan

Ship both layers on testnet against contracts you control, plus a read-only watcher on mainnet Intents to show it works on real data. Submissions close Nov 14, 23:59 UTC, which is 00:59 on Nov 15 in Lagos.

**In scope:** P1–P4, D1–D6, A1–A6, A9, G1–G3 and S1–S2 from the requirements. **Stretch:** P5, A7, A8, G4, the sponsor-spend rule and the treasury-policy rule. **Out of scope:** TEE watcher, multi-watcher quorum, Chain Signatures pause, user alerts.

**Build plan**

- [ ] Nov 10–11: Testnet ledger contract with the "refund after credit" bug planted and a `pause()` method. A `qorvex-guard` rate limiter and self-accounting check on its deposit and withdraw methods. A mock sponsor relayer. A minimal Qorvex guardian contract (G1 to G3).
- [ ] Nov 12: Rule format, streaming watcher (solvency and outflow-rate rules), confirmation read, pause executor submitting through several RPC providers with the pause-only key, breach log.
- [ ] Nov 12: Relayer SDK `check()`, wired into the mock relayer.
- [ ] Nov 13: Console: connect a contract, AI drafts rules on NEAR AI Cloud with automatic validation, approve, grant the key. Backtest on recent history.
- [ ] Nov 13: Public status page with links to the raw reads. Read-only watcher on mainnet Intents.
- [ ] Nov 14: README with "do X, see Y" steps for the AI screeners, one-command local run using recorded model responses (no API key needed), demo video, demo post, submission.

**Demo script (about 3 minutes)**

1. Open with the problem: the Intents exploit ran 40 hours before anyone noticed.
2. Connect the testnet ledger. The AI drafts the solvency rule. Show the live value and the backtest, then approve it and grant the pause-only key.
3. Show the mainnet Intents status page, with every value clickable down to the raw RPC read.
4. Replay the ghost-balance bug on testnet. The page turns red, the contract pauses automatically, and the time to pause appears next to "40 hours".
5. Replay the Trezu drain against the mock relayer. The first requests go through, then `check()` refuses the rest and the balance stops falling.
6. Close by showing that the key Qorvex holds can only call `pause`. Even if Qorvex were compromised, it could not move funds, and the guardian contract's on-chain history shows why every pause happened.

## Risks and open questions

The biggest risk is a false pause. A Qorvex that freezes a healthy protocol will be uninstalled after the first time.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| False pause | Users locked out and trust lost | A confirmation read before firing, backtest before approval, alert-only mode by default, pause only on rules with zero backtest fires |
| False confidence from a green page | Users trust checks that don't cover the bug | The page lists exactly what is checked and at which block, and states that single-transaction drains are out of the watcher's reach |
| Watcher outage or RPC lag | Missed or late detection | Multiple RPC providers. Later, several independent watchers (L2). In-contract limits keep working without the watcher |
| Intents has no testnet | The pause can't be demoed on real Intents | Read-only on mainnet, with the pause replayed on our own testnet copy of the bug pattern |
| Mainnet backtest data | Historical per-token liability totals may need an indexer or archival RPC | Fall back to a 7-day window, or rebuild totals from event logs |
| Adoption needs code changes | The guard crate means teams must touch audited contracts | Lead with the relayer SDK and the read-only watcher, which need no contract changes |
| Competition | Antibody (a hackathon entry, exploit bounties) and EVM monitors moving to NEAR | Antibody finds bugs people report; Qorvex acts at runtime. The NEAR-native pause key and Sputnik fit are the moat for now |
| Guardian contract bug or stolen watcher key | Wrongful or repeated pauses | The guardian can only pause, never unpause or move funds. Owner-only watcher list (G2), pause limit (G4), public pause history (G3). Keep the contract small enough to review line by line |

**Open questions**

- [ ] Would Trezu/DevHub and one DeFi team install it, and would they pay?
- [ ] Is there really no NEAR-native runtime monitor today?
- [ ] Does Intents expose per-token liability totals through a view method, or do they have to be rebuilt from events?
- [ ] What exactly does HACKATHON.md say about testnet-only eligibility? (So far only seen through a participant's summary.)

## Sources

- [nearhackathon.com](https://nearhackathon.com/): dates, tracks, judging process
- [NEAR Intents ghost-fund post-mortem summary](https://thecoding.substack.com/p/near-intents-ghost-fund-postmortem) (thecoding Substack)
- [ChainCatcher post-mortem coverage](https://www.chaincatcher.com/en/article/2294625)
- [DeFiPrime: NEAR Intents recovers $3.8M](https://defiprime.com/near-intents-recovers-3-8m-after-contract-exploit)
- [Trezu issue #1871: sponsor relayer drained](https://github.com/NEAR-DevHub/trezu/issues/1871)
- [Trezu repository](https://github.com/NEAR-DevHub/trezu)
- [NEAR Protocol on X, October 2026 Intents figures](https://x.com/NEARProtocol/status/2112257967818997891)
- [Antibody PR #66](https://github.com/Himess/antibody/pull/66): competing hackathon entry
- [NEAR AI Cloud](https://near.ai/cloud): private inference in TEEs
- [NEAR AI Cloud provider guide (AI SDK)](https://ai-sdk.dev/providers/openai-compatible-providers/nearai): OpenAI-compatible API, base URL, model catalog
- [NEAR AI Cloud models (Mastra)](https://mastra.ai/models/providers/nearai): example Qwen and GLM model IDs

## Further research

These are reference links for building and validating Qorvex, grouped by the part of the product they inform. Each note says why the link matters.

**NEAR building blocks (pause key, source metadata)**

- [Access keys](https://docs.near.org/protocol/access-keys): function-call keys can only sign calls to one specific contract and cannot attach NEAR. This is the basis of the pause-only key (D4).
- [One-yocto security pattern](https://docs.near.org/smart-contracts/security/one-yocto): requiring a deposit blocks function-call keys. Use it so that `unpause` and limit changes can never be called with Qorvex's key.
- [RPC: view access keys](https://docs.near.org/api/rpc/access-keys): `view_access_key` for reading back the granted key's scope during operator setup.
- [NEP-330 source metadata](https://github.com/near/NEPs/blob/master/neps/nep-0330.md): how contracts publish their source link (the `contract_source_metadata` view), which the AI drafter reads (A3).
- [NEAR docs index for LLMs](https://docs.near.org/llms.txt): the full docs index in one file. Useful as reference context for the drafting model.

**Streaming the chain (instant detection)**

- [NEAR Lake Framework](https://docs.near.org/data-infrastructure/near-lake-framework): subscribe to the block stream. It adds roughly 0.1 to 2.1 s of latency on top of an indexer, and the reader pays the AWS S3 costs.
- [NEAR Indexer](https://docs.near.org/data-infrastructure/near-indexer): runs a node and streams blocks directly. Faster than Lake, so consider it for production D1.
- [Tutorial: indexer that watches function calls on one contract](https://docs.near.org/data-infrastructure/tutorials/near-lake-framework): almost exactly the watcher pattern Qorvex needs.
- [near-lake-framework crate](https://docs.rs/near-lake-framework): Rust API, including a FastNEAR data-source option.
- [near-lake-raw-printer](https://github.com/near-examples/near-lake-raw-printer): the smallest working Lake indexer, a good starting point.

**NEAR Intents (the reference incident and read-only target)**

- [Verifier contract overview](https://docs.near-intents.org/near-intents/market-makers/verifier): Intents is an internal ledger at `intents.near`, with no testnet deployment.
- [Deposits](https://docs.near-intents.org/near-intents/market-makers/verifier/deposits-and-withdrawals/deposits): how NEP-141 deposits are credited. This is where the exploit's callback bug lived.
- [Intent types and execution](https://docs.near-intents.org/integration/verifier-contract/intent-types-and-execution): cross-contract calls from the Verifier are not guaranteed to finish in order, which is the async risk Qorvex's rules must handle.
- [near/intents repository](https://github.com/near/intents): contract source, with the ABI on the releases page.
- [NEAR Intents bug bounty (HackenProof)](https://hackenproof.com/programs/near-intents) and [Hacken audit report](https://hacken.io/a/JGqYsZ): existing security coverage to position against.

**Treasuries and relayers (first customers)**

- [Trezu open issues](https://github.com/NEAR-DevHub/trezu/issues): live evidence of treasury and relayer pain. Watch for new reports.
- [Sputnik DAO contract](https://github.com/near-daos/sputnik-dao-contract): roles and proposals, for "the watcher can pause, the council unpauses".
- [pagoda-relayer-rs](https://github.com/near/pagoda-relayer-rs): reference meta-transaction relayer, a natural first integration for the `check()` SDK.

**AI**

- [NEAR AI Cloud](https://near.ai/cloud), [model catalog](https://cloud-api.near.ai/v1/model/list) and [AI SDK provider guide](https://ai-sdk.dev/providers/openai-compatible-providers/nearai): provider, live model IDs and integration code.
- [IronClaw](https://github.com/nearai/ironclaw): NEAR AI's agent runtime. A future guarded-agent integration.

**Competitive landscape**

- [Antibody PR #66](https://github.com/Himess/antibody/pull/66): competing hackathon entry (exploit bounties). Check the #NEARHackathon feed for others before submitting.
- [Forta](https://forta.org), [OpenZeppelin Defender](https://www.openzeppelin.com/defender), [Hypernative](https://www.hypernative.io) and [Hexagate](https://www.hexagate.com): EVM runtime monitors to benchmark features and pricing against. Check each one's current status and NEAR support.

**Ecosystem and community**

- [NEAR governance forum](https://gov.near.org): post for design-partner feedback, as the 54-agents builder did.
- [NearBlocks](https://nearblocks.io): explorer for checking replayed incidents and testnet demos.
- [NEAR hackathon prompt examples](https://github.com/nearai/near-hackathon-prompt-examples): official track prompts.

## INTEGRATIONS

These are the 17 ecosystem partners and per-track integration hints listed on [nearhackathon.com](https://nearhackathon.com/). Partners that fit Qorvex are listed first. A participant's summary of HACKATHON.md says no integration is mandatory; confirm this in the rules.

**Ecosystem partners**

| Partner | What it is | Website | Docs | Code / API | Fit for Qorvex |
| --- | --- | --- | --- | --- | --- |
| NEAR Intents | Cross-chain execution | [intents.near.org](https://intents.near.org/) | [docs](https://docs.near-intents.org/) | [GitHub](https://github.com/near/intents) | Primary read-only watch target; the reference incident |
| Trezu | Multisig treasury for Web3 teams | [trezu.org](https://trezu.org/) | [docs](https://github.com/NEAR-DevHub/trezu-docs) | [GitHub](https://github.com/NEAR-DevHub/trezu) | Relayer `check()` and spend limits; first design partner |
| NEAR Business | Confidential multisig treasury | [business.near.com](https://business.near.com/) | [docs](https://docs.business.near.com/) |  | Shares Trezu's sponsor relayer, so the same SDK applies |
| SputnikDAO | DAO infrastructure | [X](https://x.com/SputnikDAO) | [setup](https://github.com/near-daos/sputnik-dao-contract#setup) | [GitHub](https://github.com/near-daos/sputnik-dao-contract) | Guardian role; DAO-controlled unpause and limit changes |
| NEAR.AI | Private AI | [near.ai](https://near.ai/) | [docs](https://docs.near.ai/) | [GitHub](https://github.com/nearai/cloud-api) | Model provider for rule drafting and explanations (A1) |
| OutLayer | Secure transactions for AI agents | [outlayer.ai](https://outlayer.ai/) | [docs](https://app.outlayer.ai/docs/getting-started) | [GitHub](https://github.com/out-layer/outlayer) | Option for an attested watcher (L1) |
| Rhea | DeFi on NEAR | [rhea.finance](https://rhea.finance/) | [guide](https://guide.rhea.finance/) | [GitHub](https://github.com/rhea-finance) | DeFi contracts to protect; design-partner candidate |
| meme.cooking | Memecoin launchpad | [meme.cooking](https://meme.cooking/) | [docs](https://docs.meme.cooking/) | [API](https://api.meme.cooking/) | Holds deposits during launches; possible protected contract |
| Agent Market | Marketplace for AI agents | [market.near.ai](https://market.near.ai/) | [docs](https://docs.market.near.ai/) | [API](https://market.near.ai/docs/) | Later: spending limits for agent wallets |
| HOT | Chain abstraction | [hot-labs.org](https://hot-labs.org/) | [docs](https://docs.hotdao.ai/) | [GitHub](https://github.com/hot-dao) | Later: cross-chain targets |
| HEX | Cross-chain swaps | [hex.exchange](https://hex.exchange/) | [docs](https://hot-labs.gitbook.io/hex/concepts-and-systems/interactive-blocks) |  | Later: cross-chain targets |
| Aurora | Ethereum on NEAR | [aurora.dev](https://aurora.dev/) | [docs](https://doc.aurora.dev/) | [GitHub](https://github.com/aurora-is-near) | EVM contracts are out of scope for v1 |
| NEAR Builders | Builder community | [nearbuilders.org](https://nearbuilders.org/) | [build](https://nearbuilders.org/build) | [GitHub](https://github.com/nearbuilders) | Feedback and early users |
| SVRN | Sovereign technology | [svrn.net](https://svrn.net/) | [research](https://svrn.net/research/near-protocol) |  |  |
| GoMining | Bitcoin mining superapp | [gomining.com](https://gomining.com/) | [docs](https://docs.gomining.com/) |  |  |
| Gulf Labs | Invests in blockchain infrastructure | [gulf-labs.com](https://gulf-labs.com/) |  |  | Possible investor after the hackathon |
| BRRRAIN | Memecoin with AI rewards | [brrrain.fun](https://brrrain.fun/) | [docs](https://brrrain.fun/docs/) | [API](https://brrrain.fun/docs/api/) |  |

**Per-track integration hints**

Each track's AI prompt is in the official [prompt examples repository](https://github.com/nearai/near-hackathon-prompt-examples). Qorvex's tracks are 06, 01 and 12.

| Track | Integration hints | Prompt |
| --- | --- | --- |
| 06 AI Security & Defense | Agent security, function call keys, TEE attestation | [06-security](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/06-security.md) |
| 01 Unstoppable DeFi | NEAR Intents, Chain Signatures | [01-defi](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/01-defi.md) |
| 12 Social Money | Sputnik DAO, Trezu, named accounts | [12-social](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/12-social.md) |
| 02 Investment Thesis | Onchain data, dashboards, research | [02-thesis](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/02-thesis.md) |
| 03 Privacy & Private AI | Private AI, TEE, NEAR AI Cloud | [03-privacy](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/03-privacy.md) |
| 04 Autonomous Business | AI agents, NEAR Intents, Chain Signatures | [04-business](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/04-business.md) |
| 05 AI Swarms | Multi-agent systems, NEAR Intents, sub-accounts | [05-swarms](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/05-swarms.md) |
| 07 Agent Economy | Agent commerce, NEAR Intents, Chain Signatures | [07-agents](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/07-agents.md) |
| 08 Real-World Money | Stablecoins, NEAR Intents, meta transactions | [08-realworld](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/08-realworld.md) |
| 09 Games With Real Economies | Agent NPCs, social login, NEAR Intents, NEP-245 | [09-games](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/09-games.md) |
| 10 NFTs That Do Something | Dynamic NFTs, NEP-171, sub-accounts | [10-nfts](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/10-nfts.md) |
| 11 Memecoins With Mechanics | Memecoins, token mechanics, NEP-141 | [11-memecoins](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/11-memecoins.md) |
| 13 Open Innovation | Chain abstraction, experimental | [13-open](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/13-open.md) |
