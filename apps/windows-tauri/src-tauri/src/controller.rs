//! Single-owner asynchronous receiver actor. No plaintext or credentials are logged.
//! Transport queues are bounded, discarded on disconnect, and never replayed.
use crate::{input, protocol, store};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, time::{SystemTime, UNIX_EPOCH}};
use tokio::{sync::{mpsc, oneshot}, task::JoinHandle, time::{Duration, Instant}};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;
const TARGET: &str = "Windows focused editable field — no clipboard";
const MAX_FRAME: usize = 28_000;
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| format!("invalid_{key}"))
}
fn normalize_endpoint(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "invalid_endpoint")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if (!matches!(url.scheme(), "https") && !(url.scheme() == "http" && local))
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some()
        || url.fragment().is_some() || url.path() != "/" {
        return Err("https_origin_required".into());
    }
    Ok(url.origin().ascii_serialization())
}
// Classify without exposing request URLs, headers, tokens or remote response bodies.
fn http_error(error:&reqwest::Error) -> &'static str {
    if error.is_timeout() { return "relay_timeout"; }
    if error.is_builder() { return "relay_request_invalid"; }
    if error.is_decode() { return "relay_response_invalid"; }
    if error.is_connect() {
        use std::error::Error;
        let mut source=error.source();
        while let Some(cause)=source {
            let message=cause.to_string().to_ascii_lowercase();
            if message.contains("certificate") || message.contains("tls") || message.contains("ssl") { return "relay_tls_failed"; }
            if message.contains("dns") || message.contains("resolve") || message.contains("name or service") { return "relay_dns_failed"; }
            if message.contains("proxy") || message.contains("tunnel") { return "relay_proxy_failed"; }
            source=cause.source();
        }
        return "relay_connect_failed";
    }
    "relay_unreachable"
}
fn websocket_error(error:tokio_tungstenite::tungstenite::Error)->String {
    use tokio_tungstenite::tungstenite::Error;
    match error {
        Error::Tls(_)=>"relay_tls_failed".into(),
        Error::Http(response)=>format!("relay_websocket_http_{}",response.status().as_u16()),
        Error::Io(error) if error.kind()==std::io::ErrorKind::TimedOut=>"relay_timeout".into(),
        Error::Io(_)=>"relay_connect_failed".into(),
        _=>"relay_websocket_failed".into(),
    }
}

fn validate_state(state: &Value) -> Result<(), String> {
    normalize_endpoint(string(state, "endpoint")?)?;
    Uuid::parse_str(string(state, "roomId")?).map_err(|_| "invalid_room")?;
    if string(state, "ownerToken")?.len() != 43 || !state["peers"].is_object() { return Err("invalid_saved_identity".into()); }
    protocol::sas(string(state,"secretKey")?, string(state,"publicKey")?, string(state,"roomId")?)?;
    for (id, peer) in state["peers"].as_object().ok_or("invalid_saved_peers")? {
        Uuid::parse_str(id).map_err(|_| "invalid_saved_peer")?;
        string(peer,"name")?;
        protocol::sas(string(state,"secretKey")?, string(peer,"publicKey")?, string(state,"roomId")?)?;
    }
    Ok(())
}

// A short non-async lock protects cancellation token installation and resume epochs.
// Emergency calls cancel before waiting for the actor queue (including blocked HTTP).
struct Safety {
    emergency: AtomicBool,
    epoch: AtomicU64,
    transport: AtomicU64,
    active: Mutex<Option<Arc<AtomicBool>>>,
}
impl Safety {
    fn new() -> Self { Self {emergency:AtomicBool::new(true),epoch:AtomicU64::new(0),transport:AtomicU64::new(0),active:Mutex::new(None)} }
    fn cancel(&self) {
        let active=self.active.lock().unwrap_or_else(|e|e.into_inner());
        self.epoch.fetch_add(1,Ordering::SeqCst); self.emergency.store(true,Ordering::SeqCst);
        if let Some(token)=active.as_ref() { token.store(true,Ordering::Release); }
    }
    fn cancel_transport(&self, generation:u64) {
        let active=self.active.lock().unwrap_or_else(|e|e.into_inner());
        if self.transport.load(Ordering::SeqCst)!=generation { return; }
        self.epoch.fetch_add(1,Ordering::SeqCst); self.emergency.store(true,Ordering::SeqCst);
        if let Some(token)=active.as_ref() { token.store(true,Ordering::Release); }
    }
    fn resume(&self, expected:u64) -> Result<(),String> {
        let active=self.active.lock().unwrap_or_else(|e|e.into_inner());
        if active.is_some() { return Err("input_busy".into()); }
        if self.epoch.load(Ordering::SeqCst)!=expected { return Err("newer_stop_requested".into()); }
        self.emergency.store(false,Ordering::SeqCst); Ok(())
    }
    fn begin(&self) -> Result<Arc<AtomicBool>,String> {
        let mut active=self.active.lock().unwrap_or_else(|e|e.into_inner());
        if self.emergency.load(Ordering::SeqCst) { return Err("paused".into()); }
        if active.is_some() { return Err("input_busy".into()); }
        let token=Arc::new(AtomicBool::new(false)); *active=Some(token.clone()); Ok(token)
    }
    fn finish(&self, token:&Arc<AtomicBool>) {
        let mut active=self.active.lock().unwrap_or_else(|e|e.into_inner());
        if active.as_ref().is_some_and(|current|Arc::ptr_eq(current,token)) { *active=None; }
    }
}
#[derive(Clone)]
pub struct Handle { commands: mpsc::Sender<Command>, safety: Arc<Safety> }
struct Command { name: String, args: Value, epoch: u64, reply: oneshot::Sender<Result<Value, String>> }

