/**
 * Every error the web app shows goes through `describeError`, so people see a
 * plain sentence about what happened and what to do, never HTTP status codes,
 * header names or server configuration.
 *
 * The server tags errors with a `code` (backend/src/server/http.ts); Better
 * Auth and the NEAR sign-in plugin send their own codes. Unknown errors fall
 * back to a sentence chosen by status.
 */
import { ApiError } from "./api";
import { WalletError } from "./wallet";

export interface Described {
  message: string;
  /** Specific problems the person can fix (e.g. which rule field is wrong). */
  details?: string[];
}

const MESSAGES: Record<string, string> = {
  // Session and access
  SIGN_IN_REQUIRED: "You're signed out. Sign in again to continue.",
  USER_ACCOUNT_REQUIRED: "Sign in with your own account (wallet or email) to do this.",
  NO_WORKSPACE: "Choose or create a workspace first.",
  ROLE_FORBIDDEN: "Your role in this workspace doesn't allow this. Ask a workspace owner or admin.",
  FORBIDDEN: "You don't have permission to do this.",
  CROSS_SITE: "This page is open at a different address than the Qorvex app. Open the app from its main address and try again.",
  AUTH_UNAVAILABLE: "Sign-in isn't available on this server.",
  // Contracts and claims
  INVALID_NETWORK: "Choose mainnet or testnet.",
  INVALID_ACCOUNT: "That isn't a valid NEAR account name. It looks like name.near or name.testnet.",
  CONTRACT_UNREADABLE: "Couldn't find that account on the selected network. Check the name and the network.",
  NO_CONTRACT: "That account has no contract deployed.",
  NETWORK_UNAVAILABLE: "This Qorvex server isn't set up for that network.",
  NEEDS_CLAIM: "First prove that you control this contract: claim it from the contract check page.",
  NOT_CONTROLLER: "None of your NEAR accounts controls this contract.",
  CLAIMED_ELSEWHERE: "Another team has already verified this contract, so its public page belongs to them. You can still watch it privately.",
  NO_GUARDIAN: "Automatic pausing isn't set up on this server for that network yet.",
  READONLY_PAGE: "This is a read-only page built from public data, so its rules can only send alerts.",
  STATUS_NOT_FOUND: "This status page doesn't exist or isn't public.",
  // Rules
  RULE_INVALID: "This rule isn't valid yet.",
  TEMPLATE_INVALID: "Some template fields need fixing.",
  RULE_EXISTS: "A rule with this name already exists. Give it another id.",
  WRONG_RESPONSE: "That response doesn't fit this kind of rule.",
  BACKTEST_REQUIRED: "Run the backtest before approving this rule.",
  BACKTEST_FIRED: "This rule fired in its backtest, so it can only be approved as alert-only. A rule that pauses must never have fired on past data.",
  NO_LIVE_VALUE: "Only solvency rules have a live value.",
  SOURCE_EMPTY: "Choose at least one source file to upload.",
  AI_NOT_RECORDED: "AI drafting isn't available for this contract on this server. Start from a template or write the rule by hand.",
  NOT_A_DAO: "The proposal firewall is only for Sputnik DAOs.",
  NO_FIREWALL: "The proposal firewall isn't set up on this server.",
  BUDGET_INVALID: "Some budget settings need fixing.",
  APIKEY_INVALID: "Give the key a name and choose at least one permission.",
  DEMO_ONLY: "This only works in the local demo.",
  // Wallet sign-in (NEAR plugin)
  NEAR_NONCE: "That sign-in request expired. Try again.",
  NEAR_SIGNATURE: "The wallet's signature didn't match this sign-in request. Try again.",
  NEAR_KEY: "Your wallet signed with a limited key. NEAR sign-in needs a full-access key: use a wallet that holds one, or sign in with email.",
  NEAR_RPC: "Couldn't reach the NEAR network to check your wallet. Nothing was changed; try again in a moment.",
  NEAR_ACCOUNT: "That NEAR account isn't linked to your Qorvex account. Link it first.",
  NEAR_BINDING: "That signature was for a different action. Try again.",
  STEP_UP_REQUIRED: "Confirm this action with your wallet.",
  // Email sign-in (Better Auth)
  INVALID_EMAIL_OR_PASSWORD: "That email and password don't match.",
  USER_ALREADY_EXISTS: "An account with this email already exists. Sign in instead.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "An account with this email already exists. Sign in instead.",
  INVALID_EMAIL: "Enter a valid email address.",
  PASSWORD_TOO_SHORT: "Use a password of at least 12 characters.",
  PASSWORD_TOO_LONG: "That password is too long.",
  INVALID_PASSWORD: "That password isn't correct.",
  // General
  RATE_LIMITED: "Too many attempts. Wait a few minutes and try again.",
  BUSY: "Qorvex is busy right now. Try again in a moment.",
  TOO_LARGE: "That's too large to upload.",
  NOT_FOUND: "We couldn't find that. It may have been removed.",
  SERVER_ERROR: "Something went wrong on our side. Try again in a moment.",
};

