# @qorvex/relayer-sdk

Spending limits for NEAR gas relayers and payout services. Ask Qorvex before you sign; it answers from budgets you set in the Qorvex console, against one spend history shared by every instance of your relayer.

```sh
npm install @qorvex/relayer-sdk
```

```ts
import { Qorvex } from "@qorvex/relayer-sdk";

const qorvex = new Qorvex({
  url: process.env.QORVEX_URL!,               // https://qorvexbackend-production.up.railway.app, or your own server
  relayerId: process.env.QORVEX_RELAYER_ID!,  // from the console
  token: process.env.QORVEX_RELAYER_TOKEN!,   // shown once when the relayer is created
  // Optional: keep sponsoring tiny gas fees during a Qorvex outage, up to a local cap.
  whenUnreachable: { failOpenBelow: "5000000000000000000000", localCap: "100000000000000000000000" },
});

const d = await qorvex.check({ beneficiary: daoId, action: "storage_deposit", cost: depositYocto, receiver: tokenId });
if (!d.allow) return refuse(d.reason); // e.g. "count cap: 10 storage_deposit already sponsored for x.sputnik-dao.near in 86400s (max 10)"
await signAndSend();
```

- `check()` never throws on network errors. When Qorvex is unreachable it fails closed, unless the call costs at most `failOpenBelow` and this process has allowed less than `localCap` in the current window.
- `checkProposal(dao, proposal)` checks a DAO proposal against your relayer's proposal policy before you sponsor an approval vote (the Trezu #1871 drain). It fails closed when Qorvex is unreachable.
- Every decision, allowed or refused, is logged in the console with its reason.

Zero dependencies; Node 18+ or any runtime with `fetch`.
