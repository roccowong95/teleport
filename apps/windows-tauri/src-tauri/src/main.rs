#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(any(windows, target_os="macos"))] fn main() { teleport_windows::desktop::run(); }
#[cfg(not(any(windows, target_os="macos")))] fn main() { eprintln!("This preview supports Windows and macOS only."); std::process::exit(1); }
