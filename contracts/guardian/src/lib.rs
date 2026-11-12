//! # Qorvex guardian contract
//!
//! The only on-chain power Qorvex has. Watcher accounts (whose keys Qorvex
//! holds as function-call keys limited to this contract's `pause` method) ask
//! the guardian to pause a registered target. The guardian:
//!
//! 1. checks the caller is an approved watcher (G1),
//! 2. enforces at most one automatic pause per target per hour unless the
//!    target's council allowed another (G4),
//! 3. records the pause on-chain with its rule id and evidence hash (G3),
//! 4. forwards `pause(rule_id, evidence_hash)` to the target.
//!
//! It cannot unpause, change limits or move funds: it has no method that does
//! any of that. Changing the watcher list needs the owner and 1 yoctoNEAR
//! (G2), so no function-call key can call it.
//!
//! Targets register themselves (the predecessor of `register_target` is the
//! target contract), normally from the target's own `set_guardian` method, so
//! registration proves the target opted in.

use near_sdk::json_types::U64;
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError,
};

/// Minimum automatic-pause spacing per target (G4).
pub const PAUSE_COOLDOWN_NS: u64 = 3_600 * 1_000_000_000;
/// Storage deposit a target attaches when registering.
pub const REGISTRATION_DEPOSIT: NearToken = NearToken::from_millinear(10);
const GAS_FOR_TARGET_PAUSE: Gas = Gas::from_tgas(20);
const GAS_FOR_ON_PAUSED: Gas = Gas::from_tgas(10);
const MAX_EVIDENCE_LEN: usize = 128;
const MAX_RULE_ID_LEN: usize = 64;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Watchers,
    Targets,
    History,
    HistoryFor { target_hash: Vec<u8> },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PauseStatus {
    /// Recorded and forwarded; target's answer not known yet.
    Forwarded,
    /// The target's `pause()` succeeded.
    Paused,
    /// The target's `pause()` failed (e.g. guardian not configured there).
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PauseRecord {
    pub index: u32,
    pub target: AccountId,
    pub rule_id: String,
    pub evidence_hash: String,
    pub watcher: AccountId,
    pub block_height: U64,
    pub timestamp_ns: U64,
    pub status: PauseStatus,
    /// True if this pause used a council allowance to bypass the cooldown.
    pub council_override: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    /// Account (e.g. the protocol's owner or DAO) that may allow an extra
    /// pause inside the cooldown window.
    pub council: AccountId,
    pub registered_at_block: U64,
    /// Timestamp of the last successful automatic pause.
    pub last_pause_ns: U64,
    /// Set by the council; consumed by the next pause inside the cooldown.
    pub repeat_allowed: bool,
}

#[ext_contract(ext_target)]
pub trait PausableTarget {
    fn pause(&mut self, rule_id: String, evidence_hash: String);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guardian {
    owner: AccountId,
    watchers: IterableSet<AccountId>,
    targets: LookupMap<AccountId, Target>,
    history: LookupMap<AccountId, Vector<PauseRecord>>,
}

#[near]
impl Guardian {
    #[init]
    pub fn new(owner_id: AccountId, watchers: Vec<AccountId>) -> Self {
        let mut w = IterableSet::new(StorageKey::Watchers);
        for a in watchers {
            w.insert(a);
        }
        Self {
            owner: owner_id,
            watchers: w,
            targets: LookupMap::new(StorageKey::Targets),
            history: LookupMap::new(StorageKey::History),
        }
    }

    // ------------------------------------------------------------- G1: pause

    /// Ask the guardian to pause `target`. Watchers only. No deposit.
    pub fn pause(&mut self, target: AccountId, rule_id: String, evidence_hash: String) -> Promise {
        let watcher = env::predecessor_account_id();
        require!(self.watchers.contains(&watcher), "guardian: caller is not an approved watcher");
        require!(!rule_id.is_empty() && rule_id.len() <= MAX_RULE_ID_LEN, "guardian: bad rule_id");
        require!(
            !evidence_hash.is_empty() && evidence_hash.len() <= MAX_EVIDENCE_LEN,
            "guardian: bad evidence_hash"
        );
        let now = env::block_timestamp();
        let mut t = self
            .targets
            .get(&target)
            .cloned()
            .unwrap_or_else(|| env::panic_str("guardian: target is not registered"));

        // G4: one automatic pause per target per hour unless the council allows.
        let in_cooldown = t.last_pause_ns.0 != 0 && now.saturating_sub(t.last_pause_ns.0) < PAUSE_COOLDOWN_NS;
        let council_override = if in_cooldown {
            require!(
                t.repeat_allowed,
                "guardian: target was paused less than an hour ago; council must allow another pause"
            );
            t.repeat_allowed = false;
            true
        } else {
            false
        };
        self.targets.insert(target.clone(), t);

        let list = self.history_for(&target);
        let index = list.len();
        list.push(PauseRecord {
            index,
            target: target.clone(),
            rule_id: rule_id.clone(),
            evidence_hash: evidence_hash.clone(),
            watcher: watcher.clone(),
            block_height: U64(env::block_height()),
            timestamp_ns: U64(now),
            status: PauseStatus::Forwarded,
            council_override,
        });
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"qorvex_guardian\",\"version\":\"1.0.0\",\"event\":\"pause_requested\",\"data\":[{{\"target\":\"{target}\",\"index\":{index},\"rule_id\":{},\"evidence_hash\":{},\"watcher\":\"{watcher}\"}}]}}",
            near_sdk::serde_json::to_string(&rule_id).unwrap(),
            near_sdk::serde_json::to_string(&evidence_hash).unwrap(),
        ));

        ext_target::ext(target.clone())
            .with_static_gas(GAS_FOR_TARGET_PAUSE)
            .pause(rule_id, evidence_hash)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_PAUSED)
                    .on_target_paused(target, index),
            )
    }

    #[private]
    pub fn on_target_paused(
        &mut self,
        target: AccountId,
        index: u32,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let ok = result.is_ok();
        let now = env::block_timestamp();
        if let Some(list) = self.history.get_mut(&target) {
            if let Some(rec) = list.get_mut(index) {
                rec.status = if ok { PauseStatus::Paused } else { PauseStatus::Failed };
            }
        }
        if ok {
            if let Some(mut t) = self.targets.get(&target).cloned() {
                t.last_pause_ns = U64(now);
                self.targets.insert(target.clone(), t);
            }
        }
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"qorvex_guardian\",\"version\":\"1.0.0\",\"event\":\"pause_result\",\"data\":[{{\"target\":\"{target}\",\"index\":{index},\"ok\":{ok}}}]}}"
        ));
        ok
    }

    // ------------------------------------------------- targets and council

    /// Called by the target contract itself (predecessor == target), with
    /// [`REGISTRATION_DEPOSIT`] attached to cover storage.
    #[payable]
    pub fn register_target(&mut self, council: AccountId) {
        require!(
            env::attached_deposit() >= REGISTRATION_DEPOSIT,
            "guardian: attach 0.01 NEAR for storage"
        );
        let target = env::predecessor_account_id();
        let prev = self.targets.get(&target).cloned();
        self.targets.insert(
            target.clone(),
            Target {
                council: council.clone(),
                registered_at_block: U64(env::block_height()),
                last_pause_ns: prev.as_ref().map(|t| t.last_pause_ns).unwrap_or(U64(0)),
                repeat_allowed: false,
            },
        );
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"qorvex_guardian\",\"version\":\"1.0.0\",\"event\":\"target_registered\",\"data\":[{{\"target\":\"{target}\",\"council\":\"{council}\"}}]}}"
        ));
    }

    /// G4: the target's council allows one more pause inside the cooldown.
    #[payable]
    pub fn allow_repeat_pause(&mut self, target: AccountId) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "guardian: attach 1 yoctoNEAR");
        let mut t = self.targets.get(&target).cloned().unwrap_or_else(|| env::panic_str("guardian: unknown target"));
        require!(env::predecessor_account_id() == t.council, "guardian: only the target's council");
        t.repeat_allowed = true;
        self.targets.insert(target, t);
    }

    // -------------------------------------------------------- G2: watchers

    /// Owner only, 1 yoctoNEAR (so no function-call key can call it).
    #[payable]
    pub fn set_watchers(&mut self, add: Vec<AccountId>, remove: Vec<AccountId>) {
        require!(env::predecessor_account_id() == self.owner, "guardian: owner only");
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "guardian: attach 1 yoctoNEAR");
        for a in remove {
            self.watchers.remove(&a);
        }
        for a in add {
            self.watchers.insert(a);
        }
    }

    // ------------------------------------------------------------ G3: views

    pub fn pause_history(&self, target: AccountId, from_index: Option<u32>, limit: Option<u32>) -> Vec<PauseRecord> {
        let Some(list) = self.history.get(&target) else { return vec![] };
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..list.len()).take(limit as usize).filter_map(|i| list.get(i).cloned()).collect()
    }

    pub fn get_target(&self, target: AccountId) -> Option<Target> {
        self.targets.get(&target).cloned()
    }

    pub fn watchers(&self) -> Vec<AccountId> {
        self.watchers.iter().cloned().collect()
    }

    pub fn is_watcher(&self, account_id: AccountId) -> bool {
        self.watchers.contains(&account_id)
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }

    fn history_for(&mut self, target: &AccountId) -> &mut Vector<PauseRecord> {
        if !self.history.contains_key(target) {
            let v = Vector::new(StorageKey::HistoryFor {
                target_hash: env::sha256(target.as_bytes()),
            });
            self.history.insert(target.clone(), v);
        }
        self.history.get_mut(target).expect("just inserted")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(pred: &str, deposit: NearToken, ts_sec: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("guardian.test"))
            .predecessor_account_id(acc(pred))
            .attached_deposit(deposit)
            .block_timestamp(ts_sec * 1_000_000_000)
            .build());
    }

    fn setup() -> Guardian {
        ctx("owner.test", NearToken::from_yoctonear(0), 1);
        let mut g = Guardian::new(acc("owner.test"), vec![acc("watcher.test")]);
        ctx("ledger.test", REGISTRATION_DEPOSIT, 1);
        g.register_target(acc("council.test"));
        g
    }

    #[test]
    fn watcher_can_pause_registered_target_and_history_records_it() {
        let mut g = setup();
        ctx("watcher.test", NearToken::from_yoctonear(0), 10);
        let _ = g.pause(acc("ledger.test"), "solvency-usdc".into(), "ab12".into());
        let h = g.pause_history(acc("ledger.test"), None, None);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].rule_id, "solvency-usdc");
        assert_eq!(h[0].watcher, acc("watcher.test"));
        assert_eq!(h[0].status, PauseStatus::Forwarded);
    }

    #[test]
    #[should_panic(expected = "not an approved watcher")]
    fn non_watcher_cannot_pause() {
        let mut g = setup();
        ctx("mallory.test", NearToken::from_yoctonear(0), 10);
        let _ = g.pause(acc("ledger.test"), "r".into(), "e".into());
    }

    #[test]
    #[should_panic(expected = "not registered")]
    fn unregistered_target_rejected() {
        let mut g = setup();
        ctx("watcher.test", NearToken::from_yoctonear(0), 10);
        let _ = g.pause(acc("other.test"), "r".into(), "e".into());
    }

    #[test]
    #[should_panic(expected = "less than an hour ago")]
    fn cooldown_blocks_second_pause() {
        let mut g = setup();
        ctx("watcher.test", NearToken::from_yoctonear(0), 10);
        let _ = g.pause(acc("ledger.test"), "r".into(), "e".into());
        // simulate the target accepting the pause
        let mut t = g.get_target(acc("ledger.test")).unwrap();
        t.last_pause_ns = U64(10 * 1_000_000_000);
        g.targets.insert(acc("ledger.test"), t);
        ctx("watcher.test", NearToken::from_yoctonear(0), 20);
        let _ = g.pause(acc("ledger.test"), "r".into(), "e".into());
    }

    #[test]
    fn council_can_allow_repeat_pause() {
        let mut g = setup();
        let mut t = g.get_target(acc("ledger.test")).unwrap();
        t.last_pause_ns = U64(10 * 1_000_000_000);
        g.targets.insert(acc("ledger.test"), t);
        ctx("council.test", NearToken::from_yoctonear(1), 20);
        g.allow_repeat_pause(acc("ledger.test"));
        ctx("watcher.test", NearToken::from_yoctonear(0), 21);
        let _ = g.pause(acc("ledger.test"), "r".into(), "e".into());
        let h = g.pause_history(acc("ledger.test"), None, None);
        assert!(h[0].council_override);
        assert!(!g.get_target(acc("ledger.test")).unwrap().repeat_allowed);
    }

    #[test]
    #[should_panic(expected = "attach 1 yoctoNEAR")]
    fn set_watchers_requires_one_yocto() {
        let mut g = setup();
        ctx("owner.test", NearToken::from_yoctonear(0), 2);
        g.set_watchers(vec![acc("w2.test")], vec![]);
    }

    #[test]
    fn owner_sets_watchers() {
        let mut g = setup();
        ctx("owner.test", NearToken::from_yoctonear(1), 2);
        g.set_watchers(vec![acc("w2.test")], vec![acc("watcher.test")]);
        assert_eq!(g.watchers(), vec![acc("w2.test")]);
    }

    #[test]
    #[should_panic(expected = "only the target's council")]
    fn only_council_can_allow_repeat_pause() {
        let mut g = setup();
        ctx("watcher.test", NearToken::from_yoctonear(1), 20);
        g.allow_repeat_pause(acc("ledger.test"));
    }

    #[test]
    #[should_panic(expected = "attach 1 yoctoNEAR")]
    fn allow_repeat_pause_requires_one_yocto() {
        // A function-call key (which cannot attach a deposit) must not reach it.
        let mut g = setup();
        ctx("council.test", NearToken::from_yoctonear(0), 20);
        g.allow_repeat_pause(acc("ledger.test"));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn non_owner_cannot_set_watchers() {
        let mut g = setup();
        ctx("watcher.test", NearToken::from_yoctonear(1), 2);
        g.set_watchers(vec![acc("mallory.test")], vec![]);
    }

    #[test]
    fn re_registration_keeps_the_cooldown() {
        // A target re-registering (e.g. to change council) must not reset its last pause time.
        let mut g = setup();
        let mut t = g.get_target(acc("ledger.test")).unwrap();
        t.last_pause_ns = U64(10 * 1_000_000_000);
        t.repeat_allowed = true;
        g.targets.insert(acc("ledger.test"), t);
        ctx("ledger.test", REGISTRATION_DEPOSIT, 20);
        g.register_target(acc("new-council.test"));
        let t = g.get_target(acc("ledger.test")).unwrap();
        assert_eq!(t.last_pause_ns, U64(10 * 1_000_000_000));
        assert!(!t.repeat_allowed);
        assert_eq!(t.council, acc("new-council.test"));
    }

    #[test]
    #[should_panic(expected = "bad rule_id")]
    fn pause_rejects_oversized_rule_id() {
        let mut g = setup();
        ctx("watcher.test", NearToken::from_yoctonear(0), 10);
        let _ = g.pause(acc("ledger.test"), "r".repeat(MAX_RULE_ID_LEN + 1), "e".into());
    }

    #[test]
    fn pause_history_pages_are_capped() {
        let mut g = setup();
        for i in 0..3u64 {
            // Each pause is outside the previous one's cooldown window (no successful pause is recorded in unit tests).
            ctx("watcher.test", NearToken::from_yoctonear(0), 10 + i);
            let _ = g.pause(acc("ledger.test"), format!("r{i}"), "e".into());
        }
        assert_eq!(g.pause_history(acc("ledger.test"), Some(1), Some(1))[0].rule_id, "r1");
        assert_eq!(g.pause_history(acc("ledger.test"), Some(5), None).len(), 0);
        assert_eq!(g.pause_history(acc("other.test"), None, None).len(), 0);
    }

    #[test]
    #[should_panic(expected = "attach 0.01 NEAR")]
    fn registration_needs_storage_deposit() {
        let mut g = setup();
        ctx("x.test", NearToken::from_yoctonear(0), 2);
        g.register_target(acc("council.test"));
    }
}
