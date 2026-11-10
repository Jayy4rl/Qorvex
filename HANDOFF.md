# Qorvex: handoff notes (state as of 2026-11-10)

For the next engineer or AI agent picking this up. Read this first, then `README.md`, `HACKATHON.md` (hackathon rules) and `Qorvex — Product Requirement.md` (the PRD, which is the source of truth for scope).

## Hard constraints

- **Deadline: 2026-11-14T23:59Z.** The repo must be public by then, and the submission goes in once (`HACKATHON.md` §3).
- **Never without the user's explicit yes** (`HACKATHON.md`): sending the submission (print the full JSON first), posting on X, making the repo public, force-pushing, signing transactions on testnet or mainnet, spending tokens, deploying to mainnet, committing secrets. Normal pushes to `main` were authorised on 2026-11-10.
- **Secrets** live only in `.env` (git-ignored, chmod 600). It holds `NEARAI_API_KEY` (a NEAR Builders $10-credit key that works with `https://cloud-api.near.ai/v1`). Sandbox and testnet keys go to `data/` (git-ignored). Never print or commit them.
- Tracks per the PRD: `security` (primary), `defi`, `social`.

## What Qorvex is

Spending limits and circuit breakers for NEAR. Five parts:

| Part | Code | Status |
| --- | --- | --- |
| `qorvex-guard` Rust crate: per-token outflow caps, self-accounting check that pauses in the same transaction, guardian-only pause | `contracts/qorvex-guard` | Done, unit + e2e tested |
| Guardian contract: watchers call `pause(target, rule_id, evidence_hash)`; records it on-chain, forwards it; 1 pause/hour unless the council allows another | `contracts/guardian` | Done, tested |
| Watcher: block stream → rule evaluation → confirmation read → pause via guardian (pause-only function-call key) → alerts → breach log | `src/watcher`, `src/stream`, `src/executor`, `src/alerts` | Done, tested |
| **Proposal firewall** (newest work): Qorvex joins a Sputnik DAO as a one-member role with only `transfer:VoteReject` + `call:VoteReject`; votes to reject proposals that break a `proposal_policy` rule. The DAO is also the council (only a DAO vote unpauses) | `src/firewall/*`, `src/watcher/watcher.ts` (scanProposals), `src/demo/actions.ts` | Done, tested on the exact mainnet Sputnik code |
| Relayer SDK: `check(beneficiary, action, cost)` budgets + `checkProposal(dao, proposal)` before sponsoring a DAO approval vote | `src/relayer`, `mock-relayer/relayer.ts` | Done, tested |
| AI (NEAR AI Cloud, open-weight Qwen): drafts rules (validated + backtested before a human sees them), explains incidents and flagged proposals | `src/ai` | Done; **real Qwen responses recorded** in `fixtures/ai` |
| Console + public status pages (every number links to the raw RPC read) | `web/`, `src/server` | Done (checked in jsdom; no real browser available here) |

Demo contracts: `contracts/demo-ledger` (deliberately vulnerable: the NEAR Intents "refund after credit" bug), `contracts/demo-token` (NEP-141). Built wasm is committed in `contracts/wasm/`. The Sputnik DAO wasm in `contracts/vendor/sputnikdao2-v2.3.1.wasm` was fetched from mainnet and its sha256 matches global code hash `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF` (what `sputnik-dao.near` deploys).

## How to run

```
npm ci
npm run demo -- --auto --exit   # ~5-6 min: sandbox + all contracts + every replay, prints a summary
npm test                        # unit + e2e (e2e spins up its own sandbox, ~4 min)
cd contracts && cargo test      # 28 contract unit tests
npm run firewall:replay         # read-only: firewall policy vs the real Trezu-drain DAO on mainnet
npm run build:contracts         # needs Rust + cargo-near (installed here via `cargo install --locked cargo-near`)
```

AI mode comes from `QORVEX_AI_MODE` (`.env` says `replay`): `replay` uses only `fixtures/ai`, `record` calls NEAR AI and rewrites fixtures, `live` calls without saving. Fixture keys = job + model + contract + code hash + source digest + attempt. **Editing `contracts/demo-ledger/src/lib.rs` or `contracts/qorvex-guard/src/lib.rs` changes the digest of the uploaded source and invalidates the ledger/vault draft fixtures** (re-record with `QORVEX_AI_MODE=record npm run demo -- --auto --exit`, cost: cents).

## Verified results (sandbox, nearcore 2.13.4)

- **Watcher pause (Intents ghost-balance replay):** breach at block N, ledger paused at N+4, ~3 s. PRD target is 3 blocks; the extra block is ingest lag (block reaches the watcher ~0.6-0.74 s after production). Breakdown is printed as a `timeline:` line.
- **Self-accounting:** the guarded vault pauses inside the ghost-deposit transaction itself.
- **Trezu sponsor drain:** without Qorvex 100 sponsored `storage_deposit`s (0.6 → 0.406 NEAR); with `check()` 8 allowed, 92 refused.
- **Firewall:** an over-cap 200k USDC transfer proposal and a 100×`ft_transfer` call proposal were each rejected **3 blocks after submission**, then the council could not approve (`ERR_PROPOSAL_NOT_READY_FOR_VOTE`). A legitimate invoice passed untouched. The firewall key cannot approve.
- **Mainnet evidence** (`fixtures/replays/rawwheat-audit1.sputnik-dao.near.json`): the DAO used in Trezu #1871 has 30 proposals. A default policy flags 16; 9 of those were approved 5-9 blocks after submission (so a 3-block veto fits).
- **Relayed vote on an attacker-owned DAO:** without Qorvex the sponsor relays and pays for 50 registrations (0.459 → 0.340 NEAR); with `checkProposal()` it refuses before spending.
- **Real Qwen drafting** (`Qwen/Qwen3.8-27B`): correct solvency + outflow rules for the ledgers; for the DAO a policy with a 50,000 USDC cap (10% of holdings) and calls only to the vault.
- **Last full green run:** 42 unit tests, 16 e2e tests, 28 Rust tests. **The final changes since then were NOT re-verified** (see below).

