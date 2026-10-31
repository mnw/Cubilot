// User-presence gate for `cubilot hub`. The Keychain item is in the file-based keychain, whose ACL trusts the app that
// made it, so the item alone shows no prompt. This gate asks LocalAuthentication (Touch ID, or the login password when
// Touch ID is not available) BEFORE the Keychain read, and the command refuses when the gate refuses.
// objc2 and block2 are already in Cargo.lock through tauri: no new download.

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{msg_send, class};
use objc2_foundation::{NSError, NSString};
use std::sync::mpsc;
use std::time::Duration;

#[link(name = "LocalAuthentication", kind = "framework")]
extern "C" {}

// LAPolicyDeviceOwnerAuthentication: biometrics, with the device password as the fallback.
const POLICY_DEVICE_OWNER_AUTHENTICATION: isize = 2;
const LA_ERROR_USER_CANCEL: isize = -2;
const LA_ERROR_SYSTEM_CANCEL: isize = -4;
const LA_ERROR_AUTHENTICATION_FAILED: isize = -1;

// Pure: the one-line cause for a LocalAuthentication error code. No token is in scope here.
pub(crate) fn describe_code(code: isize) -> String {
    match code {
        LA_ERROR_USER_CANCEL | LA_ERROR_SYSTEM_CANCEL | LA_ERROR_AUTHENTICATION_FAILED => {
            "Touch ID or password prompt refused".to_string()
        }
        other => format!("Touch ID or password check not available (LocalAuthentication error {other})"),
    }
}

pub(crate) fn require_presence(reason: &str) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let block = RcBlock::new(move |ok: Bool, error: *mut NSError| {
        let result = if ok.as_bool() {
            Ok(())
        } else if error.is_null() {
            Err("Touch ID or password prompt refused".to_string())
        } else {
            let code: isize = unsafe { msg_send![error, code] };
            Err(describe_code(code))
        };
        let _ = tx.send(result);
    });
    unsafe {
        let cls: &AnyClass = class!(LAContext);
        let ctx: Retained<AnyObject> = msg_send![cls, new];
        let reason = NSString::from_str(reason);
        let _: () = msg_send![
            &*ctx,
            evaluatePolicy: POLICY_DEVICE_OWNER_AUTHENTICATION,
            localizedReason: &*reason,
            reply: &*block
        ];
        // The reply runs on a LocalAuthentication queue; this thread waits for it.
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok(r) => r,
            Err(_) => Err("Touch ID or password prompt timed out".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_map_to_one_line_causes() {
        assert!(describe_code(-2).contains("refused"));
        assert!(describe_code(-1).contains("refused"));
        let other = describe_code(-5);
        assert!(other.contains("not available") && !other.contains('\n'));
    }
}
