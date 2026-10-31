// The human token of one app launch, in one macOS Keychain item whose access object (SecAccessCreate) has an EMPTY trusted
// application list. macOS then asks the login password at each read, by each app, also Cubilot. The shell stores the item
// at start. No file and no env holds the token. SecAccessCreate is deprecated; the human accepted it (msg 814).
// Raw Security.framework calls through the core-foundation crate (already in Cargo.lock): no new dependency.

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_foundation_sys::base::{CFGetTypeID, CFRelease, CFTypeRef, OSStatus};
use core_foundation_sys::data::CFDataRef;
use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation_sys::dictionary::CFDictionaryRef;
use core_foundation_sys::string::CFStringRef;
use std::ptr;

pub(crate) const SERVICE: &str = "Cubilot";
pub(crate) const ACCOUNT: &str = "human-token";

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
    static kSecAttrAccess: CFStringRef;
    static kSecACLAuthorizationDecrypt: CFStringRef;
    static kSecReturnRef: CFStringRef;
    static kSecValueData: CFStringRef;
    static kSecReturnData: CFStringRef;
    static kSecMatchLimit: CFStringRef;
    static kSecMatchLimitOne: CFStringRef;
    static kSecUseDataProtectionKeychain: CFStringRef;
    fn SecAccessCreate(descriptor: CFStringRef, trusted_list: CFArrayRef, access: *mut CFTypeRef) -> OSStatus;
    fn SecAccessCopyMatchingACLList(access: CFTypeRef, authorization_tag: CFTypeRef) -> CFArrayRef;
    fn SecACLCopyContents(acl: CFTypeRef, applications: *mut CFArrayRef, description: *mut CFStringRef, selector: *mut u16) -> OSStatus;
    fn SecKeychainItemCopyAccess(item: CFTypeRef, access: *mut CFTypeRef) -> OSStatus;
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
            KeychainError::Refused => "login password prompt refused".to_string(),
            KeychainError::Other(s) => format!("Keychain error {s}"),
        }
    }
}

// The attributes of the item, without the secret. Pure; the test reads it with a test service name.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ItemSpec {
    pub service: String,
    pub account: String,
    pub trusted_applications: usize,
    pub data_protection_keychain: bool,
}