/** Rule-validator messages, rewritten in plain words where they mention formats. */
function friendlyDetail(d: string): string {
  return d
    .replace(/^id must match .*$/, "The rule id can only use lowercase letters, digits and . _ : - (up to 64 characters).")
    .replace(/^explain must be .*$/, "Describe the rule in one plain sentence (10 to 300 characters).")
    .replace(/must be a decimal integer string \(smallest units\)/, "must be a whole number in the token's smallest units")
    .replace(/must be a decimal string/, "must be a whole number")
    .replace(/must be a NEAR account id/, "must be a NEAR account name (like name.near)")
    .replace(/window_sec must be an integer between 1 and 2592000/, "The time window must be between 1 second and 30 days.");
}

export function describeError(e: unknown): Described {
  // The screen gets a plain sentence; the browser console keeps every technical detail.
  if (e instanceof ApiError) console.error(`[qorvex] HTTP ${e.status}${e.code ? ` ${e.code}` : ""}: ${e.message}`, e.details ?? "");
  else console.error("[qorvex]", e);
  if (e instanceof WalletError || e instanceof UserFacingError) return { message: e.message };
  if (e instanceof ApiError) {
    const details = Array.isArray(e.details?.errors) ? (e.details.errors as string[]).map(friendlyDetail) : undefined;
    // Server messages that already speak to the person and carry the specifics (which field, how many fires, what to sign with).
    if (e.code === "TEMPLATE_INVALID" || (e.code === "BAD_REQUEST" && e.status === 400 && /^(token|window|view arguments|max actions|"[^"]+" is not an amount)/.test(e.message)))
      return { message: capitalise(e.message) + ".", details };
    if (e.code === "NOT_CONTROLLER" && e.details?.hint) return { message: `${MESSAGES.NOT_CONTROLLER} ${e.details.hint}`, details };
    if (e.code && MESSAGES[e.code]) return { message: MESSAGES[e.code], details };
    if (e.status === 0) return { message: "Can't reach Qorvex right now. Check your connection and try again." };
    if (e.status === 401) return { message: MESSAGES.SIGN_IN_REQUIRED };
    if (e.status === 403) return { message: MESSAGES.FORBIDDEN };
    if (e.status === 404) return { message: MESSAGES.NOT_FOUND };
    if (e.status === 429) return { message: MESSAGES.RATE_LIMITED };
    if (e.status >= 500) return { message: e.status === 502 || e.status === 503 ? "Qorvex is restarting or briefly unavailable. Try again in a minute." : MESSAGES.SERVER_ERROR };
    return { message: "That didn't work. Check what you entered and try again.", details };
  }
  return { message: MESSAGES.SERVER_ERROR };
}

/** One line for places that show a single string. */
export function errorText(e: unknown): string {
  const d = describeError(e);
  return d.details?.length ? `${d.message} ${d.details.join(" ")}` : d.message;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** An error whose message was written for the person reading the screen. */
export class UserFacingError extends Error {}

/** Why an automatic pause did not happen, in plain words (the raw reason goes to the console). */
export function pauseReason(error: string | undefined, status?: string): string {
  if (error) console.info("[qorvex] pause outcome:", status, error);
  if (!error) return status === "sending" ? "the pause is being sent" : status === "failed" ? "the pause transaction failed" : "no pause was sent";
  if (/alert-only/.test(error)) return "this rule only sends alerts";
  if (/already paused itself/.test(error)) return "the contract had already paused itself";
  if (/no guardian authorised|has no guardian/.test(error)) return "automatic pause isn't authorised for this contract yet";
  if (/no pause key|pause key/.test(error)) return "this server isn't set up to send pauses on that network";
  if (/authority/.test(error)) return "your team's control of this contract isn't verified, so Qorvex only alerted";
  if (/less than an hour ago|cooldown/.test(error)) return "it was already paused within the last hour (the council must allow another pause)";
  return "the pause transaction failed";
}
