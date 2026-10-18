//! Touch ID unlock for bWalletX Desktop: YoursNative.biometric* (src/mobile/biometricUnlock.ts) on macOS.
//!
//! What is sealed is the wallet's session passKey (derived from the password; the keystore stays encrypted on disk).
//! All sealed values live in ONE Keychain item as a JSON map, so `remove("")` (wallet reset / sign-out) clears every
//! one at once. Reading it back needs a Touch ID check first (LocalAuthentication). The wallet password always works
//! instead: a cancelled or failed check rejects with "cancelled" and the lock screen falls back to it.
//!
//! Not yet: binding the item itself to biometrics with SecAccessControl (kSecAccessControlBiometryCurrentSet) needs a
//! signed build with the data-protection keychain; revisit once the Developer ID identity is in place.

use std::collections::BTreeMap;

pub const SERVICE: &str = "com.bitcoincorp.bwalletx.desktop";
const ACCOUNT: &str = "biometric-sealed";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    pub biometry_type: &'static str,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use crate::keychain;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LABiometryType, LAContext, LAPolicy};
    use std::sync::mpsc;

    const POLICY: LAPolicy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;

    pub fn status() -> Status {
        unsafe {
            let ctx = LAContext::new();
            let ok = ctx.canEvaluatePolicy_error(POLICY).is_ok();
            let touch = ok && ctx.biometryType() == LABiometryType::TouchID;
            Status {
                available: touch,
                biometry_type: if touch { "touchId" } else { "none" },
            }
        }
    }

    /// Blocks until the user answers the Touch ID sheet. Err("cancelled") for cancel / fallback / lockout.
    pub fn authenticate(reason: &str) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Result<(), i64>>();
        unsafe {
            let ctx = LAContext::new();
            let reply = RcBlock::new(move |ok: Bool, err: *mut NSError| {
                let code = if err.is_null() {
                    -1
                } else {
                    (*err).code() as i64
                };
                let _ = tx.send(if ok.as_bool() { Ok(()) } else { Err(code) });
            });
            ctx.evaluatePolicy_localizedReason_reply(POLICY, &NSString::from_str(reason), &reply);
        }
        match rx.recv() {
            Ok(Ok(())) => Ok(()),
            Ok(Err(code)) => Err(format!("cancelled ({code})")),
            Err(_) => Err("cancelled (no reply)".into()),
        }
    }

    pub fn read_all() -> Result<BTreeMap<String, String>, String> {
        Ok(match keychain::get(SERVICE, ACCOUNT)? {
            Some(json) => serde_json::from_str(&json).unwrap_or_default(),
            None => BTreeMap::new(),
        })
    }

    pub fn write_all(map: &BTreeMap<String, String>) -> Result<(), String> {
        if map.is_empty() {
            return keychain::delete(SERVICE, ACCOUNT);
        }
        keychain::set(
            SERVICE,
            ACCOUNT,
            &serde_json::to_string(map).map_err(|e| e.to_string())?,
        )
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;
    pub fn status() -> Status {
        Status {
            available: false,
            biometry_type: "none",
        }
    }
    pub fn authenticate(_reason: &str) -> Result<(), String> {
        Err("cancelled (no biometrics on this platform)".into())
    }
    pub fn read_all() -> Result<BTreeMap<String, String>, String> {
        Ok(BTreeMap::new())
    }
    pub fn write_all(_map: &BTreeMap<String, String>) -> Result<(), String> {
        Err("biometrics are not available on this platform".into())
    }
}

pub use platform::status;

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let mut map = platform::read_all()?;
    map.insert(key.to_string(), value.to_string());
    platform::write_all(&map)
}

pub fn get(key: &str, reason: &str) -> Result<Option<String>, String> {
    let map = platform::read_all()?;
    let Some(value) = map.get(key).cloned() else {
        return Ok(None);
    };
    platform::authenticate(reason)?;
    Ok(Some(value))
}

pub fn remove(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return platform::write_all(&BTreeMap::new());
    }
    let mut map = platform::read_all()?;
    if map.remove(key).is_some() {
        platform::write_all(&map)?;
    }
    Ok(())
}
