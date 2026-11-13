//! # Qorvex guardian contract
//!
//! The only on-chain power Qorvex has. Watcher accounts (whose keys Qorvex
//! holds as function-call keys limited to this contract's `pause` method) ask
//! the guardian to pause a registered target. The guardian:
//!
//! 1. checks the caller is an approved watcher (G1),
//! 2. checks the requested scope is one the target allowed,
//! 3. enforces at most one automatic pause per target per hour unless the
//!    target's council allowed another (G4),
//! 4. records the pause on-chain with its rule id, scope and evidence hash (G3),
//! 5. forwards the pause through the target's **adapter**.
//!
//! It cannot unpause, change limits or move funds: it has no method that does
//! any of that, and every forwarded call attaches zero deposit. Changing the
//! watcher list needs the owner and 1 yoctoNEAR (G2), so no function-call key
//! can call it.
//!
//! ## Adapters (one per target)
//!
//! | Adapter | Forwarded call | Who registers the target |
//! |---|---|---|
//! | `QorvexGuard` | `pause(rule_id, evidence_hash)` | the target itself, from its `set_guardian` (`register_target`) |
//! | `NearPlugins` | `pa_pause_feature(key = scope)` | a near-plugins super-admin, or an admin of the pause role, of the target (`register_plugins_target`); checked on-chain |
//! | `CustomMethod` | `<method>(<args template>)` | the target account itself (`register_custom_target`) |
//!
//! Every registration path proves control of the target: the target's own
//! code or key, or its near-plugins ACL read back by the guardian. Many
//! customers (workspaces) share one guardian; each target carries its own
//! council, scopes and cooldown, so one target's settings never affect another.

use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, Value};
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise,
};

/// Minimum automatic-pause spacing per target (G4).
pub const PAUSE_COOLDOWN_NS: u64 = 3_600 * 1_000_000_000;
/// Storage deposit a qorvex-guard target attaches when registering itself.
pub const REGISTRATION_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Storage deposit for near-plugins and custom-method targets (larger records).
pub const ADAPTER_REGISTRATION_DEPOSIT: NearToken = NearToken::from_millinear(50);
/// The scope that means "pause everything the adapter can pause".
pub const SCOPE_ALL: &str = "ALL";

const GAS_FOR_TARGET_PAUSE: Gas = Gas::from_tgas(20);
const GAS_FOR_ON_PAUSED: Gas = Gas::from_tgas(10);
const GAS_FOR_ACL_VIEW: Gas = Gas::from_tgas(5);
const GAS_FOR_ON_PLUGINS_CHECKED: Gas = Gas::from_tgas(15);
const MAX_EVIDENCE_LEN: usize = 128;
const MAX_RULE_ID_LEN: usize = 64;
const MAX_SCOPE_LEN: usize = 64;
const MAX_SCOPES: usize = 16;
const MAX_METHOD_LEN: usize = 64;
const MAX_ARGS_TEMPLATE_LEN: usize = 512;
const MAX_ROLE_LEN: usize = 64;

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
    /// The target's pause call succeeded.
    Paused,
    /// The target's pause call failed (e.g. the guardian lost its pause role).
    Failed,
}

/// How the guardian pauses a target.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Adapter {
    /// qorvex-guard crate: `pause(rule_id, evidence_hash)`. Scope is always `ALL`.
    QorvexGuard,
    /// near-plugins `Pausable`: `pa_pause_feature(key)`, where key is the scope.
    /// The guardian holds `role` on the target (granted with `acl_grant_role`).
    NearPlugins { role: String },
    /// A pause method the target lets the guardian call. `args_template` is a JSON
    /// object whose string values may contain `{rule_id}`, `{evidence_hash}` and
    /// `{scope}`; they are replaced (JSON-escaped) at pause time.
    CustomMethod { method: String, args_template: String },
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
    /// What was paused (`ALL` or a feature key).
    pub scope: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    /// Account (e.g. the protocol's owner or DAO) that may allow an extra
    /// pause inside the cooldown window, change scopes and deregister.
    pub council: AccountId,
    pub registered_at_block: U64,
    /// Who registered it: the target itself, or the near-plugins admin that did.
    pub registered_by: AccountId,
    /// Timestamp of the last successful automatic pause.
    pub last_pause_ns: U64,
    /// Set by the council; consumed by the next pause inside the cooldown.
    pub repeat_allowed: bool,
    pub adapter: Adapter,
    /// Scopes watchers may request. `ALL` pauses everything the adapter can.
    pub scopes: Vec<String>,
}

