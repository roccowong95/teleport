fn main() {
 #[cfg(windows)] {
  // Tiny original 16px icon, generated at build time; no downloaded artwork/runtime.
  let mut dib=Vec::new();
  for n in [40u32,16,32] {dib.extend(n.to_le_bytes());}
  dib.extend(1u16.to_le_bytes());dib.extend(32u16.to_le_bytes());
  for n in [0u32,1024,0,0,0,0]{dib.extend(n.to_le_bytes());}
  for y in 0..16{for x in 0..16{let mark=(3..=12).contains(&x)&&(y==7||y==8)||x==12&&(4..=11).contains(&y);dib.extend(if mark{[255,255,255,255]}else{[255,148,56,255]});}}
  dib.extend([0u8;64]);
  let mut ico=vec![0,0,1,0,1,0,16,16,0,0,1,0,32,0];ico.extend((dib.len() as u32).to_le_bytes());ico.extend(22u32.to_le_bytes());ico.extend(dib);
  std::fs::create_dir_all("icons").unwrap();std::fs::write("icons/icon.ico",ico).unwrap();

 }
 #[cfg(target_os="macos")] {
  // Original RGBA icon for Unix generate_context and app packaging.
  std::fs::create_dir_all("icons").unwrap();
  std::fs::write("icons/icon.png", &[137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,32,0,0,0,32,8,6,0,0,0,115,122,122,244,0,0,0,63,73,68,65,84,120,156,237,210,49,10,0,32,12,4,193,60,203,135,250,223,88,89,219,8,33,97,22,174,159,226,98,237,204,202,5,0,0,192,120,192,13,0,160,31,224,119,0,253,0,229,39,4,0,24,3,120,13,0,0,160,28,112,0,91,23,164,246,180,50,76,197,0,0,0,0,73,69,78,68,174,66,96,130] as &[u8]).unwrap();
  println!("cargo:rerun-if-changed=src/input_macos.m");
  cc::Build::new().file("src/input_macos.m").flag("-fobjc-arc").compile("teleport_input_macos");
  println!("cargo:rustc-link-lib=framework=AppKit");
  println!("cargo:rustc-link-lib=framework=ApplicationServices");
 }
 #[cfg(any(windows, target_os="macos"))] tauri_build::build();
}