impl Handle {
    pub async fn call(&self, cmd: &str, args: Value) -> Result<Value, String> {
        if matches!(cmd,"disconnect"|"stop"|"revoke"|"reset") || (cmd=="pause" && args["paused"]==true) { self.safety.cancel(); }
        let epoch=self.safety.epoch.load(Ordering::SeqCst);
        let (reply, answer) = oneshot::channel();
        self.commands.send(Command {name: cmd.into(), args, epoch, reply}).await.map_err(|_| "controller_stopped")?;
        answer.await.map_err(|_| "controller_stopped".to_owned())?
    }
}

/// Call while a Tokio/Tauri async runtime is entered. Loading DPAPI state fails closed.
pub fn start(path: PathBuf, emit: Emit) -> Result<Handle, String> {
    let state = store::load(&path)?;
    if let Some(ref state) = state { validate_state(state)?; }
    let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10)).build().map_err(|_| "http_initialization_failed")?;
    let (commands, rx) = mpsc::channel(32);
    let (events, event_rx) = mpsc::channel(32);
    let safety=Arc::new(Safety::new());
    let actor = Actor {safety:safety.clone(),path, emit, state, http, commands: rx, events, event_rx,
        transport: None, outbound: None, generation: 0, connected: false, stopped: false,
        paused: true, retry: None, attempts: 0, session: Uuid::new_v4().to_string(),
        pending: HashMap::new(), online: HashSet::new(), gate: Gate::default(), injecting: false};
    tokio::spawn(actor.run());
    Ok(Handle {commands,safety})
}

