//! A per-profile encryption key lives in the login Keychain; only authenticated
//! ciphertext reaches disk. Keychain access fails closed without showing prompts.
//! Existing Electron identities are neither read, migrated, nor reset.
use crypto_secretbox::{aead::{Aead, AeadCore, KeyInit, OsRng}, XSalsa20Poly1305, Nonce};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{ffi::c_void, fs, io::Write, os::unix::fs::{OpenOptionsExt, PermissionsExt}, path::Path, ptr};
use zeroize::{Zeroize, Zeroizing};
const MAGIC: &[u8] = b"TELEPORT-KEYCHAIN-V1\0";
const NONCE_BYTES: usize = 24;
type CFRef = *const c_void;

#[link(name="CoreFoundation",kind="framework")]
unsafe extern "C" {
    fn CFStringCreateWithBytes(allocator:CFRef, bytes:*const u8, len:isize, encoding:u32, external:u8)->CFRef;
    fn CFDictionaryCreate(allocator:CFRef, keys:*const CFRef, values:*const CFRef, count:isize, key_callbacks:CFRef, value_callbacks:CFRef)->CFRef;
    fn CFDataCreate(allocator:CFRef, bytes:*const u8, len:isize)->CFRef;
    fn CFDataGetLength(data:CFRef)->isize;
    fn CFDataGetBytePtr(data:CFRef)->*const u8;
    fn CFGetTypeID(value:CFRef)->usize;
    fn CFDataGetTypeID()->usize;
    fn CFRelease(value:CFRef);
    static kCFBooleanTrue: CFRef;
}
#[link(name="Security",kind="framework")]
unsafe extern "C" {
    fn SecItemCopyMatching(query:CFRef,result:*mut CFRef)->i32;
    fn SecItemAdd(attributes:CFRef,result:*mut CFRef)->i32;
    static kSecClass:CFRef;
    static kSecClassGenericPassword:CFRef;
    static kSecAttrService:CFRef;
    static kSecAttrAccount:CFRef;
    static kSecReturnData:CFRef;
    static kSecValueData:CFRef;
    static kSecUseAuthenticationUI:CFRef;
    static kSecUseAuthenticationUIFail:CFRef;
}
struct Owned(CFRef);
impl Drop for Owned {fn drop(&mut self){unsafe{CFRelease(self.0)}}}
impl Owned {
    fn checked(value:CFRef)->Result<Self,String>{if value.is_null(){Err("secure_storage_unavailable".into())}else{Ok(Self(value))}}
    fn string(value:&str)->Result<Self,String>{unsafe{Self::checked(CFStringCreateWithBytes(ptr::null(),value.as_ptr(),value.len() as isize,0x08000100,0))}}
    // Null callbacks intentionally do not retain/release; every referenced object
    // is held alive by its owner across the synchronous Security call.
    fn dict(entries:&[(CFRef,CFRef)])->Result<Self,String>{let keys:Vec<_>=entries.iter().map(|v|v.0).collect();let values:Vec<_>=entries.iter().map(|v|v.1).collect();unsafe{Self::checked(CFDictionaryCreate(ptr::null(),keys.as_ptr(),values.as_ptr(),entries.len() as isize,ptr::null(),ptr::null()))}}
}
fn account(path:&Path)->Result<String,String>{
    // Canonical parent prevents aliases selecting different Keychain entries.
    let parent=path.parent().ok_or("invalid_store_path")?.canonicalize().map_err(|_|"secure_store_directory_failed")?;
    let file=path.file_name().ok_or("invalid_store_path")?;
    use std::os::unix::ffi::OsStrExt;
    Ok(format!("profile-{:x}",Sha256::digest(parent.join(file).as_os_str().as_bytes())))
}
fn key(path:&Path,create:bool)->Result<Zeroizing<Vec<u8>>,String>{
    let service=Owned::string("dev.teleport.macos.lightweight.storage.v1")?;
    let account=Owned::string(&account(path)?)?;
    let base=unsafe{vec![(kSecClass,kSecClassGenericPassword),(kSecAttrService,service.0),(kSecAttrAccount,account.0),(kSecUseAuthenticationUI,kSecUseAuthenticationUIFail)]};
    let read=||->Result<Option<Zeroizing<Vec<u8>>>,String>{
        let mut entries=base.clone();entries.push(unsafe{(kSecReturnData,kCFBooleanTrue)});
        let query=Owned::dict(&entries)?;let mut result=ptr::null();
        let status=unsafe{SecItemCopyMatching(query.0,&mut result)};
        if status == -25300 {return Ok(None)} // errSecItemNotFound only
        if status != 0 {return Err("secure_storage_unavailable".into())}
        let data=Owned::checked(result)?;
        if unsafe{CFGetTypeID(data.0)!=CFDataGetTypeID() || CFDataGetLength(data.0)!=32}{return Err("invalid_secure_store_key".into())}
        let bytes=unsafe{CFDataGetBytePtr(data.0)};if bytes.is_null(){return Err("invalid_secure_store_key".into())}
        Ok(Some(Zeroizing::new(unsafe{std::slice::from_raw_parts(bytes,32)}.to_vec())))
    };
    if let Some(value)=read()?{return Ok(value)}
    if !create{return Err("secure_store_key_missing".into())}
    let mut generated=XSalsa20Poly1305::generate_key(&mut OsRng);
    let bytes=Zeroizing::new(generated.to_vec());generated.as_mut_slice().zeroize();
    let data=unsafe{Owned::checked(CFDataCreate(ptr::null(),bytes.as_ptr(),bytes.len() as isize))?};
    let mut entries=base;entries.push(unsafe{(kSecValueData,data.0)});
    let query=Owned::dict(&entries)?;
    let status=unsafe{SecItemAdd(query.0,ptr::null_mut())};
    if status != 0 && status != -25299 {return Err("secure_storage_unavailable".into())} // duplicate: another writer won
    // Re-read the stored key, including when another process created it first.
    // No existing key is ever overwritten to "repair" a decryption failure.
    key(path,false)
}
fn encrypt(value:&Value,key:&[u8])->Result<Vec<u8>,String>{
    let plaintext=Zeroizing::new(serde_json::to_vec(value).map_err(|_|"invalid_store_value")?);
    if plaintext.len()+MAGIC.len()+NONCE_BYTES+16>super::MAX_BYTES as usize{return Err("invalid_store_size".into())}
    let cipher=XSalsa20Poly1305::new_from_slice(key).map_err(|_|"invalid_secure_store_key")?;
    let nonce=XSalsa20Poly1305::generate_nonce(&mut OsRng);
    let encrypted=cipher.encrypt(&nonce,plaintext.as_slice()).map_err(|_|"secure_store_encrypt_failed")?;
    let mut output=MAGIC.to_vec();output.extend_from_slice(&nonce);output.extend_from_slice(&encrypted);Ok(output)
}
fn decrypt(bytes:&[u8],key:&[u8])->Result<Value,String>{
    if !bytes.starts_with(MAGIC)||bytes.len()<MAGIC.len()+NONCE_BYTES+16||bytes.len()>super::MAX_BYTES as usize{return Err("invalid_secure_store".into())}
    let cipher=XSalsa20Poly1305::new_from_slice(key).map_err(|_|"invalid_secure_store_key")?;
    let nonce=Nonce::from_slice(&bytes[MAGIC.len()..MAGIC.len()+NONCE_BYTES]);
    let plaintext=Zeroizing::new(cipher.decrypt(nonce,&bytes[MAGIC.len()+NONCE_BYTES..]).map_err(|_|"invalid_secure_store")?);
    serde_json::from_slice(&plaintext).map_err(|_|"invalid_secure_store".into())
}
pub fn load(path:&Path)->Result<Option<Value>,String>{
    let meta=match fs::symlink_metadata(path){Ok(v)=>v,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err("secure_store_read_failed".into())};
    if !meta.is_file()||meta.len()>super::MAX_BYTES||meta.permissions().mode()&0o077!=0{return Err("invalid_secure_store".into())}
    let bytes=fs::read(path).map_err(|_|"secure_store_read_failed")?;
    if !bytes.starts_with(MAGIC){return Err("invalid_secure_store".into())}
    Ok(Some(decrypt(&bytes,&key(path,false)?)?))
}
pub fn save(path:&Path,value:&Value)->Result<(),String>{
    let parent=path.parent().ok_or("invalid_store_path")?;
    fs::create_dir_all(parent).map_err(|_|"secure_store_directory_failed")?;
    // An existing file must remain decryptable before any overwrite; do not
    // replace an unreadable identity with a freshly generated encryption key.
    if fs::symlink_metadata(path).is_ok(){load(path)?;}
    let bytes=encrypt(value,&key(path,true)?)?;
    let temp=parent.join(format!(".teleport-{}.tmp",crate::protocol::random_token()));
    let result=(||{
        let mut file=fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp).map_err(|_|"secure_store_write_failed")?;
        file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|_|"secure_store_write_failed")?;
        drop(file);fs::rename(&temp,path).map_err(|_|"secure_store_replace_failed")?;
        Ok(())
    })();
    if result.is_err(){let _=fs::remove_file(&temp);}result
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn authenticated_roundtrip_rejects_tampering_and_wrong_key(){
        let value=serde_json::json!({"endpoint":"https://saved-relay.example","secretKey":"TEST-ONLY"});
        let mut bytes=encrypt(&value,&[7;32]).unwrap();assert_eq!(decrypt(&bytes,&[7;32]).unwrap(),value);
        assert!(!String::from_utf8_lossy(&bytes).contains("TEST-ONLY"));assert!(decrypt(&bytes,&[8;32]).is_err());
        let last=bytes.len()-1;bytes[last]^=1;assert!(decrypt(&bytes,&[7;32]).is_err());
        assert!(decrypt(b"plaintext",&[7;32]).is_err());
    }
    #[test] fn missing_profile_does_not_access_keychain(){
        let path=std::env::temp_dir().join(format!("teleport-missing-{}",crate::protocol::random_token()));assert_eq!(load(&path).unwrap(),None);
    }
}
