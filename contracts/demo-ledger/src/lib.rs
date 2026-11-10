//! # Demo ledger (DELIBERATELY VULNERABLE, testnet / sandbox only)
//!
//! An Intents-style internal ledger: users deposit NEP-141 tokens with
//! `ft_transfer_call`, get an internal balance, and `withdraw` real tokens.
//!
//! **Planted bug, the same pattern as the NEAR Intents exploit
//! (Sep 29 to Oct 1, 2026):** a deposit whose `msg` is
//! `{"notify":"<account>"}` credits the user immediately, then calls
//! `on_deposit_notify` on `<account>`. If that call fails, the deposit is
//! refunded to the sender, but **the internal credit is never removed**.
//! The credit is now backed by nothing (a "ghost balance") and can be
//! withdrawn as real tokens that belong to other depositors.
//!
//! Protection comes from `qorvex-guard`:
//! * outflow caps on `withdraw` (P1, P2);
//! * with `self_accounting = true`, the ghost credit trips the guard in the
//!   very callback that refunds the deposit, and the contract pauses itself
//!   in the same transaction (P3);
//! * with `self_accounting = false`, the Qorvex watcher sees `owed > held`
//!   from outside and pauses through the guardian contract (D1 to D4, G1).
//!
//! Do not deploy this contract with real funds.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};
use qorvex_guard::{Guard, GuardStatus, Limit, LimitView, Outflow};

const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_ON_WITHDRAW: Gas = Gas::from_tgas(15);
const GAS_FOR_NOTIFY: Gas = Gas::from_tgas(10);
const GAS_FOR_RESOLVE_DEPOSIT: Gas = Gas::from_tgas(15);
const GAS_FOR_REGISTER: Gas = Gas::from_tgas(10);
const GUARDIAN_REGISTRATION_DEPOSIT: NearToken = NearToken::from_millinear(10);

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Guard,
    Tokens,
    Balances,
    TotalOwed,
}

#[near(serializers = [json])]
pub struct DepositMsg {
    /// Account to notify about the deposit (the vulnerable feature).
    pub notify: Option<AccountId>,
}

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_notify)]
pub trait DepositNotifyReceiver {
    fn on_deposit_notify(&mut self, sender_id: AccountId, token_id: AccountId, amount: U128);
}

#[ext_contract(ext_guardian)]
pub trait Guardian {
    fn register_target(&mut self, council: AccountId);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Ledger {
    guard: Guard,
    tokens: IterableSet<AccountId>,
    balances: LookupMap<(AccountId, AccountId), u128>,
    total_owed: IterableMap<AccountId, u128>,
}

#[near]
impl Ledger {
    /// `self_accounting`: turn on the guard's same-transaction pause.
    #[init]
    pub fn new(owner_id: AccountId, tokens: Vec<AccountId>, self_accounting: bool) -> Self {
        let mut t = IterableSet::new(StorageKey::Tokens);
        for token in tokens {
            t.insert(token);
        }
        Self {
            guard: Guard::new(StorageKey::Guard, owner_id, None, self_accounting),
            tokens: t,
            balances: LookupMap::new(StorageKey::Balances),
            total_owed: IterableMap::new(StorageKey::TotalOwed),
        }
    }

    // ------------------------------------------------------------ deposits

    /// NEP-141 receiver. `msg` is empty for a plain deposit or
    /// `{"notify":"<account>"}` for a deposit with a notification.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token_id = env::predecessor_account_id();
        require!(self.tokens.contains(&token_id), "ledger: token not supported");
        self.guard.assert_not_paused();
        let parsed: DepositMsg = if msg.trim().is_empty() {
            DepositMsg { notify: None }
        } else {
            near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("ledger: bad msg"))
        };

        self.guard.begin_deposit(&token_id, amount.0);
        self.internal_credit(&sender_id, &token_id, amount.0);

