mod convert;
mod imaging;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = imaging::register_imgsrv(tauri::Builder::default());
    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Trim the on-disk thumbnail cache in the background so a long-lived
            // cache can't grow without bound; never blocks startup.
            let handle = app.handle().clone();
            std::thread::spawn(move || imaging::prune_thumb_cache(&handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            imaging::list_dir,
            imaging::list_archive,
            imaging::image_meta,
            convert::convert_images
        ])
        .run(tauri::generate_context!())
        .expect("error while running glasspane");
}
