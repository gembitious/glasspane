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
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

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
    /// byte size from filesystem metadata (0 if unavailable)
    pub size: u64,
    /// modified time, seconds since the Unix epoch (0 if unavailable)
    pub mtime: u64,
}

#[derive(Serialize)]
pub struct ArchiveEntry {
    pub name: String,
    /// uncompressed byte size of the entry
    pub size: u64,
    /// last-modified timestamp; a monotonic value suitable for sorting within
    /// the archive (DOS time fields, not a true Unix epoch)
    pub mtime: u64,
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

        let (size, mtime) = entry.metadata().map(meta_size_mtime).unwrap_or((0, 0));
        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            kind: kind.to_string(),
            size,
            mtime,
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
    let archive = archive_for(&path).map_err(|e| e.to_string())?;
    let mut archive = archive.lock().unwrap();

    let mut out: Vec<ArchiveEntry> = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if is_image(&ext_of(&name)) {
            let size = entry.size();
            let mtime = entry.last_modified().map(zip_dt_sort_key).unwrap_or(0);
            out.push(ArchiveEntry { name, size, mtime });
        }
    }

    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

#[tauri::command]
pub fn image_meta(src: Src) -> Result<ImageMeta, String> {
    let (width, height, size) = match &src.archive {
        // Filesystem file: read only the header for dimensions (no full load)
        // and take the byte size from metadata.
        None => {
            let size = fs::metadata(&src.path)
                .map(|m| m.len())
                .map_err(|e| e.to_string())?;
            let (w, h) = ImageReader::open(&src.path)
                .map_err(|e| e.to_string())?
                .with_guessed_format()
                .map_err(|e| e.to_string())?
                .into_dimensions()
                .map_err(|e| e.to_string())?;
            (w, h, size)
        }
        // Zip entry: must decompress to read it, so use the bytes we get.
        Some(_) => {
            let raw = read_source_bytes(&src).map_err(|e| e.to_string())?;
            let size = raw.len() as u64;
            let (w, h) = ImageReader::new(Cursor::new(&raw))
                .with_guessed_format()
                .map_err(|e| e.to_string())?
                .into_dimensions()
                .map_err(|e| e.to_string())?;
            (w, h, size)
        }
    };

    Ok(ImageMeta {
        width,
        height,
        size,
    })
}

