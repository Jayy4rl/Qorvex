import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { WalletError } from "../lib/wallet";
import { describeError, errorText, pauseReason, UserFacingError } from "../lib/errors";

vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "info").mockImplementation(() => {});

const TECHNICAL = /\bHTTP\b|\b[45]\d\d\b|Bearer|QORVEX_|Authorization|x-qorvex|NEP-413|RPC|JSON body|\(contract\.watch\)/;

describe("on-screen error messages", () => {
  const cases: [number, string, string | undefined][] = [
    [401, "sign in, or send Authorization: Bearer <QORVEX_ADMIN_TOKEN>", "SIGN_IN_REQUIRED"],
    [403, "your role in this workspace cannot do this (contract.watch)", "ROLE_FORBIDDEN"],
    [403, "cross-site request refused: this page is on http://x, but ...", "CROSS_SITE"],
    [403, "this needs verified on-chain authority over the contract: claim it first (Claims)", "NEEDS_CLAIM"],
    [409, "no recorded NEAR AI response for this request (abc.json). Set NEARAI_API_KEY and QORVEX_AI_MODE=record", "AI_NOT_RECORDED"],
    [400, "network testnet is not enabled on this server (QORVEX_NETWORKS)", "NETWORK_UNAVAILABLE"],
    [503, "Could not reach the NEAR RPC to check the key.", "NEAR_RPC"],
    [401, "Invalid email or password", "INVALID_EMAIL_OR_PASSWORD"],
    [502, "Bad Gateway", undefined],
    [500, "TypeError: cannot read properties of undefined", "SERVER_ERROR"],
    [0, "Could not reach the Qorvex server.", undefined],
    [418, "something odd", undefined],
  ];
  for (const [status, raw, code] of cases) {
    it(`${status} ${code ?? "(no code)"} reads as plain language`, () => {
      const m = errorText(new ApiError(status, raw, undefined, code));
      expect(m).not.toMatch(TECHNICAL);
      expect(m.length).toBeGreaterThan(15);
    });
  }

  it("keeps the specifics people can act on, in plain words", () => {
    const d = describeError(new ApiError(400, "rule failed validation", { errors: ["id must match ^[a-z0-9][a-z0-9_.:-]{0,63}$"] }, "RULE_INVALID"));
    expect(d.message).toBe("This rule isn't valid yet.");
    expect(d.details?.[0]).toMatch(/lowercase letters/);
    expect(errorText(new ApiError(400, "token must be a NEP-141 contract id or near", undefined, "TEMPLATE_INVALID"))).toBe("Token must be a NEP-141 contract id or near.");
    expect(errorText(new ApiError(403, "none of your NEAR accounts controls this contract", { hint: "Sign with an account on the DAO's council." }, "NOT_CONTROLLER"))).toMatch(/DAO's council/);
  });

  it("shows wallet and hand-written messages as they are", () => {
    expect(errorText(new WalletError("You cancelled the request in your wallet."))).toBe("You cancelled the request in your wallet.");
    expect(errorText(new UserFacingError("That operator token isn't right."))).toBe("That operator token isn't right.");
  });

  it("explains skipped pauses without internals", () => {
    expect(pauseReason("no pause key loaded for guardian guardian.x.testnet", "failed")).not.toMatch(/guardian\.x/);
    expect(pauseReason("contract had already paused itself (in-contract guard)", "skipped")).toBe("the contract had already paused itself");
  });
});