struct Pending { public_key: String, name: String, expires: u64, confirmed: bool }
enum Event { Frame(u64, Value), Closed(u64, Option<String>), Injected { generation: u64, device_id: String, message_id: String, success: bool, token: Arc<AtomicBool> } }
struct Actor {
    safety: Arc<Safety>,
    path: PathBuf, emit: Emit, state: Option<Value>, http: reqwest::Client,
    commands: mpsc::Receiver<Command>, events: mpsc::Sender<Event>, event_rx: mpsc::Receiver<Event>,
    transport: Option<JoinHandle<()>>, outbound: Option<mpsc::Sender<Value>>, generation: u64,
    connected: bool, stopped: bool, paused: bool, retry: Option<Instant>, attempts: u32,
    session: String, pending: HashMap<String, Pending>, online: HashSet<String>, gate: Gate, injecting: bool,
}
impl Actor {
    async fn run(mut self) {
        if self.state.is_some() { self.connect(); }
        self.changed();
        loop {
            let wake = self.retry.unwrap_or_else(|| Instant::now() + Duration::from_secs(86400));
            tokio::select! {
                command = self.commands.recv() => {
                    let Some(command) = command else { self.stop(); break; };
                    let result = self.command_at(&command.name, command.args, command.epoch).await;
                    let _ = command.reply.send(result);
                }
                event = self.event_rx.recv() => if let Some(event) = event {
                    match event {
                        Event::Frame(generation, message) if generation == self.generation => {
                            if self.receive(message).await.is_err() { (self.emit)("notice", json!("Message refused or connection error.")); }
                        }
                        Event::Closed(generation,error) if generation == self.generation => {
                            self.disconnected();
                            if let Some(code)=error { (self.emit)("notice",json!(code)); }
                        },
                        Event::Injected {generation, device_id, message_id, success, token} => {
                            self.safety.finish(&token);
                            let success=success && !token.load(Ordering::Acquire);
                            self.injecting = false;
                            if generation == self.generation && self.online.contains(&device_id) {
                                let ack = if success { json!({"kind":"ack","id":message_id,"status":"injected"}) }
                                    else { json!({"kind":"ack","id":message_id,"status":"unknown","code":"injection_unconfirmed"}) };
                                // ACK loss is intentionally not retried; sender must display unknown.
                                let _ = self.encrypted(&device_id,ack);
                            }
                        },
                        _ => {}
                    }
                },
                _ = tokio::time::sleep_until(wake), if self.retry.is_some() => { self.retry = None; if !self.stopped { self.connect(); } }
            }
        }
    }
    fn status(&self) -> Value {
        let devices = self.state.as_ref().and_then(|s| s["peers"].as_object()).map(|peers| peers.iter().map(|(id,p)| json!({"deviceId":id,"name":p["name"],"online":self.online.contains(id)})).collect::<Vec<_>>()).unwrap_or_default();
        json!({"configured":self.state.is_some(),"disconnected":self.stopped,"connected":self.connected,
            "paused":self.paused || self.safety.emergency.load(Ordering::SeqCst),"name":self.state.as_ref().map(|s| &s["name"]),
            "endpoint":self.state.as_ref().map(|s| &s["endpoint"]),"targetLabel":TARGET,"devices":devices})
    }
    fn changed(&self) { (self.emit)("status", self.status()); }
    fn stop(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.safety.transport.store(self.generation,Ordering::SeqCst);
        self.safety.cancel();
        if let Some(task) = self.transport.take() { task.abort(); }
        self.outbound = None; self.connected = false; self.paused = true; self.stopped = true;
        self.retry = None; self.pending.clear(); self.online.clear(); self.changed();
    }
    fn connect(&mut self) {
        self.stop(); self.stopped = false;
        let Some(state) = self.state.as_ref() else { return; };
        let Ok(endpoint) = string(state,"endpoint") else { return; };
        let Ok(room) = string(state,"roomId") else { return; };
        let Ok(token) = string(state,"ownerToken") else { return; };
        let mut url = match reqwest::Url::parse(&format!("{endpoint}/api/rooms/{room}/ws")) { Ok(u) => u, Err(_) => return };
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" }; let _ = url.set_scheme(scheme);
        let token = token.to_owned();
        self.session = Uuid::new_v4().to_string(); self.gate = Gate::default();
        let (outbound, rx) = mpsc::channel(16); self.outbound = Some(outbound);
        let events = self.events.clone(); let generation = self.generation; let safety=self.safety.clone();
        self.transport = Some(tokio::spawn(async move {
            let error = transport(url.to_string(), token, generation, rx, events.clone(),safety.clone()).await.err();
            safety.cancel_transport(generation);
            let _ = events.send(Event::Closed(generation,error)).await;
        }));
        self.changed();
    }
    fn disconnected(&mut self) {
        self.safety.cancel();
        self.connected = false; self.paused = true; self.online.clear(); self.pending.clear(); self.outbound = None;
        if let Some(task) = self.transport.take() { task.abort(); }
        if !self.stopped {
            let seconds = (1_u64 << self.attempts.min(5)).min(30);
            self.attempts = self.attempts.saturating_add(1); self.retry = Some(Instant::now() + Duration::from_secs(seconds));
        }
        self.changed();
    }
    fn state(&self) -> Result<&Value, String> { self.state.as_ref().ok_or_else(|| "not_configured".into()) }
    fn send(&self, message: Value) -> Result<(), String> {
        if !self.connected { return Err("relay_offline".into()); }
        self.outbound.as_ref().ok_or("relay_offline")?.try_send(message).map_err(|_| "relay_busy_or_offline".into())
    }
    fn encrypted(&self, id: &str, payload: Value) -> Result<(), String> {
        let state = self.state()?; let peer = state["peers"].get(id).ok_or("unauthorized")?;
        let context = json!({"roomId":state["roomId"],"sender":"owner","recipient":id});
        let envelope = protocol::seal(&payload,&context,string(peer,"publicKey")?,string(state,"secretKey")?)?;
        self.send(json!({"type":"relay","to":id,"envelope":envelope}))
    }
    fn ready(&self, id: &str) -> Result<(), String> {
        self.encrypted(id,json!({"kind":"ready","sessionId":self.session,"targetLabel":TARGET,"paused":self.paused || self.safety.emergency.load(Ordering::SeqCst)}))
    }
    async fn request_for(&self, state: &Value, suffix: &str, method: reqwest::Method, body: Option<Value>) -> Result<Value,String> {
        let url = format!("{}/api/rooms{}",string(state,"endpoint")?,suffix);
        let mut request = self.http.request(method,url).bearer_auth(string(state,"ownerToken")?);
        if let Some(body) = body { request = request.json(&body); }
        let mut response = request.send().await.map_err(|error| http_error(&error))?;
        if !response.status().is_success() { return Err(format!("relay_http_{}",response.status().as_u16())); }
        if response.status().as_u16() == 204 { return Ok(json!({})); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "invalid_relay_response")? {
            if bytes.len() + chunk.len() > 16384 { return Err("relay_response_too_large".into()); }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "invalid_relay_response".into())
    }
    #[cfg(test)]
    async fn command(&mut self, command: &str, args: Value) -> Result<Value,String> {
        self.command_at(command,args,self.safety.epoch.load(Ordering::SeqCst)).await
    }
    async fn command_at(&mut self, command: &str, args: Value, epoch:u64) -> Result<Value,String> {
        match command {
            "status" => return Ok(self.status()),
            "setup" => {
                if self.state.is_some() { return Err("already_configured".into()); }
                let endpoint = normalize_endpoint(string(&args,"endpoint")?)?;
                let name = string(&args,"name")?.trim();
                if name.is_empty() || name.len() > 120 || name.chars().count() > 80 || name.chars().any(char::is_control) { return Err("invalid_name".into()); }
                let identity = protocol::generate_identity()?;
                let mut state = json!({"endpoint":endpoint,"name":name,"publicKey":identity["publicKey"],"secretKey":identity["secretKey"],"ownerToken":protocol::random_token(),"peers":{}});
                let result = self.request_for(&state,"",reqwest::Method::POST,Some(json!({"ownerToken":state["ownerToken"],"ownerPublicKey":state["publicKey"],"name":name}))).await?;
                let room = string(&result,"roomId")?; Uuid::parse_str(room).map_err(|_| "invalid_room")?;
                state["roomId"] = json!(room);
                if let Err(error) = store::save(&self.path,&state) {
                    let _ = self.request_for(&state,&format!("/{room}"),reqwest::Method::DELETE,None).await;
                    return Err(error);
                }
                self.state = Some(state); self.attempts = 0; self.connect();
            }
            "connect" => { self.state()?; self.attempts = 0; self.connect(); }
            "disconnect" | "stop" => self.stop(),
            "pause" => {
                let paused = args["paused"].as_bool().ok_or("invalid_paused")?;
                if !paused && !self.connected { return Err("relay_offline".into()); }
                if paused { self.safety.cancel(); }
                else { if self.injecting { return Err("input_busy".into()); } self.safety.resume(epoch)?; }
                self.paused = paused;
                for id in &self.online { let _ = self.ready(id); }
            }
            "pairing" => {
                if !self.connected { return Err("relay_offline".into()); }
                let state = self.state()?; let token = protocol::random_token();
                let result = self.request_for(state,&format!("/{}/pairing",string(state,"roomId")?),reqwest::Method::POST,Some(json!({"pairToken":token}))).await?;
                let expires = result["expiresAt"].as_u64().ok_or("invalid_pair_expiry")?;
                if expires <= now() || expires > now() + 125000 { return Err("invalid_pair_expiry".into()); }
                let pair = json!({"v":1,"endpoint":state["endpoint"],"roomId":state["roomId"],"pairToken":token,"ownerPublicKey":state["publicKey"],"name":state["name"],"expiresAt":expires});
                return Ok(json!({"url":format!("{}/#pair={}",string(state,"endpoint")?,protocol::encode_pairing(&pair)?),"expiresAt":expires}));
            }
            "approve" => {
                let id = string(&args,"deviceId")?; let confirmed = args["confirmed"].as_bool().ok_or("confirmation_required")?;
                let pending = self.pending.get(id).ok_or("no_pending_pair")?;
                if pending.expires <= now() { return Err("pairing_expired".into()); }
                if !confirmed { self.send(json!({"type":"pair-reject","deviceId":id}))?; self.pending.remove(id); }
                else {
                    let mut state = self.state()?.clone();
                    if let Some(peer) = state["peers"].get(id) { if peer["publicKey"] != pending.public_key { return Err("changed_peer_key".into()); } }
                    state["peers"][id] = json!({"publicKey":pending.public_key,"name":pending.name});
                    // Human-confirmed pin reaches durable OS-protected storage BEFORE approval.
                    store::save(&self.path,&state)?; self.state = Some(state);
                    if let Some(pending) = self.pending.get_mut(id) { pending.confirmed = true; }
                    self.send(json!({"type":"pair-approve","deviceId":id}))?;
                }
            }
            "revoke" => {
                self.safety.cancel(); self.paused=true;
                for id in &self.online { let _=self.ready(id); }
                let id = string(&args,"deviceId")?; Uuid::parse_str(id).map_err(|_| "invalid_device")?;
                let state = self.state()?;
                let result = self.request_for(state,&format!("/{}/devices/{id}",string(state,"roomId")?),reqwest::Method::DELETE,None).await;
                if let Err(error) = result { if error != "relay_http_404" { return Err(error); } }
                let mut state = self.state()?.clone(); state["peers"].as_object_mut().ok_or("invalid_peers")?.remove(id);
                // Remove live authorization even if storage fails; do not keep accepting input.
                self.online.remove(id); self.pending.remove(id); self.state = Some(state.clone());
                if let Err(error) = store::save(&self.path,&state) { self.stop(); return Err(error); }
            }
            "reset" => {
                self.safety.cancel(); self.paused=true;
                if args["confirmed"] != true { return Err("confirmation_required".into()); }
                if let Some(state) = self.state.as_ref() {
                    let result = self.request_for(state,&format!("/{}",string(state,"roomId")?),reqwest::Method::DELETE,None).await;
                    if let Err(error) = result { if error != "relay_http_404" { return Err(error); } }
                }
                self.stop(); store::clear(&self.path)?; self.state = None;
            }
            _ => return Err("unknown_command".into()),
        }
        self.changed(); Ok(self.status())
    }
    async fn receive(&mut self, message: Value) -> Result<(),String> {
        let kind = string(&message,"type")?;
        if kind == "authenticated" {
            if message["role"] != "owner" || message["status"] != "approved" { self.stop(); return Err("invalid_authentication".into()); }
            self.connected = true; self.attempts = 0; self.changed(); return Ok(());
        }
        if !self.connected { return Err("unauthenticated_transport".into()); }
        match kind {
            "pair-request" => {
                let id = string(&message,"deviceId")?; Uuid::parse_str(id).map_err(|_| "invalid_device")?;
                let public_key = string(&message,"publicKey")?; let name = string(&message,"name")?;
                if name.len() > 120 || name.chars().any(char::is_control) { return Err("invalid_peer_name".into()); }
                let state = self.state()?;
                if let Some(peer) = state["peers"].get(id) { if peer["publicKey"] != public_key { return Err("changed_peer_key".into()); } }
                let sas = protocol::sas(string(state,"secretKey")?,public_key,string(state,"roomId")?)?;
                self.pending.clear();
                self.pending.insert(id.to_owned(),Pending {public_key:public_key.into(),name:name.into(),expires:now()+120000,confirmed:false});
                (self.emit)("pair-request",json!({"deviceId":id,"name":name,"sas":sas}));
            }
            "pair-approved" => {
                let id = string(&message,"deviceId")?;
                let pending = self.pending.get(id).ok_or("no_pending_pair")?;
                if !pending.confirmed || pending.expires <= now() { return Err("unconfirmed_pair".into()); }
                self.pending.remove(id); self.online.insert(id.into()); self.ready(id)?;
            }
            "peer-online" => {
                let id = string(&message,"deviceId")?; let state = self.state()?;
                let peer = state["peers"].get(id).ok_or("untrusted_peer")?;
                if peer["publicKey"] != message["publicKey"] { return Err("changed_peer_key".into()); }
                self.online.insert(id.into()); self.ready(id)?;
            }
            "peer-offline" => { self.online.remove(string(&message,"deviceId")?); }
            "peer-revoked" => {
                self.safety.cancel(); self.paused=true;
                let id = string(&message,"deviceId")?; let mut state = self.state()?.clone();
                state["peers"].as_object_mut().ok_or("invalid_peers")?.remove(id);
                self.online.remove(id); self.pending.remove(id); self.state = Some(state.clone());
                if let Err(error) = store::save(&self.path,&state) { self.stop(); return Err(error); }
            }
            "data" => { self.receive_text(&message).await?; }
            "error" => {
                let code = string(&message,"code")?;
                // Fixed notices only: the relay must not inject arbitrary strings into local logs/UI.
                if matches!(code,"unauthorized" | "room_deleted" | "replaced" | "revoked") { self.stop(); }
                if matches!(code,"pair_expired" | "pair_rejected") { self.pending.clear(); }
                (self.emit)("notice",json!("Relay refused an operation. Check authorization and connection."));
            }
            _ => return Err("invalid_message".into()),
        }
        self.changed(); Ok(())
    }
    async fn receive_text(&mut self, message: &Value) -> Result<(),String> {
        let id = string(message,"from")?; let state = self.state()?;
        if !self.online.contains(id) { return Err("unauthorized".into()); }
        let peer = state["peers"].get(id).ok_or("unauthorized")?;
        let context = json!({"roomId":state["roomId"],"sender":id,"recipient":"owner"});
        let payload = protocol::open(&message["envelope"],&context,string(peer,"publicKey")?,string(state,"secretKey")?)?;
        let authorized = self.online.contains(id) && self.state()?.get("peers").and_then(|p| p.get(id)).is_some();
        if let Err(code) = self.gate.accept(&payload,&self.session,now(),self.paused || self.safety.emergency.load(Ordering::SeqCst),authorized) {
            if let Some(message_id) = payload["id"].as_str().filter(|id| id.len() <= 64) {
                self.encrypted(id,json!({"kind":"ack","id":message_id,"status":"rejected","code":code}))?;
            }
            return Ok(());
        }
        if self.injecting {
            self.encrypted(id,json!({"kind":"ack","id":payload["id"],"status":"rejected","code":"input_busy"}))?;
            return Ok(());
        }
        let token=match self.safety.begin() {
            Ok(token)=>token,
            Err(code)=> { self.encrypted(id,json!({"kind":"ack","id":payload["id"],"status":"rejected","code":code}))?; return Ok(()); }
        };
        let text = string(&payload,"text")?.to_owned();
        let device_id = id.to_owned(); let message_id = string(&payload,"id")?.to_owned();
        let events = self.events.clone(); let generation = self.generation;
        self.injecting = true;
        // Exactly one attempt; do not block actor pause/revoke/disconnect handling.
        // Already-posted OS events cannot be undone. Never run a second injection until
        // the native call really returns: dropping a timed-out blocking task cannot stop it.
        tokio::spawn(async move {
            let native_token=token.clone();
            let result = tokio::task::spawn_blocking(move || input::inject_cancellable(&text,native_token)).await;
            let _ = events.send(Event::Injected {generation,device_id,message_id,success:matches!(result,Ok(Ok(()))),token}).await;
        });
        Ok(())
    }
}

