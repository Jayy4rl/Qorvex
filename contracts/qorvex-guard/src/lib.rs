//! # qorvex-guard
//!
//! In-contract protection for NEAR contracts that hold user funds.
//!
//! * **Outflow caps (P1, P2).** Per-token, per-time-window caps on outflows.
//!   An outflow that would exceed the cap is rejected (the call panics, so
//!   nothing moves). Caps live in contract state and only the owner (an
//!   account or a DAO) can change them, with a 1 yoctoNEAR deposit so that no
//!   function-call access key can ever call the setter.
//! * **Self-accounting check (P3).** The guard keeps its own tally, per token,
//!   of deposits the contract actually kept, of outflows it sent and of what
//!   it credited to users. After every state change it checks
//!   `credited <= pending_in + confirmed_in - out`. If that breaks, the guard
//!   **pauses the contract and returns normally** instead of panicking, so the
//!   pause survives in the same receipt and the outflow is never made.
//! * **Guardian-only pause.** `pause` is accepted only from the configured
//!   guardian account (the Qorvex guardian contract). Unpausing stays with the
//!   owner.
//!
//! The guard never holds or moves funds. The host contract keeps doing that;
//! it reports deposits, credits, debits and outflows to the guard through the
//! hooks below.
//!
//! ## Async deposits
//!
//! NEAR deposits through `ft_transfer_call` are asynchronous: the receiver may
//! credit a user in `ft_on_transfer` and only learn later (in a callback) how
//! much the token contract will refund. The guard therefore tracks deposits in
//! two steps: [`Guard::begin_deposit`] (counted as *pending* backing) and
//! [`Guard::settle_deposit`] (pending becomes *confirmed* minus the refund).
//! A credit that outlives its refund, which is the NEAR Intents
//! "refund after credit" bug of Sep 29 to Oct 1 2026, breaks the invariant at
//! settlement and trips the pause in that same receipt.

use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, IntoStorageKey, NearToken};

/// NEP-297 event standard name emitted by the guard.
pub const EVENT_STANDARD: &str = "qorvex_guard";
/// NEP-297 event version.
pub const EVENT_VERSION: &str = "1.0.0";

/// An outflow cap for one token.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limit {
    /// Maximum amount (in the token's smallest unit) that may leave per window.
    pub cap: U128,
    /// Window length in seconds. Usage resets when a window has elapsed.
    pub window_sec: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
struct Usage {
    window_start_ns: u64,
    used: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
struct Tally {
    /// Deposits begun but not yet settled (refund not known yet).
    pending_in: u128,
    /// Deposits the contract kept after any refund.
    confirmed_in: u128,
    /// Outflows sent (and not reverted).
    out: u128,
    /// Net amount credited to users (credits minus debits).
    credited: u128,
}

impl Tally {
    fn backing(&self) -> u128 {
        (self.pending_in + self.confirmed_in).saturating_sub(self.out)
    }
}

/// Why and when the contract was paused.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PauseInfo {
    pub reason: String,
    /// Account that caused the pause, or the contract itself for a self-trip.
    pub by: AccountId,
    pub block_height: u64,
    pub timestamp_ns: u64,
}

/// JSON view of one token's limit and current window usage.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LimitView {
    pub token_id: AccountId,
    pub cap: U128,
    pub window_sec: u64,
    pub used_in_window: U128,
    pub window_start_ns: u64,
}

/// JSON view of one token's self-accounting tally.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TallyView {
    pub token_id: AccountId,
    pub pending_in: U128,
    pub confirmed_in: U128,
    pub out: U128,
    pub credited: U128,
    /// `pending_in + confirmed_in - out`: what the credits must not exceed.
    pub backing: U128,
}

/// JSON view of the whole guard.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuardStatus {
    pub owner: AccountId,
    pub guardian: Option<AccountId>,
    pub self_accounting: bool,
    pub paused: Option<PauseInfo>,
    pub limits: Vec<LimitView>,
    pub tallies: Vec<TallyView>,
}

/// Result of [`Guard::begin_outflow`].
#[must_use = "on Outflow::Tripped the caller must return without sending funds"]
#[derive(Debug, PartialEq, Eq)]
pub enum Outflow {
    /// The outflow is within limits and the books balance: send it.
    Allowed,
    /// The self-accounting check failed. The guard has paused the contract.
    /// Return without sending anything and **do not panic**, or the pause is
    /// rolled back with the rest of the receipt.
    Tripped,
}

