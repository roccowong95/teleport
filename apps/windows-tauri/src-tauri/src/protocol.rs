//! Teleport wire v1: TweetNaCl-compatible X25519/XSalsa20-Poly1305, never ChaChaBox.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use crypto_box::{aead::{Aead, AeadCore, OsRng, rand_core::RngCore, generic_array::GenericArray}, PublicKey, SalsaBox, SecretKey};
use crypto_secretbox::Kdf;
use curve25519_dalek::montgomery::MontgomeryPoint;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

fn b64(bytes: &[u8]) -> String { URL_SAFE_NO_PAD.encode(bytes) }
fn decode(input: &str, length: Option<usize>) -> Result<Vec<u8>, String> {
    if input.is_empty() || input.len() > 40000 { return Err("invalid_encoding".into()); }
    let bytes = URL_SAFE_NO_PAD.decode(input).map_err(|_| "invalid_encoding")?;
    if length.is_some_and(|n| n != bytes.len()) || b64(&bytes) != input { return Err("invalid_encoding".into()); }
    Ok(bytes)
}
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| "invalid_message".into())
}
fn context_ok(context: &Value) -> Result<(), String> {
    for key in ["roomId", "sender", "recipient"] { if field(context,key)?.is_empty() { return Err("invalid_context".into()); } }
    Ok(())
}
fn keys(peer: &str, secret: &str) -> Result<(PublicKey, SecretKey, Zeroizing<[u8;32]>), String> {
    let pk: [u8;32] = decode(peer,Some(32))?.try_into().map_err(|_| "invalid_key")?;
    let sk_bytes = Zeroizing::new(decode(secret,Some(32))?);
    let mut sk: [u8;32] = sk_bytes.as_slice().try_into().map_err(|_| "invalid_key")?;
    let shared = Zeroizing::new(MontgomeryPoint(pk).mul_clamped(sk).to_bytes());
    if shared.iter().all(|b| *b == 0) { sk.zeroize(); return Err("invalid_peer_key".into()); }
    let key = SecretKey::from(sk); sk.zeroize();
    Ok((PublicKey::from(pk), key, shared))
}
pub fn generate_identity() -> Result<Value,String> {
    // OsRng fails rather than falling back to an insecure generator.
    let sk = SecretKey::generate(&mut OsRng);
    Ok(json!({"publicKey":b64(sk.public_key().as_bytes()),"secretKey":b64(&sk.to_bytes())}))
}
pub fn random_token() -> String { let mut bytes = Zeroizing::new([0u8;32]); OsRng.fill_bytes(bytes.as_mut()); b64(bytes.as_ref()) }
pub fn seal(payload: &Value, context: &Value, peer: &str, secret: &str) -> Result<Value,String> {
    context_ok(context)?;
    if !payload.is_object() { return Err("invalid_payload".into()); }
    let plaintext = Zeroizing::new(serde_json::to_vec(&json!({"v":1,"context":context,"payload":payload})).map_err(|_| "invalid_payload")?);
    if plaintext.len() > 20000 { return Err("payload_too_large".into()); }
    let (pk,sk,_) = keys(peer,secret)?;
    let nonce = SalsaBox::generate_nonce(&mut OsRng);
    let ciphertext = SalsaBox::new(&pk,&sk).encrypt(&nonce,plaintext.as_slice()).map_err(|_| "encryption_failed")?;
    Ok(json!({"v":1,"nonce":b64(&nonce),"ciphertext":b64(&ciphertext)}))
}
pub fn open(envelope: &Value, expected: &Value, peer: &str, secret: &str) -> Result<Value,String> {
    context_ok(expected)?;
    if envelope.get("v").and_then(Value::as_u64) != Some(1) { return Err("invalid_envelope".into()); }
    let ciphertext = decode(field(envelope,"ciphertext")?,None)?;
    if !(16..=20016).contains(&ciphertext.len()) { return Err("invalid_envelope".into()); }
    let nonce = decode(field(envelope,"nonce")?,Some(24))?;
    let (pk,sk,_) = keys(peer,secret)?;
    let plaintext = Zeroizing::new(SalsaBox::new(&pk,&sk).decrypt(GenericArray::from_slice(&nonce),ciphertext.as_slice()).map_err(|_| "authentication_failed")?);
    let msg: Value = serde_json::from_slice(&plaintext).map_err(|_| "invalid_payload")?;
    if msg.get("v").and_then(Value::as_u64) != Some(1) || ["roomId","sender","recipient"].iter().any(|key| msg["context"].get(key) != expected.get(key)) { return Err("context_mismatch".into()); }
    if !msg["payload"].is_object() { return Err("invalid_payload".into()); }
    Ok(msg["payload"].clone())
}
pub fn sas(secret: &str, peer: &str, room: &str) -> Result<String,String> {
    let (_,_,shared) = keys(peer,secret)?;
    // NaCl box.before = HSalsa20(raw X25519, 16 zero bytes), not raw X25519.
    let mut before = <salsa20::Salsa20 as Kdf>::kdf(GenericArray::from_slice(shared.as_ref()),&GenericArray::default());
    let mut hasher = Sha256::new(); hasher.update(format!("teleport-pair-v1:{room}:")); hasher.update(&before); before.as_mut_slice().zeroize();
    let bytes = hasher.finalize();
    Ok(format!("{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}",bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5]))
}
pub fn encode_pairing(pair: &Value) -> Result<String,String> {
    // Caller owns endpoint, expiry and room creation. This encodes only the QR fragment,
    // never secretKey/ownerToken. Strict projection prevents accidental private fields.
    let value = json!({"v":1,"endpoint":field(pair,"endpoint")?,"roomId":field(pair,"roomId")?,"pairToken":field(pair,"pairToken")?,"ownerPublicKey":field(pair,"ownerPublicKey")?,"name":field(pair,"name")?,"expiresAt":pair.get("expiresAt").and_then(Value::as_u64).ok_or("invalid_pairing")?});
    decode(field(&value,"pairToken")?,Some(32))?; decode(field(&value,"ownerPublicKey")?,Some(32))?;
    Ok(b64(&serde_json::to_vec(&value).map_err(|_| "invalid_pairing")?))
}