/// The only transport task. No reconnect or buffering of offline application messages here.
async fn transport(url: String, token: String, generation: u64, mut outbound: mpsc::Receiver<Value>, events: mpsc::Sender<Event>, safety:Arc<Safety>) -> Result<(),String> {
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME)).max_frame_size(Some(MAX_FRAME));
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(10),
        tokio_tungstenite::connect_async_with_config(&url,Some(config),false)).await
        .map_err(|_| "relay_timeout")?.map_err(websocket_error)?;
    socket.send(Message::Text(json!({"type":"auth","role":"owner","token":token}).to_string().into())).await.map_err(|_| "auth_failed")?;
    let deadline = Instant::now() + Duration::from_secs(10);
    // Authentication must precede all control and application events.
    loop {
        let frame = tokio::time::timeout_at(deadline,socket.next()).await.map_err(|_| "auth_timeout")?
            .ok_or("socket_closed")?.map_err(|_| "socket_error")?;
        match frame {
            Message::Text(text) => {
                let message: Value = serde_json::from_str(&text).map_err(|_| "invalid_auth")?;
                if message["type"] != "authenticated" || message["role"] != "owner" || message["status"] != "approved" { return Err("invalid_auth".into()); }
                events.send(Event::Frame(generation,message)).await.map_err(|_| "controller_stopped")?; break;
            }
            Message::Ping(_) | Message::Pong(_) => {},
            _ => return Err("invalid_auth".into()),
        }
    }
    loop {
        tokio::select! {
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if text.len() > MAX_FRAME { return Err("oversized_frame".into()); }
                    let message:Value = serde_json::from_str(&text).map_err(|_| "invalid_message")?;
                    if message["type"]=="peer-revoked" || (message["type"]=="error" && matches!(message["code"].as_str(),Some("unauthorized"|"room_deleted"|"replaced"|"revoked"))) {
                        safety.cancel_transport(generation);
                    }
                    events.send(Event::Frame(generation,message)).await.map_err(|_| "controller_stopped")?;
                }
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {},
                _ => return Err("socket_closed".into()),
            },
            outgoing = outbound.recv() => {
                let Some(message) = outgoing else { let _ = socket.close(None).await; return Ok(()); };
                tokio::time::timeout(Duration::from_secs(3),socket.send(Message::Text(message.to_string().into())))
                    .await.map_err(|_| "send_timeout")?.map_err(|_| "send_failed")?;
            }
        }
    }
}

