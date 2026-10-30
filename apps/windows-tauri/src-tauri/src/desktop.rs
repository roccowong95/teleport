use crate::controller::{self,Handle};
use serde_json::{json,Value};
use std::{path::PathBuf,sync::Arc};
use tauri::{Emitter,Manager,State,WebviewWindow};
struct Backend { handle: Handle, smoke: Option<PathBuf> }
fn local(window:&WebviewWindow)->Result<(),String>{if window.label()!="main" {return Err("untrusted_window".into())} let url=window.url().map_err(|_|"window_unavailable")?;if !((url.scheme()=="tauri"&&url.host_str()==Some("localhost"))||(url.scheme()=="http"&&url.host_str()==Some("tauri.localhost"))||(cfg!(debug_assertions)&&url.host_str()==Some("localhost")&&url.port()==Some(1420))){return Err("untrusted_origin".into())}Ok(())}
#[tauri::command] async fn status(window:WebviewWindow,state:State<'_,Backend>)->Result<Value,String>{local(&window)?;state.handle.call("status",json!({})).await}
#[tauri::command] async fn setup(window:WebviewWindow,state:State<'_,Backend>,endpoint:String,name:String)->Result<Value,String>{local(&window)?;state.handle.call("setup",json!({"endpoint":endpoint,"name":name})).await}
#[tauri::command] async fn pairing(window:WebviewWindow,state:State<'_,Backend>)->Result<Value,String>{local(&window)?;state.handle.call("pairing",json!({})).await}
#[tauri::command] async fn approve(window:WebviewWindow,state:State<'_,Backend>,device_id:String,confirmed:bool)->Result<Value,String>{local(&window)?;state.handle.call("approve",json!({"deviceId":device_id,"confirmed":confirmed})).await}
#[tauri::command] async fn connection(window:WebviewWindow,state:State<'_,Backend>,connected:bool)->Result<Value,String>{local(&window)?;state.handle.call(if connected{"connect"}else{"disconnect"},json!({})).await}
#[tauri::command] async fn pause(window:WebviewWindow,state:State<'_,Backend>,paused:bool)->Result<Value,String>{local(&window)?;state.handle.call("pause",json!({"paused":paused})).await}
#[tauri::command] async fn revoke(window:WebviewWindow,state:State<'_,Backend>,device_id:String)->Result<Value,String>{local(&window)?;state.handle.call("revoke",json!({"deviceId":device_id})).await}
#[tauri::command] async fn reset(window:WebviewWindow,state:State<'_,Backend>,confirmed:bool)->Result<Value,String>{local(&window)?;state.handle.call("reset",json!({"confirmed":confirmed})).await}
#[tauri::command] async fn smoke_ready(window:WebviewWindow,app:tauri::AppHandle,state:State<'_,Backend>)->Result<bool,String>{local(&window)?;if let Some(path)=&state.smoke { let status=state.handle.call("status",json!({})).await?;if status["configured"]!=false||status["paused"]!=true{return Err("smoke_state_invalid".into())}std::fs::write(path.join("smoke-result.json"),b"{\"ready\":true,\"renderer\":true}").map_err(|_|"smoke_write_failed")?;app.exit(0);return Ok(true)}Ok(false)}
pub fn run(){
 let app=tauri::Builder::default()
 .plugin(tauri_plugin_single_instance::init(|app,_,_|{if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();}}))
 .setup(|app|{
  let smoke=std::env::var_os("TELEPORT_CI_SMOKE_DIR").map(PathBuf::from);if smoke.as_ref().is_some_and(|p|!p.is_absolute()){return Err("smoke path must be absolute".into())}
  let dir=match &smoke{Some(p)=>p.clone(),None=>app.path().app_local_data_dir()?};std::fs::create_dir_all(&dir)?;
  let ah=app.handle().clone();let emit=Arc::new(move|event:&str,value:Value|{let _=ah.emit(event,value);});
  let handle=tauri::async_runtime::block_on(async {controller::start(dir.join("identity.dpapi"),emit)}) .map_err(std::io::Error::other)?;
  app.manage(Backend{handle:handle.clone(),smoke});
  tauri::WebviewWindowBuilder::from_config(app,&app.config().app.windows[0])?
   .on_navigation(|url| (url.scheme()=="tauri"&&url.host_str()==Some("localhost")) || (url.scheme()=="http"&&url.host_str()==Some("tauri.localhost")) || (cfg!(debug_assertions)&&url.host_str()==Some("localhost")&&url.port()==Some(1420)))
   .on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny).build()?;
  use tauri::menu::{Menu,MenuItem};
  let open=MenuItem::with_id(app,"open","Open Teleport",true,None::<&str>)?;
  let pause=MenuItem::with_id(app,"pause","Pause input",true,None::<&str>)?;
  let quit=MenuItem::with_id(app,"quit","Quit",true,None::<&str>)?;
  let menu=Menu::with_items(app,&[&open,&pause,&quit])?;
  let pixels=vec![0x38,0x94,0xff,0xff].repeat(16*16);
  tauri::tray::TrayIconBuilder::new().icon(tauri::image::Image::new_owned(pixels,16,16)).tooltip("Teleport — open to resume input").menu(&menu).on_menu_event(move|app,event|match event.id.as_ref(){"open"=>{if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();}},"pause"=>{let h=handle.clone();tauri::async_runtime::spawn(async move{let _=h.call("pause",json!({"paused":true})).await;});},"quit"=>app.exit(0),_=>{}}).build(app)?;
  Ok(())
 })
 .on_window_event(|window,event|{if let tauri::WindowEvent::CloseRequested{api,..}=event{api.prevent_close();let _=window.hide();}})
 .invoke_handler(tauri::generate_handler![status,setup,pairing,approve,connection,pause,revoke,reset,smoke_ready])
 .build(tauri::generate_context!()).expect("Teleport could not initialize secure local state");
 app.run(|_,_|{});
}