/// Reveal `path` in the OS file manager, selecting the file where the platform
/// supports it. For zip entries the frontend passes the archive's own path.
// Each platform arm ends in `return`; whichever arm is last for a given target
// would otherwise trip needless_return.
#[allow(clippy::needless_return)]
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        // explorer.exe exits non-zero even on success, so don't check status.
        Command::new("explorer")
            .arg(format!("/select,{path}"))
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Prefer the freedesktop FileManager1 interface (selects the file in
        // Nautilus/Dolphin/Nemo); fall back to opening the containing folder.
        let selected = Command::new("dbus-send")
            .args([
                "--session",
                "--dest=org.freedesktop.FileManager1",
                "--type=method_call",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
                &format!("array:string:file://{path}"),
                "string:",
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !selected {
            let dir = Path::new(&path)
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from(&path));
            Command::new("xdg-open")
                .arg(dir)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        let _ = path;
        Err("reveal is not supported on this platform".into())
    }
}

// ---------------------------------------------------------------------------
// Reading source bytes (filesystem file or entry inside a zip)
// ---------------------------------------------------------------------------

pub(crate) fn read_source_bytes(src: &Src) -> std::io::Result<Vec<u8>> {
    match &src.archive {
        Some(zip_path) => {
            // Reuse a cached, already-parsed archive instead of reopening and
            // re-reading the central directory on every entry request.
            let archive = archive_for(zip_path)?;
            let mut archive = archive.lock().unwrap();
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
// Parsed-archive cache (avoids re-parsing a zip's central directory per entry)
// ---------------------------------------------------------------------------

type SharedArchive = Arc<Mutex<zip::ZipArchive<fs::File>>>;

struct CachedArchive {
    sig: (u64, u64), // (size, mtime) — invalidates the cache if the file changes
    archive: SharedArchive,
}

struct ArchiveCache {
    map: HashMap<String, CachedArchive>,
    order: Vec<String>, // LRU recency; back = most recently used
}

const ARCHIVE_CACHE_CAP: usize = 4;

fn archive_cache() -> &'static Mutex<ArchiveCache> {
    static CACHE: OnceLock<Mutex<ArchiveCache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(ArchiveCache {
            map: HashMap::new(),
            order: Vec::new(),
        })
    })
}

/// Return a shared handle to the parsed archive at `path`, opening (and caching)
/// it on a miss. The handle is cloned out before the read, so the cache lock is
/// not held while an entry is decompressed.
fn archive_for(path: &str) -> std::io::Result<SharedArchive> {
    let sig = file_sig(path);
    let mut cache = archive_cache().lock().unwrap();

    if let Some(cached) = cache.map.get(path) {
        if cached.sig == sig {
            let handle = cached.archive.clone();
            touch_lru(&mut cache.order, path);
            return Ok(handle);
        }
        // file changed on disk — drop the stale entry and reopen below
        cache.map.remove(path);
        cache.order.retain(|p| p != path);
    }

    let file = fs::File::open(path)?;
    let archive = zip::ZipArchive::new(file).map_err(std::io::Error::other)?;
    let handle: SharedArchive = Arc::new(Mutex::new(archive));
    cache.map.insert(
        path.to_string(),
        CachedArchive {
            sig,
            archive: handle.clone(),
        },
    );
    cache.order.push(path.to_string());

    // evict least-recently-used while over capacity
    while cache.order.len() > ARCHIVE_CACHE_CAP {
        let evict = cache.order.remove(0);
        cache.map.remove(&evict);
    }

    Ok(handle)
}

fn touch_lru(order: &mut Vec<String>, path: &str) {
    if let Some(i) = order.iter().position(|p| p == path) {
        let p = order.remove(i);
        order.push(p);
    }
}

// ---------------------------------------------------------------------------
// Decode concurrency limit
// ---------------------------------------------------------------------------

// The protocol handler spawns a thread per request, so a grid asking for many
// thumbnails at once could run a huge number of concurrent decodes. A counting
// semaphore (≈ available CPUs) caps how many decode at a time; extra threads
// block briefly on `acquire` instead of thrashing CPU/memory.
struct Semaphore {
    permits: Mutex<usize>,
    cv: Condvar,
}

struct Permit<'a>(&'a Semaphore);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        *self.0.permits.lock().unwrap() += 1;
        self.0.cv.notify_one();
    }
}

impl Semaphore {
    fn acquire(&self) -> Permit<'_> {
        let mut n = self.permits.lock().unwrap();
        while *n == 0 {
            n = self.cv.wait(n).unwrap();
        }
        *n -= 1;
        Permit(self)
    }
}

fn decode_sem() -> &'static Semaphore {
    static SEM: OnceLock<Semaphore> = OnceLock::new();
    SEM.get_or_init(|| {
        let permits = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        Semaphore {
            permits: Mutex::new(permits),
            cv: Condvar::new(),
        }
    })
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

    // disk-cache hit — cheap, no decode permit needed
    if let Ok(bytes) = fs::read(&cache_path) {
        return Ok((bytes, "image/jpeg"));
    }

    // bound the number of concurrent decodes (the grid can request hundreds at
    // once); the permit is held only for the read + decode + encode.
    let _permit = decode_sem().acquire();
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
        None => {
            let _permit = decode_sem().acquire();
            Ok((transcode_jpeg(&raw)?, "image/jpeg"))
        }
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

/// On-disk thumbnail cache budget. Beyond this, the oldest files are pruned.
const THUMB_CACHE_BUDGET: u64 = 512 * 1024 * 1024; // 512 MiB

/// Prune the thumbnail cache down to `THUMB_CACHE_BUDGET`, deleting the
/// least-recently-modified files first. Cheap no-op when already under budget.
/// Best-effort: any IO error just stops the prune (the cache self-heals).
pub fn prune_thumb_cache<R: Runtime>(app: &AppHandle<R>) {
    let dir = match thumbs_dir(app) {
        Ok(d) => d,
        Err(_) => return,
    };
    let rd = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };

    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for entry in rd.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
                total += meta.len();
                files.push((entry.path(), meta.len(), mtime));
            }
        }
    }

    if total <= THUMB_CACHE_BUDGET {
        return;
    }

    files.sort_by_key(|f| f.2); // oldest first
    for (path, size, _) in files {
        if total <= THUMB_CACHE_BUDGET {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total -= size;
        }
    }
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
        Ok(m) => meta_size_mtime(m),
        Err(_) => (0, 0),
    }
}