// File-based keychain on purpose (SecAccess is a file keychain API): the data protection keychain answers -34018 (missing entitlement) to an ad-hoc signed app.
pub(crate) fn item_spec(service: &str) -> ItemSpec {
    ItemSpec {
        service: service.to_string(),
        account: ACCOUNT.to_string(),
        trusted_applications: 0,
        data_protection_keychain: false,
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

// Replaces the item. The previous launch's token goes first. The access object has an empty trusted list (not NULL: NULL
// would trust the creating app), so every read asks the login password.
pub(crate) fn store_with(service: &str, token: &str) -> Result<(), KeychainError> {
    let spec = item_spec(service);
    unsafe {
        let status = SecItemDelete(CFDictionary::from_CFType_pairs(&identity_query(&spec.service, &spec.account)).as_concrete_TypeRef());
        if status != 0 && status != ERR_NOT_FOUND {
            return Err(KeychainError::from_status(status));
        }
        let trusted: CFArray<CFType> = CFArray::from_CFTypes(&[]);
        let mut access: CFTypeRef = ptr::null();
        let status = SecAccessCreate(CFString::new("Cubilot human token").as_concrete_TypeRef(), trusted.as_concrete_TypeRef(), &mut access);
        if status != 0 || access.is_null() {
            return Err(KeychainError::Other(status));
        }
        let access = CFType::wrap_under_create_rule(access);
        let mut pairs = identity_query(&spec.service, &spec.account);
        pairs.push((key(kSecAttrAccess), access));
        pairs.push((key(kSecValueData), CFData::from_buffer(token.as_bytes()).as_CFType()));
        let status = SecItemAdd(CFDictionary::from_CFType_pairs(&pairs).as_concrete_TypeRef(), ptr::null_mut());
        if status != 0 {
            return Err(KeychainError::from_status(status));
        }
    }
    Ok(())
}

// Reads the access object of the item (no secret read, no prompt) and returns, for every decrypt ACL entry, Some(n) for a
// trusted list of n applications or None for "any application".
pub(crate) fn decrypt_acl_trusted_applications(service: &str) -> Result<Vec<Option<usize>>, KeychainError> {
    let spec = item_spec(service);
    let mut pairs = identity_query(&spec.service, &spec.account);
    pairs.push((key(unsafe { kSecReturnRef }), CFBoolean::true_value().as_CFType()));
    pairs.push((key(unsafe { kSecMatchLimit }), unsafe { CFType::wrap_under_get_rule(kSecMatchLimitOne as CFTypeRef) }));
    let mut item: CFTypeRef = ptr::null();
    let status = unsafe { SecItemCopyMatching(CFDictionary::from_CFType_pairs(&pairs).as_concrete_TypeRef(), &mut item) };
    if status != 0 || item.is_null() {
        return Err(KeychainError::from_status(status));
    }
    let item = unsafe { CFType::wrap_under_create_rule(item) };
    let mut access: CFTypeRef = ptr::null();
    let status = unsafe { SecKeychainItemCopyAccess(item.as_CFTypeRef(), &mut access) };
    if status != 0 || access.is_null() {
        return Err(KeychainError::Other(status));
    }
    let access = unsafe { CFType::wrap_under_create_rule(access) };
    let acls = unsafe { SecAccessCopyMatchingACLList(access.as_CFTypeRef(), kSecACLAuthorizationDecrypt as CFTypeRef) };
    if acls.is_null() {
        return Err(KeychainError::Other(-4));
    }
    let acls = unsafe { CFType::wrap_under_create_rule(acls as CFTypeRef) };
    let acls = acls.as_CFTypeRef() as CFArrayRef;
    let mut out = Vec::new();
    for i in 0..unsafe { CFArrayGetCount(acls) } {
        let acl = unsafe { CFArrayGetValueAtIndex(acls, i) } as CFTypeRef;
        let mut apps: CFArrayRef = ptr::null();
        let mut desc: CFStringRef = ptr::null();
        let mut selector: u16 = 0;
        let status = unsafe { SecACLCopyContents(acl, &mut apps, &mut desc, &mut selector) };
        if status != 0 {
            return Err(KeychainError::Other(status));
        }
        if !desc.is_null() {
            unsafe { CFRelease(desc as CFTypeRef) };
        }
        if apps.is_null() {
            out.push(None);
        } else {
            out.push(Some(unsafe { CFArrayGetCount(apps) } as usize));
            unsafe { CFRelease(apps as CFTypeRef) };
        }
    }
    Ok(out)
}

// Returns the token. macOS shows the login password prompt for this read (empty trusted list).
pub(crate) fn read_with(service: &str) -> Result<String, KeychainError> {
    let spec = item_spec(service);
    let mut pairs = identity_query(&spec.service, &spec.account);
    pairs.push((key(unsafe { kSecReturnData }), CFBoolean::true_value().as_CFType()));
    pairs.push((key(unsafe { kSecMatchLimit }), unsafe { CFType::wrap_under_get_rule(kSecMatchLimitOne as CFTypeRef) }));
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
    fn the_item_has_the_service_account_and_no_trusted_application() {
        let s = item_spec("Cubilot-test");
        assert_eq!(s.service, "Cubilot-test");
        assert_eq!(s.account, "human-token");
        assert_eq!(s.trusted_applications, 0);
        assert!(!s.data_protection_keychain);
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

    // Live Keychain round trip with a test service name and a dummy value. Stores the item, reads back the access object
    // (no secret read, so no prompt) and asserts that every decrypt ACL entry has an empty trusted-application list. Deletes
    // the item. Needs the login keychain of a Mac.
    #[test]
    fn keychain_live_access_object_has_an_empty_trusted_list() {
        let svc = format!("Cubilot-test-live-{}", std::process::id());
        let stored = store_with(&svc, "dummy-not-a-token");
        let acl = decrypt_acl_trusted_applications(&svc);
        let spec = item_spec(&svc);
        unsafe {
            SecItemDelete(CFDictionary::from_CFType_pairs(&identity_query(&spec.service, &spec.account)).as_concrete_TypeRef());
        }
        stored.expect("store");
        let acl = acl.expect("read back the access object");
        assert!(!acl.is_empty(), "a decrypt ACL entry exists");
        assert!(acl.iter().all(|a| *a == Some(0)), "empty trusted list, not any application: {acl:?}");
    }
}