## Not yet verified after the last edits (do this first)

The last command (replay-mode demo + full test suite) was interrupted. The changes made since the last green run:

- the DAO drafting context (FastNEAR token holdings, past proposals) and prompt tweaks in `src/ai/inputs.ts` and `src/ai/drafter.ts`
- the explanation prompts in `src/ai/explain.ts`
- the plain-units caps (`src/firewall/humanize.ts`, used by the API and console)
- the operator-review step in `scripts/demo.ts`
- the `.gitignore` vendor exception

Run:
1. `npm run typecheck`
2. `npm run demo -- --auto --exit`. Expect lines like `AI drafted ... (replay)` and the three `Qorvex voted VoteReject` / invoice / relay lines.
3. `npm test`
4. `cd contracts && cargo test`

## Remaining work (priority order)

1. **README:** document the proposal firewall and DAO-as-council. The README predates them. Add:
   - what it is, the trust argument (Sputnik counts votes per role; a one-member reject-only role is a veto that can never approve)
   - try-it steps (console demo buttons under "Treasury DAO" and "Relayed approval")
   - the mainnet replay evidence and its known limits (below)
   - requirement coverage: D2 treasury-transfer policy is now done
   - models now `Qwen/Qwen3.8-27B` (draft) and `Qwen/Qwen3.6-35B-A3B-FP8` (explain), with fallbacks `qwen/qwen3.5-397b-a17b` (upstream 429s on 2026-11-10) and `z-ai/glm-5.3`; Qwen needs `chat_template_kwargs.enable_thinking=false`
   - fixtures are recorded
   - test counts
2. **Testnet deployment (needs the user's yes plus funds):** `npm run deploy:testnet` (dry run) then `-- --yes`. The world now includes 2 Sputnik DAOs (~4.5 NEAR of storage each), so budget about 30 testnet NEAR. `scripts/deploy-testnet.ts` balances must be updated for the new accounts (`firewall`, `treasury`, `malloryDao`) and must print `QORVEX_TESTNET_FIREWALL_ACCOUNT` / `QORVEX_TESTNET_FIREWALL_KEYS`. Then measure pause latency and firewall latency on testnet (neardata stream; use `QORVEX_TESTNET_STREAM=rpc` if neardata rate-limits).
3. **Mainnet Intents read-only page:** `QORVEX_NETWORKS=mainnet npm start` + `npm run seed:intents`. The 30-day archival backtest stalled on HTTP 429 from `archival-rpc.mainnet.near.org`. It resumes from `data/mainnet/cache` (git-ignored), or set a paid archival endpoint in `QORVEX_MAINNET_ARCHIVAL_RPC`.
4. **Demo video script + X post draft** (the user records and posts), then **submission payload** for the user's review: project name, lead name, email, team size, tracks, mainnet payout account, repo URL, X post URL, idea text, consent. Ask the user for every value.
5. **Make the repo public:** the user's action/confirmation.
6. Nice to have:
   - in-browser wallet signing (near-connect) for the guardian and firewall onboarding transactions
   - a language-agnostic `POST /api/relayers/:id/check` endpoint for non-JS relayers (Trezu's backend is Rust)
   - Intents rules for every token via `mt_tokens`
   - an OutLayer-held watcher key (TEE)
   - an Agent Market listing

## Known limitations to keep stating honestly

- **Pause latency:** the watcher takes 4 blocks, not 3 (ingest lag).
- **Instant self-approvals:** single-member DAOs that self-approve within ~3 blocks can beat the firewall. The relayer `checkProposal()` covers the sponsored case. One firewall reject rejects a proposal only because the role is its own one-member group.
- **The firewall governs only transfer and FunctionCall proposals.** Governance changes are alert-only, including the proposal that adds the firewall role itself, which shows up as an alert.
- **AI output is advisory and was observed to be wrong at times:**
  - unit slips in `explain` sentences (e.g. "8 NEAR" for a 0.8 NEAR cap); the console shows caps in plain units for review
  - explanations guessing causes; the prompts were tightened
  - Humans approve every rule.
- **Public endpoint limits:**
  - free neardata.xyz and the archival RPC rate-limit (429)
  - `qwen/qwen3.5-397b-a17b` was rate-limited upstream
- **Single process:** the JSON store and per-process relayer history.
- **Mainnet backtest:** not completed.

## Gotchas found while building

- `pkill -f <pattern>` matches the invoking shell's own command line; kill by PID instead.
- The machine has ~7 GB RAM. Building cargo-near while a sandbox runs got a process OOM-killed.
- Sputnik `act_proposal` must be given the proposal's exact `kind` (read it with `get_proposal`). It takes no deposit, so a function-call key works.
- A guardian `pause_history` record turns `Paused` only one block after the target paused (callback); read with optimistic finality or poll.
- Sandbox RPC: query `block_id` reads may 404 just after production; the watcher falls back to `finality: optimistic`.
