//! Current-user Windows DPAPI storage. Never stores a plaintext fallback and never prompts.
use serde_json::Value;
use std::{fs, path::Path};
#[cfg(windows)] use std::{io::Write, path::PathBuf};
#[cfg(windows)] use zeroize::Zeroizing;
const MAGIC: &[u8] = b"TELEPORT-DPAPI-V1\0";
const MAX_BYTES: u64 = 1_048_576;

#[cfg(windows)] mod win {
    use std::{ffi::c_void, ptr};
    #[repr(C)] struct Blob { len: u32, data: *mut u8 }
    #[link(name="crypt32")] unsafe extern "system" {
        fn CryptProtectData(input: *const Blob, description: *const u16, entropy: *const Blob, reserved: *mut c_void, prompt: *const c_void, flags: u32, output: *mut Blob) -> i32;
        fn CryptUnprotectData(input: *const Blob, description: *mut *mut u16, entropy: *const Blob, reserved: *mut c_void, prompt: *const c_void, flags: u32, output: *mut Blob) -> i32;
    }
    #[link(name="kernel32")] unsafe extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    pub fn crypt(bytes: &[u8], protect: bool) -> Result<Vec<u8>,String> {
        if bytes.is_empty() || bytes.len()>super::MAX_BYTES as usize {return Err("invalid_store_size".into());}
        // Flags 1 = CRYPTPROTECT_UI_FORBIDDEN. No LOCAL_MACHINE flag: bind to current user.
        let input=Blob{len:bytes.len() as u32,data:bytes.as_ptr() as *mut u8};
        let mut output=Blob{len:0,data:ptr::null_mut()};
        let ok=unsafe {if protect {CryptProtectData(&input,ptr::null(),ptr::null(),ptr::null_mut(),ptr::null(),1,&mut output)} else {CryptUnprotectData(&input,ptr::null_mut(),ptr::null(),ptr::null_mut(),ptr::null(),1,&mut output)}};
        if ok==0 {return Err("secure_storage_unavailable".into());}
        if output.data.is_null() || output.len==0 || output.len as u64>super::MAX_BYTES {
            if !output.data.is_null() {unsafe{LocalFree(output.data.cast());}}
            return Err("invalid_store_size".into());
        }
        let result=unsafe{std::slice::from_raw_parts(output.data,output.len as usize).to_vec()};
        unsafe {ptr::write_bytes(output.data,0,output.len as usize);LocalFree(output.data.cast());}
        Ok(result)
    }
    pub fn replace(from:&std::path::Path,to:&std::path::Path)->Result<(),String>{
        use std::os::windows::ffi::OsStrExt;
        let a:Vec<u16>=from.as_os_str().encode_wide().chain(Some(0)).collect();
        let b:Vec<u16>=to.as_os_str().encode_wide().chain(Some(0)).collect();
        // Same-directory atomic replacement, requesting write-through. No delete-before-rename gap.
        if unsafe{MoveFileExW(a.as_ptr(),b.as_ptr(),1|8)}==0 {return Err("secure_store_replace_failed".into());} Ok(())
    }
}

pub fn load(path:&Path)->Result<Option<Value>,String>{
    let meta=match fs::metadata(path){Ok(v)=>v,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err("secure_store_read_failed".into())};
    if !meta.is_file() || meta.len()>MAX_BYTES || meta.len()<MAGIC.len() as u64{return Err("invalid_secure_store".into());}
    let encrypted=fs::read(path).map_err(|_|"secure_store_read_failed")?;
    if !encrypted.starts_with(MAGIC){return Err("invalid_secure_store".into());}
    #[cfg(windows)] {
        let plaintext=Zeroizing::new(win::crypt(&encrypted[MAGIC.len()..],false)?);
        let value=serde_json::from_slice(&plaintext).map_err(|_|"invalid_secure_store")?;
        Ok(Some(value))
    }
    #[cfg(not(windows))] {Err("windows_secure_storage_required".into())}
}
pub fn save(path:&Path,value:&Value)->Result<(),String>{
    #[cfg(not(windows))] {let _=(path,value);Err("windows_secure_storage_required".into())}
    #[cfg(windows)] {
        let plaintext=Zeroizing::new(serde_json::to_vec(value).map_err(|_|"invalid_store_value")?);
        let encrypted=win::crypt(&plaintext,true)?;
        if encrypted.len()+MAGIC.len()>MAX_BYTES as usize{return Err("invalid_store_size".into());}
        let parent=path.parent().ok_or("invalid_store_path")?;
        fs::create_dir_all(parent).map_err(|_|"secure_store_directory_failed")?;
        let temp:PathBuf=parent.join(format!(".teleport-{}.tmp",crate::protocol::random_token()));
        let result=(||{
            let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|_|"secure_store_write_failed")?;
            file.write_all(MAGIC).and_then(|_|file.write_all(&encrypted)).and_then(|_|file.sync_all()).map_err(|_|"secure_store_write_failed")?;
            drop(file);win::replace(&temp,path)
        })();
        if result.is_err(){let _=fs::remove_file(&temp);} result
    }
}
pub fn clear(path:&Path)->Result<(),String>{
    match fs::remove_file(path){Ok(())=>Ok(()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(()),Err(_)=>Err("secure_store_remove_failed".into())}
}

#[cfg(test)] mod tests{
    use super::*;
    #[test] fn refuses_plaintext_store(){
        let dir=std::env::temp_dir().join(format!("teleport-store-test-{}",crate::protocol::random_token()));fs::create_dir_all(&dir).unwrap();let path=dir.join("identity.enc");fs::write(&path,b"{\"secretKey\":\"TEST-ONLY-NOT-A-REAL-SECRET\"}").unwrap();assert!(load(&path).is_err());fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(not(windows))] #[test] fn nonwindows_has_no_plaintext_fallback(){
        let path=std::env::temp_dir().join(format!("teleport-unavailable-{}",crate::protocol::random_token()));assert!(save(&path,&serde_json::json!({"test":"only"})).is_err());assert!(!path.exists());
    }
    #[cfg(windows)] #[test] fn windows_dpapi_roundtrip_and_atomic_replace(){
        let dir=std::env::temp_dir().join(format!("teleport-store-test-{}",crate::protocol::random_token()));let path=dir.join("identity.enc");let value=serde_json::json!({"secretKey":"TEST-ONLY-NOT-A-REAL-SECRET"});save(&path,&value).unwrap();assert_eq!(load(&path).unwrap(),Some(value));assert!(!String::from_utf8_lossy(&fs::read(&path).unwrap()).contains("TEST-ONLY-NOT-A-REAL-SECRET"));save(&path,&serde_json::json!({"replacement":true})).unwrap();assert_eq!(load(&path).unwrap(),Some(serde_json::json!({"replacement":true})));clear(&path).unwrap();assert_eq!(load(&path).unwrap(),None);fs::remove_dir_all(dir).unwrap();
    }
}
