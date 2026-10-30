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
  tauri_build::build();
 }
}