/// The guard. Embed it in your contract state.
#[near(serializers = [borsh])]
pub struct Guard {
    owner: AccountId,
    guardian: Option<AccountId>,
    self_accounting: bool,
    paused: Option<PauseInfo>,
    limits: IterableMap<AccountId, Limit>,
    usage: IterableMap<AccountId, Usage>,
    tally: IterableMap<AccountId, Tally>,
}

fn sub_prefix(prefix: &[u8], tag: u8) -> Vec<u8> {
    let mut p = prefix.to_vec();
    p.push(tag);
    p
}

fn emit(event: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{EVENT_STANDARD}\",\"version\":\"{EVENT_VERSION}\",\"event\":\"{event}\",\"data\":[{data}]}}"
    ));
}

impl Guard {
    /// Create a guard. `prefix` must not collide with other storage prefixes
    /// in the host contract. With `self_accounting = false` the tally is still
    /// kept (and visible in views) but never trips the pause; caps and the
    /// guardian pause still apply.
    pub fn new<S: IntoStorageKey>(
        prefix: S,
        owner: AccountId,
        guardian: Option<AccountId>,
        self_accounting: bool,
    ) -> Self {
        let prefix = prefix.into_storage_key();
        Self {
            owner,
            guardian,
            self_accounting,
            paused: None,
            limits: IterableMap::new(sub_prefix(&prefix, b'l')),
            usage: IterableMap::new(sub_prefix(&prefix, b'u')),
            tally: IterableMap::new(sub_prefix(&prefix, b't')),
        }
    }

    // ---------------------------------------------------------------- access

    pub fn owner(&self) -> &AccountId {
        &self.owner
    }

    pub fn guardian(&self) -> Option<&AccountId> {
        self.guardian.as_ref()
    }

    pub fn is_paused(&self) -> bool {
        self.paused.is_some()
    }

    pub fn pause_info(&self) -> Option<&PauseInfo> {
        self.paused.as_ref()
    }

    /// Panics if the contract is paused. Call it at the top of every method
    /// that moves value out or credits users.
    pub fn assert_not_paused(&self) {
        if let Some(p) = &self.paused {
            env::panic_str(&format!("qorvex-guard: contract is paused ({})", p.reason));
        }
    }

