// The human token of one app launch, in one macOS Keychain item with the user presence access control flag. The item is in
// the file-based keychain, which does not enforce that flag: presence.rs gates the read in `cubilot hub` (Touch ID or the
// login password). The shell stores the item at start. No file and no env holds the token.
// Raw Security.framework calls through the core-foundation crate (already in Cargo.lock): no new dependency.

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_foundation_sys::base::{CFAllocatorRef, CFGetTypeID, CFRelease, CFTypeRef, OSStatus};
use core_foundation_sys::data::CFDataRef;
use core_foundation_sys::dictionary::CFDictionaryRef;
use core_foundation_sys::string::CFStringRef;
use std::ffi::c_void;
use std::ptr;

pub(crate) const SERVICE: &str = "Cubilot";
pub(crate) const ACCOUNT: &str = "human-token";

// kSecAccessControlUserPresence: Touch ID, or the device passcode (login password) as the fallback.
pub(crate) const FLAG_USER_PRESENCE: usize = 1 << 0;

const ERR_NOT_FOUND: i32 = -25300; // errSecItemNotFound
const ERR_USER_CANCELED: i32 = -128; // errSecUserCanceled
const ERR_AUTH_FAILED: i32 = -25293; // errSecAuthFailed
const ERR_INTERACTION_NOT_ALLOWED: i32 = -25308; // errSecInteractionNotAllowed

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecClass: CFStringRef;
    static kSecClassGenericPassword: CFStringRef;
    static kSecAttrService: CFStringRef;
    static kSecAttrAccount: CFStringRef;
    static kSecAttrAccessControl: CFStringRef;
    static kSecAttrAccessibleWhenUnlockedThisDeviceOnly: CFStringRef;
    static kSecValueData: CFStringRef;
    static kSecReturnData: CFStringRef;
    static kSecMatchLimit: CFStringRef;
    static kSecMatchLimitOne: CFStringRef;
    static kSecUseDataProtectionKeychain: CFStringRef;
    static kSecUseOperationPrompt: CFStringRef;
    fn SecAccessControlCreateWithFlags(
        allocator: CFAllocatorRef,
        protection: CFTypeRef,
        flags: usize,
        error: *mut *mut c_void,
    ) -> CFTypeRef;
    fn SecItemAdd(attributes: CFDictionaryRef, result: *mut CFTypeRef) -> OSStatus;
    fn SecItemDelete(query: CFDictionaryRef) -> OSStatus;
    fn SecItemCopyMatching(query: CFDictionaryRef, result: *mut CFTypeRef) -> OSStatus;
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum KeychainError {
    NotFound,
    Refused,
    Other(i32),
}

impl KeychainError {
    fn from_status(s: i32) -> Self {
        match s {
            ERR_NOT_FOUND => KeychainError::NotFound,
            ERR_USER_CANCELED | ERR_AUTH_FAILED | ERR_INTERACTION_NOT_ALLOWED => KeychainError::Refused,
            other => KeychainError::Other(other),
        }
    }

    // One line, no token. Used by the command for its error text.
    pub(crate) fn describe(&self) -> String {
        match self {
            KeychainError::NotFound => "no Keychain item for the human token (start the Cubilot app first)".to_string(),
            KeychainError::Refused => "Touch ID or password prompt refused".to_string(),
            KeychainError::Other(s) => format!("Keychain error {s}"),
        }
    }
}

// The attributes of the item, without the secret. Pure; the test reads it with a test service name.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ItemSpec {
    pub service: String,
    pub account: String,
    pub flags: usize,
    pub data_protection_keychain: bool,
    pub this_device_only: bool,
}

// File-based keychain on purpose: the data protection keychain answers -34018 (missing entitlement) to an ad-hoc signed app.
pub(crate) fn item_spec(service: &str) -> ItemSpec {
    ItemSpec {
        service: service.to_string(),
        account: ACCOUNT.to_string(),
        flags: FLAG_USER_PRESENCE,
        data_protection_keychain: false,
        this_device_only: true,
    }
}

fn key(k: CFStringRef) -> CFString {
    unsafe { CFString::wrap_under_get_rule(k) }
}

fn identity_query(service: &str, account: &str) -> Vec<(CFString, CFType)> {
    vec![
        (key(unsafe { kSecClass }), unsafe { CFType::wrap_under_get_rule(kSecClassGenericPassword as CFTypeRef) }),
        (key(unsafe { kSecAttrService }), CFString::new(service).as_CFType()),
        (key(unsafe { kSecAttrAccount }), CFString::new(account).as_CFType()),
        (key(unsafe { kSecUseDataProtectionKeychain }), CFBoolean::false_value().as_CFType()),
    ]
}

