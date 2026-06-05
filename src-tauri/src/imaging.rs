// imaging.rs — glasspane backend module.
//
// Two planes (see CLAUDE.md §6):
//   - data plane:  invoke commands `list_dir` / `list_archive` / `image_meta`
//   - image plane: the `imgsrv://` custom URI-scheme protocol that streams
//                  cached JPEG thumbnails and full image bytes straight into
//                  <img>, decoded off the main thread.
//
// Keep these contracts in sync with src/lib/viewerApi.ts.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use image::{ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Builder, Manager, Runtime};

// ---------------------------------------------------------------------------
// Contracts (mirror the TS types in viewerApi.ts)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    /// "dir" | "archive" | "image"
    pub kind: String,
}

#[derive(Serialize)]
pub struct ArchiveEntry {
    pub name: String,
}

#[derive(Serialize)]
pub struct ImageMeta {
    pub width: u32,
    pub height: u32,
    pub size: u64,
}

/// If `archive` is set, `path` is the entry name *inside* that zip;
/// otherwise `path` is a filesystem path.
#[derive(Deserialize, Clone)]
pub struct Src {
    pub archive: Option<String>,
    pub path: String,
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

fn is_image(ext: &str) -> bool {
    matches!(
        ext,
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "bmp" | "tiff" | "tif" | "ico"
    )
}

fn is_archive(ext: &str) -> bool {
    matches!(ext, "zip" | "cbz")
}

/// Formats a modern webview renders directly; everything else is transcoded to
/// JPEG before being served on the `/full` route.
fn passthrough_content_type(ext: &str) -> Option<&'static str> {
    match ext {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Data plane — invoke commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let rd = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut entries: Vec<DirEntry> = Vec::new();

    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        let kind = if ft.is_dir() {
            "dir"
        } else {
            let ext = ext_of(&name);
            if is_archive(&ext) {
                "archive"
            } else if is_image(&ext) {
                "image"
            } else {
                continue; // skip non-image, non-archive files
            }
        };

        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            kind: kind.to_string(),
        });
    }

    // dirs first, then name (case-insensitive)
    entries.sort_by(|a, b| {
        let rank = |k: &str| if k == "dir" { 0 } else { 1 };
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub fn list_archive(path: String) -> Result<Vec<ArchiveEntry>, String> {
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    let mut out: Vec<ArchiveEntry> = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if is_image(&ext_of(&name)) {
            out.push(ArchiveEntry { name });
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub fn image_meta(src: Src) -> Result<ImageMeta, String> {
    let raw = read_source_bytes(&src).map_err(|e| e.to_string())?;
    let size = raw.len() as u64;

    let reader = ImageReader::new(Cursor::new(&raw))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let (width, height) = reader.into_dimensions().map_err(|e| e.to_string())?;

    Ok(ImageMeta {
        width,
        height,
        size,
    })
}

// ---------------------------------------------------------------------------
// Reading source bytes (filesystem file or entry inside a zip)
// ---------------------------------------------------------------------------

pub(crate) fn read_source_bytes(src: &Src) -> std::io::Result<Vec<u8>> {
    match &src.archive {
        Some(zip_path) => {
            let file = fs::File::open(zip_path)?;
            let mut archive = zip::ZipArchive::new(file)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            let mut entry = archive
                .by_name(&src.path)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::NotFound, e))?;
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut buf)?;
            Ok(buf)
        }
        None => fs::read(&src.path),
    }
}

// ---------------------------------------------------------------------------
// Image-bytes plane — the `imgsrv` protocol
// ---------------------------------------------------------------------------

/// Registers the `imgsrv` asynchronous URI-scheme protocol on the builder.
/// Decoding happens on a worker thread so the UI thread is never blocked.
pub fn register_imgsrv<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("imgsrv", move |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        std::thread::spawn(move || {
            let response = handle_request(&app, request);
            responder.respond(response);
        });
    })
}

