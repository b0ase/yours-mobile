//! macOS Keychain items for bWalletX Desktop (borrowed from bchat-desktop/src-tauri/src/keychain.rs, which explains
//! the choice at length): the DATA-PROTECTION keychain first, where a signed app reads its own items without a
//! dialog; the legacy login keychain only if that one refuses (an unsigned dev build), never on item-not-found.
//! No `keychain-access-groups` entitlement: without a provisioning profile it stops the app launching.

use security_framework::passwords::{
    delete_generic_password_options, generic_password, set_generic_password_options,
};
use security_framework::passwords_options::PasswordOptions;

const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

fn modern(service: &str, account: &str) -> PasswordOptions {
    let mut o = PasswordOptions::new_generic_password(service, account);
    o.use_protected_keychain();
    o
}

fn legacy(service: &str, account: &str) -> PasswordOptions {
    PasswordOptions::new_generic_password(service, account)
}

pub fn set(service: &str, account: &str, secret: &str) -> Result<(), String> {
    let _ = delete(service, account);
    match set_generic_password_options(secret.as_bytes(), modern(service, account)) {
        Ok(()) => Ok(()),
        Err(_) => set_generic_password_options(secret.as_bytes(), legacy(service, account))
            .map_err(|e| e.to_string()),
    }
}

pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
    match generic_password(modern(service, account)) {
        Ok(bytes) => text(bytes),
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(_) => match generic_password(legacy(service, account)) {
            Ok(bytes) => text(bytes),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(e.to_string()),
        },
    }
}

fn text(bytes: Vec<u8>) -> Result<Option<String>, String> {
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "the stored item is not valid text".to_string())
}

pub fn delete(service: &str, account: &str) -> Result<(), String> {
    let a = delete_generic_password_options(modern(service, account));
    let b = delete_generic_password_options(legacy(service, account));
    match (a, b) {
        (Err(e), Err(_)) if e.code() != ERR_SEC_ITEM_NOT_FOUND => Err(e.to_string()),
        _ => Ok(()),
    }
}
