#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(windows)] fn main() { teleport_windows::desktop::run(); }
#[cfg(not(windows))] fn main() { eprintln!("This preview supports Windows only."); std::process::exit(1); }