    /// Panics unless the predecessor is the owner and exactly 1 yoctoNEAR is
    /// attached. Function-call access keys cannot attach a deposit, so a
    /// leaked function-call key can never pass this check.
    pub fn assert_owner_one_yocto(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "qorvex-guard: only the owner can do this"
        );
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "qorvex-guard: requires exactly 1 yoctoNEAR attached"
        );
    }

    // ----------------------------------------------------------------- admin

    /// Pause on behalf of the guardian. Only the guardian account may call it.
    /// No deposit is required, so a function-call key can reach it.
    pub fn pause_by_guardian(&mut self, reason: String) {
        let caller = env::predecessor_account_id();
        require!(
            self.guardian.as_ref() == Some(&caller),
            "qorvex-guard: only the guardian can pause"
        );
        if self.paused.is_none() {
            self.set_paused(reason, caller);
        }
    }

    /// Unpause. Owner only, 1 yoctoNEAR.
    pub fn unpause(&mut self) {
        self.assert_owner_one_yocto();
        if self.paused.take().is_some() {
            emit(
                "unpaused",
                format!("{{\"by\":\"{}\"}}", env::predecessor_account_id()),
            );
        }
    }

    /// Set (`Some`) or remove (`None`) the outflow cap for a token.
    /// Owner only, 1 yoctoNEAR. Resets the token's current window usage.
    pub fn set_limit(&mut self, token_id: AccountId, limit: Option<Limit>) {
        self.assert_owner_one_yocto();
        match &limit {
            Some(l) => {
                require!(l.window_sec > 0, "qorvex-guard: window_sec must be > 0");
                self.limits.insert(token_id.clone(), l.clone());
            }
            None => {
                self.limits.remove(&token_id);
            }
        }
        self.usage.remove(&token_id);
        let data = match limit {
            Some(l) => format!(
                "{{\"token_id\":\"{token_id}\",\"cap\":\"{}\",\"window_sec\":{}}}",
                l.cap.0, l.window_sec
            ),
            None => format!("{{\"token_id\":\"{token_id}\",\"cap\":null}}"),
        };
        emit("limit_set", data);
    }

    /// Set the guardian account. Owner only, 1 yoctoNEAR.
    pub fn set_guardian(&mut self, guardian: Option<AccountId>) {
        self.assert_owner_one_yocto();
        self.guardian = guardian;
        let g = self
            .guardian
            .as_ref()
            .map(|g| format!("\"{g}\""))
            .unwrap_or_else(|| "null".into());
        emit("guardian_set", format!("{{\"guardian\":{g}}}"));
    }

    // ------------------------------------------------------ accounting hooks

    /// A deposit of `amount` has arrived (e.g. at the start of
    /// `ft_on_transfer`). It counts as pending backing until settled.
    pub fn begin_deposit(&mut self, token_id: &AccountId, amount: u128) {
        let t = self.tally_mut(token_id);
        t.pending_in += amount;
    }

    /// The deposit is final: `refund` of `amount` goes back to the sender.
    /// Runs the self-accounting check. Returns `false` if it tripped (the
    /// contract is now paused); the caller must still return normally.
    pub fn settle_deposit(&mut self, token_id: &AccountId, amount: u128, refund: u128) -> bool {
        let refund = refund.min(amount);
        let t = self.tally_mut(token_id);
        t.pending_in = t.pending_in.saturating_sub(amount);
        t.confirmed_in += amount - refund;
        self.check(token_id)
    }

    /// `amount` was credited to a user's internal balance.
    pub fn credit(&mut self, token_id: &AccountId, amount: u128) {
        self.tally_mut(token_id).credited += amount;
    }

    /// `amount` was removed from a user's internal balance.
    pub fn debit(&mut self, token_id: &AccountId, amount: u128) {
        let t = self.tally_mut(token_id);
        t.credited = t.credited.saturating_sub(amount);
    }

    /// Run the self-accounting check for one token. If it fails and
    /// self-accounting is on, pause the contract and return `false`.
    pub fn check(&mut self, token_id: &AccountId) -> bool {
        let t = self.tally.get(token_id).cloned().unwrap_or_default();
        let backing = t.backing();
        if t.credited <= backing || !self.self_accounting {
            return true;
        }
        if self.paused.is_none() {
            emit(
                "self_accounting_tripped",
                format!(
                    "{{\"token_id\":\"{token_id}\",\"credited\":\"{}\",\"backing\":\"{backing}\"}}",
                    t.credited
                ),
            );
            self.set_paused(
                format!(
                    "self-accounting: credited {} > backing {backing} for {token_id}",
                    t.credited
                ),
                env::current_account_id(),
            );
        }
        false
    }

    /// Call before sending `amount` of `token_id` out of the contract.
    ///
    /// * Panics if the contract is paused.
    /// * Runs the self-accounting check first. On failure it pauses and
    ///   returns [`Outflow::Tripped`]: return without sending, do not panic.
    /// * Panics if the outflow would exceed the token's cap for the current
    ///   window (nothing has changed yet, so rejecting is safe).
    /// * Otherwise records the usage and the outflow and returns
    ///   [`Outflow::Allowed`].
    pub fn begin_outflow(&mut self, token_id: &AccountId, amount: u128) -> Outflow {
        self.assert_not_paused();
        if !self.check(token_id) {
            return Outflow::Tripped;
        }
        if let Some(limit) = self.limits.get(token_id).cloned() {
            let now = env::block_timestamp();
            let window_ns = limit.window_sec.saturating_mul(1_000_000_000);
            let mut u = self.usage.get(token_id).cloned().unwrap_or_default();
            if u.window_start_ns == 0 || now.saturating_sub(u.window_start_ns) >= window_ns {
                u = Usage { window_start_ns: now, used: 0 };
            }
            let after = u.used + amount;
            if after > limit.cap.0 {
                env::panic_str(&format!(
                    "qorvex-guard: outflow cap exceeded for {token_id}: {} used + {amount} requested > cap {} per {}s",
                    u.used, limit.cap.0, limit.window_sec
                ));
            }
            u.used = after;
            self.usage.insert(token_id.clone(), u);
        }
        self.tally_mut(token_id).out += amount;
        Outflow::Allowed
    }

    /// An outflow recorded by [`Guard::begin_outflow`] failed (e.g. the
    /// `ft_transfer` promise failed) and the funds stayed in the contract.
    pub fn revert_outflow(&mut self, token_id: &AccountId, amount: u128) {
        let t = self.tally_mut(token_id);
        t.out = t.out.saturating_sub(amount);
        if let Some(mut u) = self.usage.get(token_id).cloned() {
            u.used = u.used.saturating_sub(amount);
            self.usage.insert(token_id.clone(), u);
        }
    }

    // ----------------------------------------------------------------- views

    /// Net confirmed deposits for a token: kept deposits minus outflows.
    pub fn confirmed_deposits(&self, token_id: &AccountId) -> u128 {
        self.tally
            .get(token_id)
            .map(|t| t.confirmed_in.saturating_sub(t.out))
            .unwrap_or(0)
    }

    pub fn limits(&self) -> Vec<LimitView> {
        self.limits
            .iter()
            .map(|(token_id, l)| {
                let u = self.usage.get(token_id).cloned().unwrap_or_default();
                LimitView {
                    token_id: token_id.clone(),
                    cap: l.cap,
                    window_sec: l.window_sec,
                    used_in_window: U128(u.used),
                    window_start_ns: u.window_start_ns,
                }
            })
            .collect()
    }

    pub fn status(&self) -> GuardStatus {
        GuardStatus {
            owner: self.owner.clone(),
            guardian: self.guardian.clone(),
            self_accounting: self.self_accounting,
            paused: self.paused.clone(),
            limits: self.limits(),
            tallies: self
                .tally
                .iter()
                .map(|(token_id, t)| TallyView {
                    token_id: token_id.clone(),
                    pending_in: U128(t.pending_in),
                    confirmed_in: U128(t.confirmed_in),
                    out: U128(t.out),
                    credited: U128(t.credited),
                    backing: U128(t.backing()),
                })
                .collect(),
        }
    }

    // -------------------------------------------------------------- internal

    fn tally_mut(&mut self, token_id: &AccountId) -> &mut Tally {
        if !self.tally.contains_key(token_id) {
            self.tally.insert(token_id.clone(), Tally::default());
        }
        self.tally.get_mut(token_id).expect("just inserted")
    }

    fn set_paused(&mut self, reason: String, by: AccountId) {
        let info = PauseInfo {
            reason,
            by,
            block_height: env::block_height(),
            timestamp_ns: env::block_timestamp(),
        };
        emit(
            "paused",
            format!(
                "{{\"by\":\"{}\",\"block_height\":{},\"reason\":{}}}",
                info.by,
                info.block_height,
                near_sdk::serde_json::to_string(&info.reason).unwrap_or_default()
            ),
        );
        self.paused = Some(info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str, deposit: u128, ts_sec: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("ledger.test"))
            .predecessor_account_id(acc(predecessor))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ts_sec * 1_000_000_000)
            .block_height(100 + ts_sec)
            .build());
    }

    fn guard(self_accounting: bool) -> Guard {
        Guard::new(b"g".to_vec(), acc("owner.test"), Some(acc("guardian.test")), self_accounting)
    }

    fn usdc() -> AccountId {
        acc("usdc.test")
    }

    #[test]
    fn normal_deposit_and_withdraw_balance() {
        ctx("usdc.test", 0, 1);
        let mut g = guard(true);
        g.begin_deposit(&usdc(), 100);
        g.credit(&usdc(), 100);
        assert!(g.settle_deposit(&usdc(), 100, 0));
        assert_eq!(g.begin_outflow(&usdc(), 40), Outflow::Allowed);
        g.debit(&usdc(), 40);
        assert!(g.check(&usdc()));
        assert_eq!(g.confirmed_deposits(&usdc()), 60);
        assert!(!g.is_paused());
    }

    #[test]
    fn credit_pending_on_async_deposit_does_not_trip() {
        ctx("usdc.test", 0, 1);
        let mut g = guard(true);
        g.begin_deposit(&usdc(), 100);
        g.credit(&usdc(), 100);
        // Between ft_on_transfer and the resolve callback the credit is backed
        // by the pending deposit.
        assert!(g.check(&usdc()));
        assert!(!g.is_paused());
    }

    #[test]
    fn refund_after_credit_trips_pause_without_panicking() {
        ctx("usdc.test", 0, 1);
        let mut g = guard(true);
        // honest depositor
        g.begin_deposit(&usdc(), 500);
        g.credit(&usdc(), 500);
        assert!(g.settle_deposit(&usdc(), 500, 0));
        // attacker: credited, then fully refunded, credit not removed (the bug)
        g.begin_deposit(&usdc(), 100);
        g.credit(&usdc(), 100);
        let ok = g.settle_deposit(&usdc(), 100, 100);
        assert!(!ok);
        assert!(g.is_paused());
        let info = g.pause_info().unwrap();
        assert_eq!(info.by, acc("ledger.test"));
        assert!(info.reason.contains("credited 600 > backing 500"));
        assert!(get_logs().iter().any(|l| l.contains("self_accounting_tripped")));
    }

    #[test]
    fn tripped_outflow_returns_tripped() {
        ctx("usdc.test", 0, 1);
        let mut g = guard(true);
        g.credit(&usdc(), 10); // credit with no deposit at all
        assert_eq!(g.begin_outflow(&usdc(), 10), Outflow::Tripped);
        assert!(g.is_paused());
    }

    #[test]
    fn self_accounting_off_never_trips() {
        ctx("usdc.test", 0, 1);
        let mut g = guard(false);
        g.credit(&usdc(), 10);
        assert!(g.check(&usdc()));
        assert_eq!(g.begin_outflow(&usdc(), 10), Outflow::Allowed);
        assert!(!g.is_paused());
    }

    #[test]
    #[should_panic(expected = "contract is paused")]
    fn outflow_blocked_while_paused() {
        ctx("guardian.test", 0, 1);
        let mut g = guard(true);
        g.pause_by_guardian("test".into());
        let _ = g.begin_outflow(&usdc(), 1);
    }

    #[test]
    #[should_panic(expected = "only the guardian can pause")]
    fn pause_rejects_non_guardian() {
        ctx("mallory.test", 0, 1);
        let mut g = guard(true);
        g.pause_by_guardian("x".into());
    }

    #[test]
    fn cap_resets_each_window() {
        ctx("owner.test", 1, 1);
        let mut g = guard(true);
        g.set_limit(usdc(), Some(Limit { cap: U128(100), window_sec: 60 }));
        g.begin_deposit(&usdc(), 1000);
        g.credit(&usdc(), 1000);
        assert!(g.settle_deposit(&usdc(), 1000, 0));
        assert_eq!(g.begin_outflow(&usdc(), 60), Outflow::Allowed);
        g.debit(&usdc(), 60);
        assert_eq!(g.begin_outflow(&usdc(), 40), Outflow::Allowed);
        g.debit(&usdc(), 40);
        // next window
        ctx("alice.test", 0, 62);
        assert_eq!(g.begin_outflow(&usdc(), 100), Outflow::Allowed);
        assert_eq!(g.limits()[0].used_in_window, U128(100));
    }

    #[test]
    #[should_panic(expected = "outflow cap exceeded")]
    fn cap_rejects_over_limit() {
        ctx("owner.test", 1, 1);
        let mut g = guard(true);
        g.set_limit(usdc(), Some(Limit { cap: U128(100), window_sec: 60 }));
        g.begin_deposit(&usdc(), 1000);
        g.credit(&usdc(), 1000);
        assert!(g.settle_deposit(&usdc(), 1000, 0));
        assert_eq!(g.begin_outflow(&usdc(), 60), Outflow::Allowed);
        g.debit(&usdc(), 60);
        let _ = g.begin_outflow(&usdc(), 41);
    }

    #[test]
    fn revert_outflow_restores_usage_and_backing() {
        ctx("owner.test", 1, 1);
        let mut g = guard(true);
        g.set_limit(usdc(), Some(Limit { cap: U128(100), window_sec: 60 }));
        g.begin_deposit(&usdc(), 100);
        g.credit(&usdc(), 100);
        assert!(g.settle_deposit(&usdc(), 100, 0));
        let _ = g.begin_outflow(&usdc(), 100);
        g.debit(&usdc(), 100);
        g.revert_outflow(&usdc(), 100);
        g.credit(&usdc(), 100);
        assert!(g.check(&usdc()));
        assert_eq!(g.limits()[0].used_in_window, U128(0));
    }

    #[test]
    #[should_panic(expected = "requires exactly 1 yoctoNEAR")]
    fn set_limit_needs_one_yocto() {
        ctx("owner.test", 0, 1);
        let mut g = guard(true);
        g.set_limit(usdc(), None);
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn unpause_owner_only() {
        ctx("guardian.test", 1, 1);
        let mut g = guard(true);
        g.unpause();
    }

    #[test]
    fn owner_unpauses() {
        ctx("guardian.test", 0, 1);
        let mut g = guard(true);
        g.pause_by_guardian("r".into());
        assert!(g.is_paused());
        ctx("owner.test", 1, 2);
        g.unpause();
        assert!(!g.is_paused());
    }
}