#[cfg(test)] mod tests {
    use super::*;
    fn vector() -> Value { serde_json::from_str(include_str!("protocol-vector.json")).unwrap() }
    #[test] fn opens_tweetnacl_fixed_unicode_vector_and_matches_sas() {
        let v=vector(); assert_eq!(open(&v["envelope"],&v["context"],v["senderPublic"].as_str().unwrap(),v["recipientSecret"].as_str().unwrap()).unwrap(),v["payload"]);
        assert_eq!(sas(v["recipientSecret"].as_str().unwrap(),v["senderPublic"].as_str().unwrap(),v["context"]["roomId"].as_str().unwrap()).unwrap(),v["sas"]);
        let (pk,sk,_)=keys(v["recipientPublic"].as_str().unwrap(),v["senderSecret"].as_str().unwrap()).unwrap();
        let nonce=decode(v["envelope"]["nonce"].as_str().unwrap(),Some(24)).unwrap();
        let ct=SalsaBox::new(&pk,&sk).encrypt(GenericArray::from_slice(&nonce),v["plaintext"].as_str().unwrap().as_bytes()).unwrap();
        assert_eq!(b64(&ct),v["envelope"]["ciphertext"]); // Proves Rust output equals TweetNaCl MAC-prefix format.
    }
    #[test] fn qr_projection_never_exposes_private_fields() {
        let identity=generate_identity().unwrap();
        let pair=json!({"endpoint":"https://relay.example","roomId":"11111111-2222-4333-8444-555555555555","pairToken":random_token(),"ownerPublicKey":identity["publicKey"],"name":"test","expiresAt":123456789,"secretKey":identity["secretKey"],"ownerToken":"must-not-leak"});
        let encoded=encode_pairing(&pair).unwrap();let decoded:Value=serde_json::from_slice(&decode(&encoded,None).unwrap()).unwrap();
        assert!(decoded.get("secretKey").is_none());assert!(decoded.get("ownerToken").is_none());assert_eq!(decoded["v"],1);
    }
    #[test] fn roundtrip_tamper_wrong_context_and_low_order_refused() {
        let a=generate_identity().unwrap(); let b=generate_identity().unwrap(); let c=json!({"roomId":"room","sender":"phone","recipient":"owner"});let p=json!({"kind":"text","text":"你好\n👋"});
        let e=seal(&p,&c,b["publicKey"].as_str().unwrap(),a["secretKey"].as_str().unwrap()).unwrap();
        assert_eq!(open(&e,&c,a["publicKey"].as_str().unwrap(),b["secretKey"].as_str().unwrap()).unwrap(),p);
        let mut wrong=c.clone();wrong["sender"]=json!("attacker"); assert!(open(&e,&wrong,a["publicKey"].as_str().unwrap(),b["secretKey"].as_str().unwrap()).is_err());
        let mut tampered=e.clone();let mut ct=decode(e["ciphertext"].as_str().unwrap(),None).unwrap();ct[0]^=1;tampered["ciphertext"]=json!(b64(&ct));assert!(open(&tampered,&c,a["publicKey"].as_str().unwrap(),b["secretKey"].as_str().unwrap()).is_err());
        assert!(seal(&p,&c,&b64(&[0;32]),a["secretKey"].as_str().unwrap()).is_err());
        assert!(decode("AA==",None).is_err());
        assert_ne!(e["nonce"],seal(&p,&c,b["publicKey"].as_str().unwrap(),a["secretKey"].as_str().unwrap()).unwrap()["nonce"]);
    }
}