#[derive(Default)]
struct Gate { seen: HashMap<String,u64> }
impl Gate {
    fn accept(&mut self, message: &Value, session: &str, time: u64, paused: bool, authorized: bool) -> Result<(), &'static str> {
        if !authorized { return Err("unauthorized"); }
        if paused { return Err("paused"); }
        if message["kind"] != "text" { return Err("invalid_message"); }
        let id = message["id"].as_str().ok_or("invalid_message")?;
        if Uuid::parse_str(id).is_err() { return Err("invalid_message"); }
        if message["sessionId"] != session { return Err("session_mismatch"); }
        let sent = message["sentAt"].as_u64().ok_or("expired")?;
        let expires = message["expiresAt"].as_u64().ok_or("expired")?;
        if sent > time.saturating_add(5000) || expires <= time || expires <= sent || expires.saturating_sub(sent) > 15000 { return Err("expired"); }
        let text = message["text"].as_str().ok_or("invalid_text")?;
        if text.is_empty() || text.len() > 8192 || text.chars().any(|c| matches!(c,'\u{0000}'..='\u{0008}' | '\u{000b}' | '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}')) { return Err("invalid_text"); }
        self.seen.retain(|_,expiry| *expiry > time);
        if self.seen.contains_key(id) { return Err("duplicate"); }
        if self.seen.len() >= 1024 { return Err("rate_limited"); }
        self.seen.insert(id.into(),expires); Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn text() -> Value { json!({"kind":"text","id":Uuid::new_v4().to_string(),"sessionId":"session","sentAt":1000,"expiresAt":16000,"text":"hello\n世界"}) }
    #[test] fn endpoint_requires_https_except_loopback() {
        assert_eq!(normalize_endpoint("http://localhost:8787/").unwrap(),"http://localhost:8787");
        for value in ["http://example.com","https://a.test/path","https://user:pass@a.test","https://a.test/#secret","https://a.test/?token=secret"] { assert!(normalize_endpoint(value).is_err()); }
    }
    #[test] fn paused_or_revoked_messages_never_consume_the_gate() {
        let mut gate = Gate::default(); let message = text();
        assert_eq!(gate.accept(&message,"session",1000,true,true),Err("paused"));
        assert_eq!(gate.accept(&message,"session",1000,false,false),Err("unauthorized"));
        assert!(gate.seen.is_empty());
        assert_eq!(gate.accept(&message,"session",1000,false,true),Ok(()));
        assert_eq!(gate.accept(&message,"session",1000,false,true),Err("duplicate"));
    }
    #[test] fn stale_sessions_expiry_future_and_controls_fail_closed() {
        let mut gate = Gate::default(); let mut message = text();
        assert_eq!(gate.accept(&message,"new_session",1000,false,true),Err("session_mismatch"));
        assert_eq!(gate.accept(&message,"session",16000,false,true),Err("expired"));
        message["sentAt"]=json!(6001); message["expiresAt"]=json!(15000);
        assert_eq!(gate.accept(&message,"session",1000,false,true),Err("expired"));
        message=text(); message["text"]=json!("\u{001b}[A");
        assert_eq!(gate.accept(&message,"session",1000,false,true),Err("invalid_text"));
        message["text"]=json!("界".repeat(2731));
        assert_eq!(gate.accept(&message,"session",1000,false,true),Err("invalid_text"));
    }
    fn actor_fixture() -> (Actor,mpsc::Receiver<Value>,Value,String) {
        let owner=protocol::generate_identity().unwrap(); let phone=protocol::generate_identity().unwrap();
        let device_id=Uuid::new_v4().to_string(); let room=Uuid::new_v4().to_string();
        let mut state=json!({"endpoint":"https://relay.invalid","roomId":room,"name":"Desktop","publicKey":owner["publicKey"],"secretKey":owner["secretKey"],"ownerToken":protocol::random_token(),"peers":{}});
        state["peers"][&device_id]=json!({"name":"Phone","publicKey":phone["publicKey"]});
        let (_,commands)=mpsc::channel(4); let (events,event_rx)=mpsc::channel(4); let (tx,rx)=mpsc::channel(16);
        let path=std::env::temp_dir().join(format!("teleport-controller-test-{}",Uuid::new_v4())).join("identity.dpapi");
        let actor=Actor {safety:Arc::new(Safety::new()),path,emit:Arc::new(|_,_|{}),state:Some(state),http:reqwest::Client::new(),commands,events,event_rx,
            transport:None,outbound:Some(tx),generation:1,connected:true,stopped:false,paused:true,retry:None,attempts:0,
            session:Uuid::new_v4().to_string(),pending:HashMap::new(),online:HashSet::from([device_id.clone()]),gate:Gate::default(),injecting:false};
        (actor,rx,phone,device_id)
    }
    fn phone_message(actor:&Actor,phone:&Value,id:&str) -> Value {
        let state=actor.state().unwrap();
        let payload=json!({"kind":"text","id":Uuid::new_v4().to_string(),"sessionId":actor.session,"sentAt":now(),"expiresAt":now()+15000,"text":"safe test text"});
        let context=json!({"roomId":state["roomId"],"sender":id,"recipient":"owner"});
        let envelope=protocol::seal(&payload,&context,string(state,"publicKey").unwrap(),string(phone,"secretKey").unwrap()).unwrap();
        json!({"type":"data","from":id,"envelope":envelope})
    }
    fn decrypt_outbound(actor:&Actor,phone:&Value,id:&str,frame:&Value) -> Value {
        let state=actor.state().unwrap(); let context=json!({"roomId":state["roomId"],"sender":"owner","recipient":id});
        protocol::open(&frame["envelope"],&context,string(state,"publicKey").unwrap(),string(phone,"secretKey").unwrap()).unwrap()
    }
    #[tokio::test] async fn actor_pause_sends_encrypted_ready_and_blocks_injection() {
        let (mut actor,mut output,phone,id)=actor_fixture();
        actor.command("pause",json!({"paused":false})).await.unwrap();
        let ready=decrypt_outbound(&actor,&phone,&id,&output.try_recv().unwrap()); assert_eq!(ready["paused"],false);
        actor.command("pause",json!({"paused":true})).await.unwrap(); let _=output.try_recv().unwrap();
        actor.receive(phone_message(&actor,&phone,&id)).await.unwrap();
        let ack=decrypt_outbound(&actor,&phone,&id,&output.try_recv().unwrap());
        assert_eq!(ack["status"],"rejected"); assert_eq!(ack["code"],"paused"); assert!(!actor.injecting);
        actor.connected=false; assert!(actor.command("pause",json!({"paused":false})).await.is_err());
    }
    #[tokio::test] async fn actor_disconnect_and_reconnect_rotate_session_and_never_resume_input() {
        let (mut actor,_,_,_)=actor_fixture(); actor.paused=false; let session=actor.session.clone();
        actor.disconnected(); assert!(actor.paused); assert!(!actor.connected); assert!(actor.online.is_empty()); assert!(actor.retry.is_some());
        // No await between spawning and aborting: no network connection is performed.
        actor.connect(); assert_ne!(actor.session,session); assert!(actor.paused); assert!(!actor.connected);
        actor.stop(); assert!(actor.stopped); assert!(actor.retry.is_none()); assert!(actor.outbound.is_none());
    }
    #[tokio::test] async fn actor_revocation_removes_authorization_even_if_storage_fails() {
        let (mut actor,_,phone,id)=actor_fixture(); let message=phone_message(&actor,&phone,&id); let path=actor.path.clone();
        let result=actor.receive(json!({"type":"peer-revoked","deviceId":id})).await;
        #[cfg(windows)] assert!(result.is_ok());
        #[cfg(not(windows))] assert!(result.is_err());
        assert!(!actor.online.contains(&id)); assert!(actor.state().unwrap()["peers"].get(&id).is_none());
        assert!(actor.receive_text(&message).await.is_err()); assert!(!actor.injecting);
        let _=std::fs::remove_dir_all(path.parent().unwrap());
    }
    #[tokio::test] async fn changed_key_and_unconfirmed_approval_cannot_authorize() {
        let (mut actor,_,phone,id)=actor_fixture(); actor.state.as_mut().unwrap()["peers"].as_object_mut().unwrap().remove(&id); actor.online.clear();
        actor.receive(json!({"type":"pair-request","deviceId":id,"publicKey":phone["publicKey"],"name":"Phone"})).await.unwrap();
        assert!(actor.receive(json!({"type":"pair-approved","deviceId":id})).await.is_err());
        assert!(actor.state().unwrap()["peers"].get(&id).is_none()); assert!(actor.online.is_empty());
        actor.state.as_mut().unwrap()["peers"][&id]=json!({"name":"Phone","publicKey":phone["publicKey"]});
        let replacement=protocol::generate_identity().unwrap();
        assert!(actor.receive(json!({"type":"peer-online","deviceId":id,"publicKey":replacement["publicKey"]})).await.is_err());
        assert!(actor.online.is_empty());
    }
    #[cfg(windows)]
    #[tokio::test] async fn windows_human_approval_persists_pin_before_transport_command() {
        let (mut actor,mut output,phone,id)=actor_fixture(); actor.state.as_mut().unwrap()["peers"].as_object_mut().unwrap().remove(&id); actor.online.clear();
        actor.receive(json!({"type":"pair-request","deviceId":id,"publicKey":phone["publicKey"],"name":"Phone"})).await.unwrap();
        actor.command("approve",json!({"deviceId":id,"confirmed":true})).await.unwrap();
        let wire=output.try_recv().unwrap(); assert_eq!(wire["type"],"pair-approve");
        let loaded=store::load(&actor.path).unwrap().unwrap(); assert_eq!(loaded["peers"][&id]["publicKey"],phone["publicKey"]);
        // Lost relay reply cannot erase the already-human-confirmed pin.
        actor.disconnected(); assert_eq!(actor.state().unwrap()["peers"][&id]["publicKey"],phone["publicKey"]);
        let _=std::fs::remove_dir_all(actor.path.parent().unwrap());
    }
    #[cfg(not(windows))]
    #[tokio::test] async fn unavailable_secure_storage_prevents_approval() {
        let (mut actor,mut output,phone,id)=actor_fixture(); actor.state.as_mut().unwrap()["peers"].as_object_mut().unwrap().remove(&id); actor.online.clear();
        actor.receive(json!({"type":"pair-request","deviceId":id,"publicKey":phone["publicKey"],"name":"Phone"})).await.unwrap();
        assert!(actor.command("approve",json!({"deviceId":id,"confirmed":true})).await.is_err());
        assert!(output.try_recv().is_err()); assert!(actor.state().unwrap()["peers"].get(&id).is_none());
    }

    #[tokio::test] async fn emergency_handle_cancels_native_before_a_full_command_queue_can_progress() {
        let safety=Arc::new(Safety::new()); safety.resume(0).unwrap(); let token=safety.begin().unwrap();
        let (tx,_rx)=mpsc::channel(1); let (reply,_)=oneshot::channel();
        tx.try_send(Command{name:"status".into(),args:json!({}),epoch:0,reply}).unwrap();
        let handle=Handle{commands:tx,safety:safety.clone()};
        let mut request=std::pin::pin!(handle.call("pause",json!({"paused":true})));
        // Poll once: cancellation must run synchronously before the blocked channel await.
        assert!(matches!(futures_util::poll!(request.as_mut()),std::task::Poll::Pending));
        assert!(token.load(Ordering::Acquire)); assert!(safety.emergency.load(Ordering::SeqCst));
        assert!(safety.begin().is_err());
    }
    #[test] fn old_resume_cannot_override_newer_emergency_and_tokens_are_never_reused() {
        let safety=Safety::new(); safety.resume(0).unwrap(); let old=safety.begin().unwrap();
        safety.cancel(); let epoch=safety.epoch.load(Ordering::SeqCst);
        assert!(old.load(Ordering::Acquire)); assert!(safety.resume(epoch).is_err());
        safety.finish(&old);
        assert_eq!(safety.resume(0),Err("newer_stop_requested".into()));
        safety.resume(epoch).unwrap(); let fresh=safety.begin().unwrap();
        assert!(!Arc::ptr_eq(&old,&fresh)); assert!(!fresh.load(Ordering::Acquire)); assert!(old.load(Ordering::Acquire));
        safety.finish(&old); assert!(safety.resume(epoch).is_err()); // stale completion cannot clear fresh token
        safety.cancel(); assert!(fresh.load(Ordering::Acquire));
    }
    #[tokio::test] async fn emergency_flag_refuses_new_text_before_queued_pause_is_processed() {
        let (mut actor,mut output,phone,id)=actor_fixture(); actor.paused=false;
        actor.safety.resume(actor.safety.epoch.load(Ordering::SeqCst)).unwrap();
        let message=phone_message(&actor,&phone,&id);
        actor.safety.cancel(); // Handle has acted, actor has not yet processed its command.
        actor.receive_text(&message).await.unwrap();
        let ack=decrypt_outbound(&actor,&phone,&id,&output.try_recv().unwrap());
        assert_eq!(ack["code"],"paused"); assert!(!actor.injecting); assert_eq!(actor.status()["paused"],true);
    }

    #[test] fn stale_transport_cannot_cancel_current_session_but_live_disconnect_can() {
        let safety=Safety::new(); safety.transport.store(2,Ordering::SeqCst); safety.resume(0).unwrap();
        let token=safety.begin().unwrap(); safety.cancel_transport(1);
        assert!(!token.load(Ordering::Acquire)); assert!(!safety.emergency.load(Ordering::SeqCst));
        safety.cancel_transport(2); assert!(token.load(Ordering::Acquire)); assert!(safety.emergency.load(Ordering::SeqCst));
    }

    /// Opt-in live diagnostic: synthetic room only; always attempts room deletion.
    /// TELEPORT_TEST_RELAY must be an explicitly authorized deployed relay origin.
    #[tokio::test]
    #[ignore = "requires explicit TELEPORT_TEST_RELAY network authorization"]
    async fn native_live_http_websocket_auth_and_cleanup() {
        let endpoint=std::env::var("TELEPORT_TEST_RELAY").expect("set TELEPORT_TEST_RELAY");
        let endpoint=normalize_endpoint(&endpoint).unwrap();
        let (mut actor,_,_,_)=actor_fixture();
        actor.http=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(10)).build().unwrap();
        let mut state=actor.state().unwrap().clone(); state["endpoint"]=json!(endpoint);
        let response=actor.request_for(&state,"",reqwest::Method::POST,Some(json!({"ownerToken":state["ownerToken"],"ownerPublicKey":state["publicKey"],"name":"Windows native diagnostic"}))).await;
        let response=response.expect("native Rust room creation failed (sanitized code)");
        let room=string(&response,"roomId").expect("missing roomId");
        let mut url=reqwest::Url::parse(&format!("{endpoint}/api/rooms/{room}/ws")).unwrap();
        let scheme=if url.scheme()=="https" {"wss"} else {"ws"}; url.set_scheme(scheme).unwrap();
        let (events,mut event_rx)=mpsc::channel(4); let (_outbound,rx)=mpsc::channel(4);
        let safety=Arc::new(Safety::new()); safety.transport.store(1,Ordering::SeqCst);
        let token=string(&state,"ownerToken").unwrap().to_owned();
        let task=tokio::spawn(async move {
            let error=transport(url.to_string(),token,1,rx,events.clone(),safety).await.err();
            let _=events.send(Event::Closed(1,error)).await;
        });
        let authentication=tokio::time::timeout(Duration::from_secs(22),event_rx.recv()).await;
        task.abort();
        // Cleanup runs before assertions, including failed upgrade/authentication.
        let deletion=actor.request_for(&state,&format!("/{room}"),reqwest::Method::DELETE,None).await;
        assert!(deletion.is_ok(),"synthetic room cleanup failed: {:?}",deletion.err());
        assert!(Uuid::parse_str(room).is_ok());
        match authentication {
            Ok(Some(Event::Frame(_,message)))=>assert_eq!(message["type"],"authenticated"),
            Ok(Some(Event::Closed(_,code)))=>panic!("native WebSocket failed (sanitized code): {code:?}"),
            _=>panic!("native WebSocket authentication timed out; room cleanup completed"),
        }
    }

    #[test] fn transport_diagnostics_are_sanitized_and_actionable() {
        let error=reqwest::Client::new().get("http://[invalid/private-secret-token").build().unwrap_err();
        assert_eq!(http_error(&error),"relay_request_invalid");
        let timeout=tokio_tungstenite::tungstenite::Error::Io(std::io::Error::new(std::io::ErrorKind::TimedOut,"private-secret-token"));
        assert_eq!(websocket_error(timeout),"relay_timeout");
        let connect=tokio_tungstenite::tungstenite::Error::Io(std::io::Error::new(std::io::ErrorKind::ConnectionRefused,"private-secret-token"));
        assert_eq!(websocket_error(connect),"relay_connect_failed");
        let response=tokio_tungstenite::tungstenite::http::Response::builder().status(403).body(Some(b"private-secret-token".to_vec())).unwrap();
        assert_eq!(websocket_error(tokio_tungstenite::tungstenite::Error::Http(Box::new(response))),"relay_websocket_http_403");
    }

}