// Replaces the item. The previous launch's token goes first; the new item needs user presence to read.
pub(crate) fn store_with(service: &str, token: &str) -> Result<(), KeychainError> {
    let spec = item_spec(service);
    unsafe {
        let status = SecItemDelete(CFDictionary::from_CFType_pairs(&identity_query(&spec.service, &spec.account)).as_concrete_TypeRef());
        if status != 0 && status != ERR_NOT_FOUND {
            return Err(KeychainError::from_status(status));
        }
        let mut err: *mut c_void = ptr::null_mut();
        let acl = SecAccessControlCreateWithFlags(
            ptr::null(),
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly as CFTypeRef,
            spec.flags,
            &mut err,
        );
        if acl.is_null() {
            if !err.is_null() {
                CFRelease(err as CFTypeRef);
            }
            return Err(KeychainError::Other(-1));
        }
        let acl = CFType::wrap_under_create_rule(acl);
        let mut pairs = identity_query(&spec.service, &spec.account);
        pairs.push((key(kSecAttrAccessControl), acl));
        pairs.push((key(kSecValueData), CFData::from_buffer(token.as_bytes()).as_CFType()));
        let status = SecItemAdd(CFDictionary::from_CFType_pairs(&pairs).as_concrete_TypeRef(), ptr::null_mut());
        if status != 0 {
            return Err(KeychainError::from_status(status));
        }
    }
    Ok(())
}

// Returns the token. The caller must pass the presence gate first (cli.rs does); this read shows no prompt by itself.
pub(crate) fn read_with(service: &str) -> Result<String, KeychainError> {
    let spec = item_spec(service);
    let mut pairs = identity_query(&spec.service, &spec.account);
    pairs.push((key(unsafe { kSecReturnData }), CFBoolean::true_value().as_CFType()));
    pairs.push((key(unsafe { kSecMatchLimit }), unsafe { CFType::wrap_under_get_rule(kSecMatchLimitOne as CFTypeRef) }));
    pairs.push((key(unsafe { kSecUseOperationPrompt }), CFString::new("read the Cubilot human token").as_CFType()));
    let mut out: CFTypeRef = ptr::null();
    let status = unsafe { SecItemCopyMatching(CFDictionary::from_CFType_pairs(&pairs).as_concrete_TypeRef(), &mut out) };
    if status != 0 {
        return Err(KeychainError::from_status(status));
    }
    if out.is_null() {
        return Err(KeychainError::NotFound);
    }
    let value = unsafe { CFType::wrap_under_create_rule(out) };
    if unsafe { CFGetTypeID(value.as_CFTypeRef()) } != CFData::type_id() {
        return Err(KeychainError::Other(-2));
    }
    let data = unsafe { CFData::wrap_under_get_rule(value.as_CFTypeRef() as CFDataRef) };
    String::from_utf8(data.bytes().to_vec()).map_err(|_| KeychainError::Other(-3))
}

pub(crate) fn store_human_token(token: &str) -> Result<(), KeychainError> {
    store_with(SERVICE, token)
}

pub(crate) fn read_human_token() -> Result<String, KeychainError> {
    read_with(SERVICE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_item_has_the_service_account_and_user_presence_flag() {
        let s = item_spec("Cubilot-test");
        assert_eq!(s.service, "Cubilot-test");
        assert_eq!(s.account, "human-token");
        assert_eq!(s.flags, 1, "kSecAccessControlUserPresence");
        assert!(!s.data_protection_keychain, "the data protection keychain needs an entitlement an ad-hoc app lacks (-34018)");
        assert!(s.this_device_only);
        assert_eq!((SERVICE, ACCOUNT), ("Cubilot", "human-token"));
    }

    #[test]
    fn statuses_map_to_causes_without_a_token() {
        assert_eq!(KeychainError::from_status(-25300), KeychainError::NotFound);
        assert_eq!(KeychainError::from_status(-128), KeychainError::Refused);
        assert_eq!(KeychainError::from_status(-25293), KeychainError::Refused);
        assert_eq!(KeychainError::from_status(-34018), KeychainError::Other(-34018));
        assert!(KeychainError::NotFound.describe().contains("no Keychain item"));
        assert!(KeychainError::Refused.describe().contains("refused"));
    }

    // Reading an absent item never prompts: it returns not-found (or an entitlement error on an unsigned test binary).
    #[test]
    fn reading_a_missing_item_fails_without_a_value() {
        let r = read_with(&format!("Cubilot-test-missing-{}", std::process::id()));
        assert!(r.is_err());
    }

    // Live Keychain write with a test service name and a dummy value. Run by hand: cargo test -- --ignored keychain_live
    // (never reads the item back: a read shows the Touch ID prompt). Cleans up with SecItemDelete.
    #[test]
    #[ignore]
    fn keychain_live_store_reports_a_status() {
        let svc = format!("Cubilot-test-live-{}", std::process::id());
        let r = store_with(&svc, "dummy-not-a-token");
        eprintln!("live store result: {r:?}");
        let spec = item_spec(&svc);
        unsafe {
            SecItemDelete(CFDictionary::from_CFType_pairs(&identity_query(&spec.service, &spec.account)).as_concrete_TypeRef());
        }
    }
}