#[ext_contract(ext_target)]
pub trait PausableTarget {
    fn pause(&mut self, rule_id: String, evidence_hash: String);
}

#[ext_contract(ext_acl)]
pub trait AccessControllable {
    fn acl_is_super_admin(&self, account_id: AccountId) -> bool;
    fn acl_is_admin(&self, role: String, account_id: AccountId) -> bool;
    fn acl_has_role(&self, role: String, account_id: AccountId) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guardian {
    owner: AccountId,
    watchers: IterableSet<AccountId>,
    targets: LookupMap<AccountId, Target>,
    history: LookupMap<AccountId, Vector<PauseRecord>>,
}

fn event(name: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"qorvex_guardian\",\"version\":\"1.1.0\",\"event\":\"{name}\",\"data\":[{data}]}}"
    ));
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

fn validate_scopes(scopes: &[String]) {
    require!(!scopes.is_empty() && scopes.len() <= MAX_SCOPES, "guardian: 1 to 16 scopes");
    for s in scopes {
        require!(!s.is_empty() && s.len() <= MAX_SCOPE_LEN, "guardian: bad scope");
    }
}

/// Substitute placeholders into the template's string values (never into keys
/// or structure), so a rule id or evidence hash cannot inject JSON.
fn render_args(template: &str, rule_id: &str, evidence_hash: &str, scope: &str) -> Vec<u8> {
    fn walk(v: &mut Value, r: &str, e: &str, s: &str) {
        match v {
            Value::String(x) => {
                *x = x.replace("{rule_id}", r).replace("{evidence_hash}", e).replace("{scope}", s);
            }
            Value::Array(a) => a.iter_mut().for_each(|i| walk(i, r, e, s)),
            Value::Object(o) => o.values_mut().for_each(|i| walk(i, r, e, s)),
            _ => {}
        }
    }
    let mut v: Value = serde_json::from_str(template).unwrap_or_else(|_| env::panic_str("guardian: bad args_template"));
    walk(&mut v, rule_id, evidence_hash, scope);
    serde_json::to_vec(&v).unwrap()
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
    /// `scope` defaults to `ALL` and must be one of the target's scopes.
    pub fn pause(
        &mut self,
        target: AccountId,
        rule_id: String,
        evidence_hash: String,
        scope: Option<String>,
    ) -> Promise {
        let watcher = env::predecessor_account_id();
        require!(self.watchers.contains(&watcher), "guardian: caller is not an approved watcher");
        require!(!rule_id.is_empty() && rule_id.len() <= MAX_RULE_ID_LEN, "guardian: bad rule_id");
        require!(
            !evidence_hash.is_empty() && evidence_hash.len() <= MAX_EVIDENCE_LEN,
            "guardian: bad evidence_hash"
        );
        let scope = scope.unwrap_or_else(|| SCOPE_ALL.to_string());
        let now = env::block_timestamp();
        let mut t = self
            .targets
            .get(&target)
            .cloned()
            .unwrap_or_else(|| env::panic_str("guardian: target is not registered"));
        require!(t.scopes.iter().any(|s| *s == scope), "guardian: scope not allowed for this target");

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
        let adapter = t.adapter.clone();
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
            scope: scope.clone(),
        });
        event(
            "pause_requested",
            format!(
                "{{\"target\":\"{target}\",\"index\":{index},\"rule_id\":{},\"evidence_hash\":{},\"scope\":{},\"watcher\":\"{watcher}\"}}",
                json_str(&rule_id),
                json_str(&evidence_hash),
                json_str(&scope)
            ),
        );

        let call = match adapter {
            Adapter::QorvexGuard => ext_target::ext(target.clone())
                .with_static_gas(GAS_FOR_TARGET_PAUSE)
                .pause(rule_id, evidence_hash),
            Adapter::NearPlugins { .. } => Promise::new(target.clone()).function_call(
                "pa_pause_feature",
                serde_json::to_vec(&serde_json::json!({ "key": scope })).unwrap(),
                NearToken::from_yoctonear(0),
                GAS_FOR_TARGET_PAUSE,
            ),
            Adapter::CustomMethod { method, args_template } => Promise::new(target.clone()).function_call(
                method,
                render_args(&args_template, &rule_id, &evidence_hash, &scope),
                NearToken::from_yoctonear(0),
                GAS_FOR_TARGET_PAUSE,
            ),
        };
        call.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_PAUSED)
                .on_target_paused(target, index),
        )
    }

    #[private]
    pub fn on_target_paused(&mut self, target: AccountId, index: u32) -> bool {
        let ok = env::promise_result_checked(0, 1024).is_ok();
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
        event("pause_result", format!("{{\"target\":\"{target}\",\"index\":{index},\"ok\":{ok}}}"));
        ok
    }

    // ------------------------------------------------- targets and council

    /// qorvex-guard path. Called by the target contract itself (predecessor ==
    /// target), with [`REGISTRATION_DEPOSIT`] attached to cover storage.
    #[payable]
    pub fn register_target(&mut self, council: AccountId) {
        require!(
            env::attached_deposit() >= REGISTRATION_DEPOSIT,
            "guardian: attach 0.01 NEAR for storage"
        );
        let target = env::predecessor_account_id();
        self.put_target(target.clone(), council, target, Adapter::QorvexGuard, vec![SCOPE_ALL.to_string()]);
    }

    /// Custom-method path. The target account itself calls this (from its code,
    /// or with its own full-access key), so registration proves control.
    #[payable]
    pub fn register_custom_target(
        &mut self,
        council: AccountId,
        method: String,
        args_template: String,
        scopes: Vec<String>,
    ) {
        require!(
            env::attached_deposit() >= ADAPTER_REGISTRATION_DEPOSIT,
            "guardian: attach 0.05 NEAR for storage"
        );
        require!(
            !method.is_empty()
                && method.len() <= MAX_METHOD_LEN
                && method.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'),
            "guardian: bad method"
        );
        require!(args_template.len() <= MAX_ARGS_TEMPLATE_LEN, "guardian: args_template too long");
        let parsed: Value =
            serde_json::from_str(&args_template).unwrap_or_else(|_| env::panic_str("guardian: bad args_template"));
        require!(parsed.is_object(), "guardian: args_template must be a JSON object");
        validate_scopes(&scopes);
        let target = env::predecessor_account_id();
        self.put_target(
            target.clone(),
            council,
            target,
            Adapter::CustomMethod { method, args_template },
            scopes,
        );
    }

    /// near-plugins path. Anyone may call it, but the target is only registered
    /// if, read back from the target itself, the caller is a super-admin (or an
    /// admin of `role`) and the guardian already holds `role`. The council
    /// defaults to the caller. The deposit is refunded if the check fails.
    #[payable]
    pub fn register_plugins_target(
        &mut self,
        target: AccountId,
        role: String,
        scopes: Vec<String>,
        council: Option<AccountId>,
    ) -> Promise {
        let deposit = env::attached_deposit();
        require!(deposit >= ADAPTER_REGISTRATION_DEPOSIT, "guardian: attach 0.05 NEAR for storage");
        require!(!role.is_empty() && role.len() <= MAX_ROLE_LEN, "guardian: bad role");
        validate_scopes(&scopes);
        let caller = env::predecessor_account_id();
        let me = env::current_account_id();
        let acl = |t: &AccountId| ext_acl::ext(t.clone()).with_static_gas(GAS_FOR_ACL_VIEW);
        acl(&target)
            .acl_is_super_admin(caller.clone())
            .and(acl(&target).acl_is_admin(role.clone(), caller.clone()))
            .and(acl(&target).acl_has_role(role.clone(), me))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_PLUGINS_CHECKED)
                    .on_plugins_checked(target, caller.clone(), council.unwrap_or(caller), role, scopes, deposit),
            )
    }

    #[private]
    pub fn on_plugins_checked(
        &mut self,
        target: AccountId,
        caller: AccountId,
        council: AccountId,
        role: String,
        scopes: Vec<String>,
        deposit: NearToken,
    ) -> bool {
        let read = |i: u64| -> bool {
            env::promise_result_checked(i, 16)
                .ok()
                .and_then(|b| serde_json::from_slice::<bool>(&b).ok())
                .unwrap_or(false)
        };
        let (super_admin, role_admin, holds_role) = (read(0), read(1), read(2));
        let ok = (super_admin || role_admin) && holds_role;
        if ok {
            self.put_target(target, council, caller, Adapter::NearPlugins { role }, scopes);
        } else {
            event(
                "registration_rejected",
                format!(
                    "{{\"target\":\"{target}\",\"caller\":\"{caller}\",\"caller_is_admin\":{},\"guardian_holds_role\":{holds_role}}}",
                    super_admin || role_admin
                ),
            );
            let _ = Promise::new(caller).transfer(deposit);
        }
        ok
    }

    /// G4: the target's council allows one more pause inside the cooldown.
    #[payable]
    pub fn allow_repeat_pause(&mut self, target: AccountId) {
        let mut t = self.council_only(&target);
        t.repeat_allowed = true;
        self.targets.insert(target, t);
    }

    /// Council only, 1 yoctoNEAR: narrow or widen the scopes watchers may request.
    #[payable]
    pub fn set_scopes(&mut self, target: AccountId, scopes: Vec<String>) {
        let mut t = self.council_only(&target);
        validate_scopes(&scopes);
        if t.adapter == Adapter::QorvexGuard {
            require!(scopes == [SCOPE_ALL.to_string()], "guardian: qorvex-guard targets only support ALL");
        }
        t.scopes = scopes.clone();
        self.targets.insert(target.clone(), t);
        event(
            "scopes_set",
            format!("{{\"target\":\"{target}\",\"scopes\":{}}}", serde_json::to_string(&scopes).unwrap()),
        );
    }

    /// Council (1 yoctoNEAR) or the target itself: stop automatic pauses for
    /// this target. Its pause history is kept.
    #[payable]
    pub fn deregister_target(&mut self, target: AccountId) {
        let caller = env::predecessor_account_id();
        if caller != target {
            self.council_only(&target);
        }
        require!(self.targets.remove(&target).is_some(), "guardian: unknown target");
        event("target_deregistered", format!("{{\"target\":\"{target}\",\"by\":\"{caller}\"}}"));
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

    // ------------------------------------------------------------- internal

    fn council_only(&self, target: &AccountId) -> Target {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "guardian: attach 1 yoctoNEAR");
        let t = self.targets.get(target).cloned().unwrap_or_else(|| env::panic_str("guardian: unknown target"));
        require!(env::predecessor_account_id() == t.council, "guardian: only the target's council");
        t
    }

    /// Insert or replace a target. Re-registration keeps the last pause time,
    /// so it cannot be used to reset the cooldown.
    fn put_target(
        &mut self,
        target: AccountId,
        council: AccountId,
        registered_by: AccountId,
        adapter: Adapter,
        scopes: Vec<String>,
    ) {
        let prev = self.targets.get(&target).cloned();
        let kind = match &adapter {
            Adapter::QorvexGuard => "qorvex_guard",
            Adapter::NearPlugins { .. } => "near_plugins",
            Adapter::CustomMethod { .. } => "custom_method",
        };
        self.targets.insert(
            target.clone(),
            Target {
                council: council.clone(),
                registered_at_block: U64(env::block_height()),
                registered_by: registered_by.clone(),
                last_pause_ns: prev.as_ref().map(|t| t.last_pause_ns).unwrap_or(U64(0)),
                repeat_allowed: false,
                adapter,
                scopes,
            },
        );
        event(
            "target_registered",
            format!("{{\"target\":\"{target}\",\"council\":\"{council}\",\"adapter\":\"{kind}\",\"registered_by\":\"{registered_by}\"}}"),
        );
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
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult};

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

    fn callback_ctx(results: Vec<PromiseResult>) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(acc("guardian.test"))
                .predecessor_account_id(acc("guardian.test"))
                .block_timestamp(30 * 1_000_000_000)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results,
        );
    }

    fn yes() -> PromiseResult {
        PromiseResult::Successful(b"true".to_vec())
    }
    fn no() -> PromiseResult {
        PromiseResult::Successful(b"false".to_vec())
    }

    fn setup() -> Guardian {
        ctx("owner.test", NearToken::from_yoctonear(0), 1);
        let mut g = Guardian::new(acc("owner.test"), vec![acc("watcher.test")]);
        ctx("ledger.test", REGISTRATION_DEPOSIT, 1);
        g.register_target(acc("council.test"));
        g
    }

    fn plugins_target(g: &mut Guardian) {
        callback_ctx(vec![yes(), no(), yes()]);
        assert!(g.on_plugins_checked(
            acc("dex.test"),
            acc("dao.test"),
            acc("dao.test"),
            "PauseManager".into(),
            vec!["ALL".into(), "swap".into()],
            ADAPTER_REGISTRATION_DEPOSIT,
        ));
    }

    #[test]
    fn watcher_can_pause_registered_target_and_history_records_it() {
        let mut g = setup();
        ctx("watcher.test", NearToken::from_yoctonear(0), 10);
        let _ = g.pause(acc("ledger.test"), "solvency-usdc".into(), "ab12".into(), None);
        let h = g.pause_history(acc("ledger.test"), None, None);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].rule_id, "solvency-usdc");
        assert_eq!(h[0].watcher, acc("watcher.test"));
        assert_eq!(h[0].status, PauseStatus::Forwarded);
        assert_eq!(h[0].scope, "ALL");
    }

    #[test]
    fn self_registration_uses_the_qorvex_guard_adapter() {
        let g = setup();
        let t = g.get_target(acc("ledger.test")).unwrap();
        assert_eq!(t.adapter, Adapter::QorvexGuard);
        assert_eq!(t.scopes, vec!["ALL".to_string()]);
        assert_eq!(t.registered_by, acc("ledger.test"));
    }

    #[test]
    #[should_panic(expected = "not an approved watcher")]
    fn non_watcher_cannot_pause() {
        let mut g = setup();
        ctx("mallory.test", NearToken::from_yoctonear(0), 10);
        let _ = g.pause(acc("ledger.test"), "r".into(), "e".into(), None);
    }

    #[test]
    #[should_panic(expected = "not registered")]
    fn unregistered_target_rejected() {
        let mut g = setup();
        ctx("watcher.test", NearToken::from_yoctonear(0), 10);
        let _ = g.pause(acc("other.test"), "r".into(), "e".into(), None);
    }

    #[test]
    #[should_panic(expected = "scope not allowed")]
    fn scope_must_be_allowed() {
        let mut g = setup();
        ctx("watcher.test", NearToken::from_yoctonear(0), 10);
        let _ = g.pause(acc("ledger.test"), "r".into(), "e".into(), Some("withdraw".into()));
    }

    #[test]
    #[should_panic(expected = "less than an hour ago")]
    fn cooldown_blocks_second_pause() {
        let mut g = setup();
        ctx("watcher.test", NearToken::from_yoctonear(0), 10);
        let _ = g.pause(acc("ledger.test"), "r".into(), "e".into(), None);
        let mut t = g.get_target(acc("ledger.test")).unwrap();
        t.last_pause_ns = U64(10 * 1_000_000_000);
        g.targets.insert(acc("ledger.test"), t);
        ctx("watcher.test", NearToken::from_yoctonear(0), 20);
        let _ = g.pause(acc("ledger.test"), "r".into(), "e".into(), None);
    }

    #[test]
    fn cooldown_is_per_target() {
        // Two customers' targets: one in cooldown does not block the other.
        let mut g = setup();
        plugins_target(&mut g);
        let mut t = g.get_target(acc("ledger.test")).unwrap();
        t.last_pause_ns = U64(10 * 1_000_000_000);
        g.targets.insert(acc("ledger.test"), t);
        ctx("watcher.test", NearToken::from_yoctonear(0), 20);
        let _ = g.pause(acc("dex.test"), "r".into(), "e".into(), Some("swap".into()));
        assert_eq!(g.pause_history(acc("dex.test"), None, None).len(), 1);
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
        let _ = g.pause(acc("ledger.test"), "r".into(), "e".into(), None);
        let h = g.pause_history(acc("ledger.test"), None, None);
        assert!(h[0].council_override);
        assert!(!g.get_target(acc("ledger.test")).unwrap().repeat_allowed);
    }

    #[test]
    fn plugins_registration_needs_admin_and_role() {
        let mut g = setup();
        plugins_target(&mut g);
        let t = g.get_target(acc("dex.test")).unwrap();
        assert_eq!(t.adapter, Adapter::NearPlugins { role: "PauseManager".into() });
        assert_eq!(t.council, acc("dao.test"));
        assert_eq!(t.registered_by, acc("dao.test"));

        // Caller is not an admin: rejected, nothing stored.
        callback_ctx(vec![no(), no(), yes()]);
        assert!(!g.on_plugins_checked(acc("x.test"), acc("mallory.test"), acc("mallory.test"), "PauseManager".into(), vec!["ALL".into()], ADAPTER_REGISTRATION_DEPOSIT));
        assert!(g.get_target(acc("x.test")).is_none());
        assert!(get_logs().iter().any(|l| l.contains("registration_rejected")));

        // Guardian does not hold the role yet: rejected.
        callback_ctx(vec![yes(), yes(), no()]);
        assert!(!g.on_plugins_checked(acc("y.test"), acc("dao.test"), acc("dao.test"), "PauseManager".into(), vec!["ALL".into()], ADAPTER_REGISTRATION_DEPOSIT));

        // A view that failed (e.g. not a near-plugins contract) counts as false.
        callback_ctx(vec![PromiseResult::Failed, yes(), yes()]);
        assert!(g.on_plugins_checked(acc("z.test"), acc("dao.test"), acc("dao.test"), "PauseManager".into(), vec!["ALL".into()], ADAPTER_REGISTRATION_DEPOSIT));
        callback_ctx(vec![PromiseResult::Failed, PromiseResult::Failed, yes()]);
        assert!(!g.on_plugins_checked(acc("w.test"), acc("dao.test"), acc("dao.test"), "PauseManager".into(), vec!["ALL".into()], ADAPTER_REGISTRATION_DEPOSIT));
    }

    #[test]
    #[should_panic(expected = "attach 0.05 NEAR")]
    fn plugins_registration_needs_deposit() {
        let mut g = setup();
        ctx("dao.test", REGISTRATION_DEPOSIT, 2);
        let _ = g.register_plugins_target(acc("dex.test"), "PauseManager".into(), vec!["ALL".into()], None);
    }

    #[test]
    fn plugins_pause_records_scope() {
        let mut g = setup();
        plugins_target(&mut g);
        ctx("watcher.test", NearToken::from_yoctonear(0), 40);
        let _ = g.pause(acc("dex.test"), "outflow".into(), "e".into(), Some("swap".into()));
        assert_eq!(g.pause_history(acc("dex.test"), None, None)[0].scope, "swap");
    }

    #[test]
    fn custom_target_renders_args_without_injection() {
        let mut g = setup();
        ctx("vault.test", ADAPTER_REGISTRATION_DEPOSIT, 2);
        g.register_custom_target(
            acc("council.test"),
            "emergency_stop".into(),
            r#"{"reason":"qorvex {rule_id} {evidence_hash}","what":"{scope}"}"#.into(),
            vec!["ALL".into()],
        );
        let out = render_args(
            &g.get_target(acc("vault.test")).map(|t| match t.adapter {
                Adapter::CustomMethod { args_template, .. } => args_template,
                _ => unreachable!(),
            }).unwrap(),
            "r\",\"x\":\"1",
            "ab",
            "ALL",
        );
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["reason"], "qorvex r\",\"x\":\"1 ab");
        assert_eq!(v["what"], "ALL");
        assert!(v.get("x").is_none());
    }

    #[test]
    #[should_panic(expected = "bad args_template")]
    fn custom_target_rejects_bad_json() {
        let mut g = setup();
        ctx("vault.test", ADAPTER_REGISTRATION_DEPOSIT, 2);
        g.register_custom_target(acc("council.test"), "stop".into(), "{nope".into(), vec!["ALL".into()]);
    }

    #[test]
    #[should_panic(expected = "bad method")]
    fn custom_target_rejects_bad_method() {
        let mut g = setup();
        ctx("vault.test", ADAPTER_REGISTRATION_DEPOSIT, 2);
        g.register_custom_target(acc("council.test"), "stop;x".into(), "{}".into(), vec!["ALL".into()]);
    }

    #[test]
    fn council_sets_scopes_and_deregisters() {
        let mut g = setup();
        plugins_target(&mut g);
        ctx("dao.test", NearToken::from_yoctonear(1), 40);
        g.set_scopes(acc("dex.test"), vec!["swap".into()]);
        assert_eq!(g.get_target(acc("dex.test")).unwrap().scopes, vec!["swap".to_string()]);
        g.deregister_target(acc("dex.test"));
        assert!(g.get_target(acc("dex.test")).is_none());
    }

    #[test]
    #[should_panic(expected = "only the target's council")]
    fn only_council_sets_scopes() {
        let mut g = setup();
        plugins_target(&mut g);
        ctx("mallory.test", NearToken::from_yoctonear(1), 40);
        g.set_scopes(acc("dex.test"), vec!["ALL".into()]);
    }

    #[test]
    #[should_panic(expected = "only support ALL")]
    fn qorvex_guard_scopes_stay_all() {
        let mut g = setup();
        ctx("council.test", NearToken::from_yoctonear(1), 40);
        g.set_scopes(acc("ledger.test"), vec!["withdraw".into()]);
    }

    #[test]
    fn target_itself_can_deregister() {
        let mut g = setup();
        ctx("ledger.test", NearToken::from_yoctonear(0), 40);
        g.deregister_target(acc("ledger.test"));
        assert!(g.get_target(acc("ledger.test")).is_none());
    }

    #[test]
    fn pause_result_callback_marks_status() {
        let mut g = setup();
        ctx("watcher.test", NearToken::from_yoctonear(0), 10);
        let _ = g.pause(acc("ledger.test"), "r".into(), "e".into(), None);
        callback_ctx(vec![PromiseResult::Successful(b"true".to_vec())]);
        assert!(g.on_target_paused(acc("ledger.test"), 0));
        assert_eq!(g.pause_history(acc("ledger.test"), None, None)[0].status, PauseStatus::Paused);
        assert_eq!(g.get_target(acc("ledger.test")).unwrap().last_pause_ns, U64(30 * 1_000_000_000));
        callback_ctx(vec![PromiseResult::Failed]);
        assert!(!g.on_target_paused(acc("ledger.test"), 0));
        assert_eq!(g.pause_history(acc("ledger.test"), None, None)[0].status, PauseStatus::Failed);
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
        // Re-registering (e.g. to change council or adapter) must not reset the last pause time.
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
        let _ = g.pause(acc("ledger.test"), "r".repeat(MAX_RULE_ID_LEN + 1), "e".into(), None);
    }

    #[test]
    fn pause_history_pages_are_capped() {
        let mut g = setup();
        for i in 0..3u64 {
            ctx("watcher.test", NearToken::from_yoctonear(0), 10 + i);
            let _ = g.pause(acc("ledger.test"), format!("r{i}"), "e".into(), None);
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