        match parsed.notify {
            None => {
                self.guard.settle_deposit(&token_id, amount.0, 0);
                PromiseOrValue::Value(U128(0))
            }
            Some(notify) => ext_notify::ext(notify)
                .with_static_gas(GAS_FOR_NOTIFY)
                .on_deposit_notify(sender_id.clone(), token_id.clone(), amount)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_FOR_RESOLVE_DEPOSIT)
                        .resolve_deposit(sender_id, token_id, amount),
                )
                .into(),
        }
    }

    /// Returns the amount the token contract must refund to the sender.
    #[private]
    pub fn resolve_deposit(
        &mut self,
        sender_id: AccountId,
        token_id: AccountId,
        amount: U128,
        #[callback_result] notified: Result<(), PromiseError>,
    ) -> U128 {
        let _ = &sender_id;
        let refund = if notified.is_ok() { 0 } else { amount.0 };
        // BUG (planted on purpose): when the notification fails the deposit
        // is refunded, but the credit made in ft_on_transfer is kept.
        // The fix would be: self.internal_debit(&sender_id, &token_id, refund);
        self.guard.settle_deposit(&token_id, amount.0, refund);
        U128(refund)
    }

    // --------------------------------------------------------- withdrawals

    /// Withdraw `amount` of `token_id` to the caller. Guarded by
    /// `qorvex-guard`: rejected over the cap; if the books do not balance the
    /// contract pauses itself and returns `false` without sending anything.
    #[payable]
    pub fn withdraw(&mut self, token_id: AccountId, amount: U128) -> PromiseOrValue<bool> {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "ledger: attach 1 yoctoNEAR");
        require!(amount.0 > 0, "ledger: amount must be positive");
        let user = env::predecessor_account_id();
        match self.guard.begin_outflow(&token_id, amount.0) {
            Outflow::Tripped => return PromiseOrValue::Value(false),
            Outflow::Allowed => {}
        }
        self.internal_debit(&user, &token_id, amount.0);
        ext_ft::ext(token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(user.clone(), amount, Some("ledger withdraw".into()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_WITHDRAW)
                    .on_withdraw(user, token_id, amount),
            )
            .into()
    }

    #[private]
    pub fn on_withdraw(
        &mut self,
        user: AccountId,
        token_id: AccountId,
        amount: U128,
        #[callback_result] sent: Result<(), PromiseError>,
    ) -> bool {
        if sent.is_ok() {
            return true;
        }
        // Transfer failed: the tokens never left. Restore the balance.
        self.guard.revert_outflow(&token_id, amount.0);
        self.internal_credit(&user, &token_id, amount.0);
        false
    }

    // --------------------------------------------------------------- admin

    /// Guardian contract only (no deposit, so a function-call key reaches it).
    pub fn pause(&mut self, rule_id: Option<String>, evidence_hash: Option<String>) {
        self.guard.pause_by_guardian(format!(
            "guardian: rule {} evidence {}",
            rule_id.unwrap_or_else(|| "-".into()),
            evidence_hash.unwrap_or_else(|| "-".into())
        ));
    }

    /// Owner only, 1 yoctoNEAR.
    #[payable]
    pub fn unpause(&mut self) {
        self.guard.unpause();
    }

    /// Owner only, 1 yoctoNEAR. `cap = None` removes the limit.
    #[payable]
    pub fn set_limits(&mut self, token_id: AccountId, cap: Option<U128>, window_sec: Option<u64>) {
        let limit = cap.map(|cap| Limit { cap, window_sec: window_sec.unwrap_or(3600) });
        self.guard.set_limit(token_id, limit);
    }

    /// Owner only, 1 yoctoNEAR. Sets the guardian and, in the same
    /// transaction, registers this contract with that guardian (attaching
    /// 0.01 NEAR of this contract's balance for the guardian's storage), with
    /// the owner as council.
    #[payable]
    pub fn set_guardian(&mut self, guardian_id: AccountId) -> Promise {
        self.guard.set_guardian(Some(guardian_id.clone()));
        ext_guardian::ext(guardian_id)
            .with_attached_deposit(GUARDIAN_REGISTRATION_DEPOSIT)
            .with_static_gas(GAS_FOR_REGISTER)
            .register_target(self.guard.owner().clone())
    }

    /// Owner only, 1 yoctoNEAR.
    #[payable]
    pub fn add_token(&mut self, token_id: AccountId) {
        self.guard.assert_owner_one_yocto();
        self.tokens.insert(token_id);
    }

    // --------------------------------------------------------------- views

    /// Total owed to users for a token (sum of internal balances).
    pub fn total_owed(&self, token_id: AccountId) -> U128 {
        U128(self.total_owed.get(&token_id).copied().unwrap_or(0))
    }

    /// Intents-compatible liability view: `token_id` is `nep141:<contract>`.
    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        let contract: AccountId = token_id.strip_prefix("nep141:")?.parse().ok()?;
        self.tokens.contains(&contract).then(|| self.total_owed(contract))
    }

    /// Intents-compatible balance view: `token_id` is `nep141:<contract>`.
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        let Some(contract) = token_id.strip_prefix("nep141:").and_then(|c| c.parse().ok()) else {
            return U128(0);
        };
        self.balance_of(account_id, contract)
    }

    pub fn balance_of(&self, account_id: AccountId, token_id: AccountId) -> U128 {
        U128(self.balances.get(&(account_id, token_id)).copied().unwrap_or(0))
    }

    /// Deposits the guard saw kept, minus outflows.
    pub fn confirmed_deposits(&self, token_id: AccountId) -> U128 {
        U128(self.guard.confirmed_deposits(&token_id))
    }

    pub fn is_paused(&self) -> bool {
        self.guard.is_paused()
    }

    pub fn limits(&self) -> Vec<LimitView> {
        self.guard.limits()
    }

    pub fn guard_status(&self) -> GuardStatus {
        self.guard.status()
    }

    pub fn supported_tokens(&self) -> Vec<AccountId> {
        self.tokens.iter().cloned().collect()
    }

    // ------------------------------------------------------------ internal

    fn internal_credit(&mut self, user: &AccountId, token_id: &AccountId, amount: u128) {
        let key = (user.clone(), token_id.clone());
        let b = self.balances.get(&key).copied().unwrap_or(0);
        self.balances.insert(key, b + amount);
        let t = self.total_owed.get(token_id).copied().unwrap_or(0);
        self.total_owed.insert(token_id.clone(), t + amount);
        self.guard.credit(token_id, amount);
    }

    fn internal_debit(&mut self, user: &AccountId, token_id: &AccountId, amount: u128) {
        let key = (user.clone(), token_id.clone());
        let b = self.balances.get(&key).copied().unwrap_or(0);
        require!(b >= amount, "ledger: insufficient balance");
        self.balances.insert(key, b - amount);
        let t = self.total_owed.get(token_id).copied().unwrap_or(0);
        self.total_owed.insert(token_id.clone(), t.saturating_sub(amount));
        self.guard.debit(token_id, amount);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(pred: &str, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("ledger.test"))
            .predecessor_account_id(acc(pred))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }

    fn callback_ctx(result: PromiseResult) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(acc("ledger.test"))
                .predecessor_account_id(acc("ledger.test"))
                .build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    fn ledger(self_accounting: bool) -> Ledger {
        ctx("owner.test", 0);
        Ledger::new(acc("owner.test"), vec![acc("usdc.test")], self_accounting)
    }

    #[test]
    fn plain_deposit_credits_and_counts_as_confirmed() {
        let mut l = ledger(true);
        ctx("usdc.test", 0);
        let _ = l.ft_on_transfer(acc("alice.test"), U128(100), "".into());
        assert_eq!(l.balance_of(acc("alice.test"), acc("usdc.test")), U128(100));
        assert_eq!(l.mt_supply("nep141:usdc.test".into()), Some(U128(100)));
        assert_eq!(l.confirmed_deposits(acc("usdc.test")), U128(100));
        assert!(!l.is_paused());
    }

    #[test]
    fn ghost_deposit_trips_self_accounting_in_resolve() {
        let mut l = ledger(true);
        ctx("usdc.test", 0);
        let _ = l.ft_on_transfer(acc("alice.test"), U128(1_000), "".into());
        let _ = l.ft_on_transfer(acc("mallory.test"), U128(400), r#"{"notify":"trap.test"}"#.into());
        assert!(!l.is_paused(), "pending deposit backs the credit");
        callback_ctx(PromiseResult::Failed);
        let refund = l.resolve_deposit(acc("mallory.test"), acc("usdc.test"), U128(400), Err(PromiseError::Failed));
        assert_eq!(refund, U128(400));
        // the bug: credit kept
        assert_eq!(l.balance_of(acc("mallory.test"), acc("usdc.test")), U128(400));
        // the guard: paused in this same receipt
        assert!(l.is_paused());
        let status = l.guard_status();
        assert!(status.paused.unwrap().reason.contains("self-accounting"));
    }

    #[test]
    fn ghost_deposit_without_self_accounting_stays_unpaused() {
        let mut l = ledger(false);
        ctx("usdc.test", 0);
        let _ = l.ft_on_transfer(acc("mallory.test"), U128(400), r#"{"notify":"trap.test"}"#.into());
        callback_ctx(PromiseResult::Failed);
        let _ = l.resolve_deposit(acc("mallory.test"), acc("usdc.test"), U128(400), Err(PromiseError::Failed));
        assert!(!l.is_paused());
        assert_eq!(l.total_owed(acc("usdc.test")), U128(400));
        assert_eq!(l.confirmed_deposits(acc("usdc.test")), U128(0));
    }

    #[test]
    #[should_panic(expected = "only the guardian can pause")]
    fn pause_requires_guardian() {
        let mut l = ledger(false);
        ctx("mallory.test", 0);
        l.pause(None, None);
    }

    #[test]
    #[should_panic(expected = "token not supported")]
    fn rejects_unknown_token() {
        let mut l = ledger(false);
        ctx("fake.test", 0);
        let _ = l.ft_on_transfer(acc("mallory.test"), U128(1), "".into());
    }

    #[test]
    #[should_panic(expected = "outflow cap exceeded")]
    fn withdraw_respects_cap() {
        let mut l = ledger(true);
        ctx("owner.test", 1);
        l.set_limits(acc("usdc.test"), Some(U128(50)), Some(3600));
        ctx("usdc.test", 0);
        let _ = l.ft_on_transfer(acc("alice.test"), U128(100), "".into());
        ctx("alice.test", 1);
        let _ = l.withdraw(acc("usdc.test"), U128(60));
    }

    #[test]
    fn withdraw_after_ghost_trips_and_sends_nothing() {
        // Self-accounting on, but the ghost credit is made through a path the
        // guard has not settled yet: the outflow check catches it.
        let mut l = ledger(true);
        ctx("usdc.test", 0);
        let _ = l.ft_on_transfer(acc("alice.test"), U128(100), "".into());
        // simulate a ghost credit (e.g. a buggy path that skipped begin_deposit)
        l.internal_credit(&acc("mallory.test"), &acc("usdc.test"), 50);
        ctx("mallory.test", 1);
        match l.withdraw(acc("usdc.test"), U128(50)) {
            PromiseOrValue::Value(false) => {}
            _ => panic!("expected tripped withdraw"),
        }
        assert!(l.is_paused());
        assert_eq!(l.balance_of(acc("mallory.test"), acc("usdc.test")), U128(50));
    }
}