/// `(size, mtime_secs)` from filesystem metadata; mtime is Unix-epoch seconds.
fn meta_size_mtime(m: fs::Metadata) -> (u64, u64) {
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (m.len(), mtime)
}

/// A monotonic sort key from a zip entry's DOS date/time (not a Unix epoch,
/// but ordering is correct for sorting entries within an archive).
fn zip_dt_sort_key(dt: zip::DateTime) -> u64 {
    let y = dt.year() as u64;
    let mo = dt.month() as u64;
    let d = dt.day() as u64;
    let h = dt.hour() as u64;
    let mi = dt.minute() as u64;
    let s = dt.second() as u64;
    ((((y * 13 + mo) * 32 + d) * 24 + h) * 60 + mi) * 60 + s
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
            b'%' if i + 2 < bytes.len() => match (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                }
                _ => {
                    out.push(bytes[i]);
                    i += 1;
                }
            },
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

// ---------------------------------------------------------------------------
// Tests — pure helpers (no Tauri runtime / filesystem needed)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_query_handles_pairs_percent_and_plus() {
        let q = parse_query("path=a%2Fb%20c&w=256&archive=x.zip");
        assert_eq!(q.get("path").unwrap(), "a/b c");
        assert_eq!(q.get("w").unwrap(), "256");
        assert_eq!(q.get("archive").unwrap(), "x.zip");

        assert!(parse_query("").is_empty());
        assert_eq!(parse_query("k=a+b").get("k").unwrap(), "a b");
    }

    #[test]
    fn percent_decode_passes_invalid_escapes_through() {
        assert_eq!(percent_decode("%41%42"), "AB");
        assert_eq!(percent_decode("100%"), "100%"); // dangling % is literal
        assert_eq!(percent_decode("a%zzb"), "a%zzb"); // non-hex stays literal
    }

    #[test]
    fn format_classification() {
        assert_eq!(ext_of("PHOTO.JPG"), "jpg");
        assert_eq!(ext_of("noext"), "");
        assert!(is_image("webp") && is_image("avif") && is_image("png"));
        assert!(!is_image("txt"));
        assert!(is_archive("zip") && is_archive("cbz") && !is_archive("rar"));
        assert_eq!(passthrough_content_type("png"), Some("image/png"));
        assert_eq!(passthrough_content_type("avif"), None); // must be transcoded
    }

    #[test]
    fn zip_sort_key_is_monotonic_in_time() {
        // DOS time has 2-second resolution, so step by a minute / a day to stay
        // above the encoding granularity.
        let earlier = zip::DateTime::from_date_and_time(2020, 1, 1, 0, 0, 0).unwrap();
        let later = zip::DateTime::from_date_and_time(2020, 1, 1, 0, 1, 0).unwrap();
        let next_day = zip::DateTime::from_date_and_time(2020, 1, 2, 0, 0, 0).unwrap();
        assert!(zip_dt_sort_key(earlier) < zip_dt_sort_key(later));
        assert!(zip_dt_sort_key(later) < zip_dt_sort_key(next_day));
    }

    #[test]
    fn cache_key_is_stable_and_sensitive_to_inputs() {
        let a = Src {
            archive: None,
            path: "/tmp/does-not-exist.png".into(),
        };
        // deterministic for identical inputs
        assert_eq!(cache_key(&a, 256), cache_key(&a, 256));
        // width is part of the key
        assert_ne!(cache_key(&a, 256), cache_key(&a, 512));
        // entry path is part of the key
        let b = Src {
            archive: None,
            path: "/tmp/other.png".into(),
        };
        assert_ne!(cache_key(&a, 256), cache_key(&b, 256));
        // 16 hex chars
        let key = cache_key(&a, 256);
        assert_eq!(key.len(), 16);
        assert!(key.bytes().all(|c| c.is_ascii_hexdigit()));
    }
}
