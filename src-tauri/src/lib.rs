mod convert;
mod imaging;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = imaging::register_imgsrv(tauri::Builder::default());
    builder
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            imaging::list_dir,
            imaging::list_archive,
            imaging::image_meta,
            convert::convert_images
        ])
        .run(tauri::generate_context!())
        .expect("error while running glasspane");
}