fn handle_request<R: Runtime>(app: &AppHandle<R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri();
    let query = parse_query(uri.query().unwrap_or(""));

    let path = match query.get("path") {
        Some(p) => p.clone(),
        None => return error_response(StatusCode::BAD_REQUEST, "missing `path`"),
    };
    let src = Src {
        archive: query.get("archive").cloned(),
        path,
    };

    let result = match uri.path() {
        "/thumb" => {
            let w: u32 = query.get("w").and_then(|s| s.parse().ok()).unwrap_or(256);
            serve_thumb(app, &src, w)
        }
        "/full" => serve_full(&src),
        other => return error_response(StatusCode::NOT_FOUND, &format!("unknown route {other}")),
    };

    match result {
        Ok((bytes, content_type)) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", content_type)
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap(),
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

fn serve_thumb<R: Runtime>(
    app: &AppHandle<R>,
    src: &Src,
    w: u32,
) -> Result<(Vec<u8>, &'static str), String> {
    let dir = thumbs_dir(app)?;
    let cache_path = dir.join(format!("{}.jpg", cache_key(src, w)));

    // disk-cache hit
    if let Ok(bytes) = fs::read(&cache_path) {
        return Ok((bytes, "image/jpeg"));
    }

    let raw = read_source_bytes(src).map_err(|e| e.to_string())?;
    let thumb = make_thumb(&raw, w)?;
    let _ = fs::write(&cache_path, &thumb); // best-effort cache write
    Ok((thumb, "image/jpeg"))
}

fn serve_full(src: &Src) -> Result<(Vec<u8>, &'static str), String> {
    let raw = read_source_bytes(src).map_err(|e| e.to_string())?;
    match passthrough_content_type(&ext_of(&src.path)) {
        Some(ct) => Ok((raw, ct)),
        // AVIF / exotic formats: transcode so any webview can render them
        None => Ok((transcode_jpeg(&raw)?, "image/jpeg")),
    }
}

fn make_thumb(bytes: &[u8], w: u32) -> Result<Vec<u8>, String> {
    let img = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;

    // `thumbnail` preserves aspect ratio, fitting within w×w (longest side ≈ w)
    let thumb = img.thumbnail(w, w);
    encode_jpeg(thumb)
}

fn transcode_jpeg(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;
    encode_jpeg(img)
}

/// Encode to JPEG, dropping any alpha channel (the JPEG encoder rejects RGBA).
fn encode_jpeg(img: image::DynamicImage) -> Result<Vec<u8>, String> {
    let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8());
    let mut out = Cursor::new(Vec::new());
    rgb.write_to(&mut out, ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

// ---------------------------------------------------------------------------
// Thumbnail cache helpers
// ---------------------------------------------------------------------------

fn thumbs_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Cache key = container file (size, mtime) + inner entry name + w.
fn cache_key(src: &Src, w: u32) -> String {
    let container = src.archive.as_deref().unwrap_or(&src.path);
    let (size, mtime) = file_sig(container);

    let mut h = DefaultHasher::new();
    container.hash(&mut h);
    size.hash(&mut h);
    mtime.hash(&mut h);
    src.path.hash(&mut h); // inner entry name (equals path when not an archive)
    w.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn file_sig(path: &str) -> (u64, u64) {
    match fs::metadata(path) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (m.len(), mtime)
        }
        Err(_) => (0, 0),
    }
}

// ---------------------------------------------------------------------------
// Tiny query-string parser (avoids pulling in the `url` crate)
// ---------------------------------------------------------------------------

fn parse_query(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if query.is_empty() {
        return map;
    }
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = it.next().unwrap_or("");
        if !k.is_empty() {
            map.insert(percent_decode(k), percent_decode(v));
        }
    }
    map
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                match (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                    (Some(h), Some(l)) => {
                        out.push(h * 16 + l);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn error_response(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}
