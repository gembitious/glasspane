// convert.rs — batch image conversion (CLAUDE.md §11).
//
// An isolated feature module: decode each source (filesystem file or zip entry)
// and re-encode it to jpg/png/webp in a destination folder. This is the Rust
// reimplementation of the old PyQt WebP→JPG converter, generalized.
//
// Exposed as the `convert_images` invoke command.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::{ExtendedColorType, ImageEncoder, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::imaging::{read_source_bytes, Src};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: u32,
    pub total: u32,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertOpts {
    /// "jpg" | "png" | "webp"
    pub format: String,
    pub dest_dir: String,
    /// JPEG quality 1–100 (ignored for png/webp, which are lossless here)
    pub quality: Option<u8>,
    /// Overwrite existing files instead of adding a numeric suffix
    pub overwrite: Option<bool>,
}

#[derive(Serialize)]
pub struct ConvertFailure {
    pub name: String,
    pub error: String,
}

#[derive(Serialize)]
pub struct ConvertReport {
    pub ok: u32,
    pub failed: Vec<ConvertFailure>,
    pub outputs: Vec<String>,
}

#[tauri::command]
pub fn convert_images(
    sources: Vec<Src>,
    opts: ConvertOpts,
    on_progress: Channel<Progress>,
) -> Result<ConvertReport, String> {
    let ext = normalize_ext(&opts.format)?;
    let dir = Path::new(&opts.dest_dir);
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let quality = opts.quality.unwrap_or(90).clamp(1, 100);
    let overwrite = opts.overwrite.unwrap_or(false);
    let total = sources.len() as u32;

    let mut report = ConvertReport {
        ok: 0,
        failed: Vec::new(),
        outputs: Vec::new(),
    };

    for (i, src) in sources.iter().enumerate() {
        match convert_one(src, &opts.format, ext, quality, dir, overwrite) {
            Ok(out) => {
                report.ok += 1;
                report.outputs.push(out.to_string_lossy().into_owned());
            }
            Err(error) => report.failed.push(ConvertFailure {
                name: src.path.clone(),
                error,
            }),
        }
        let _ = on_progress.send(Progress {
            done: i as u32 + 1,
            total,
            name: base_stem(&src.path),
        });
    }

    Ok(report)
}

fn convert_one(
    src: &Src,
    format: &str,
    ext: &str,
    quality: u8,
    dir: &Path,
    overwrite: bool,
) -> Result<PathBuf, String> {
    let raw = read_source_bytes(src).map_err(|e| e.to_string())?;
    let img = ImageReader::new(Cursor::new(&raw))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;

    let bytes = encode(&img, format, quality)?;
    let out_path = unique_path(dir, &base_stem(&src.path), ext, overwrite);
    fs::write(&out_path, &bytes).map_err(|e| e.to_string())?;
    Ok(out_path)
}

fn normalize_ext(format: &str) -> Result<&'static str, String> {
    match format {
        "jpg" | "jpeg" => Ok("jpg"),
        "png" => Ok("png"),
        "webp" => Ok("webp"),
        other => Err(format!("unsupported format: {other}")),
    }
}

fn encode(img: &image::DynamicImage, format: &str, quality: u8) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    match format {
        "jpg" | "jpeg" => {
            let rgb = img.to_rgb8(); // JPEG has no alpha
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
                .encode_image(&rgb)
                .map_err(|e| e.to_string())?;
        }
        "png" => {
            img.write_to(&mut out, ImageFormat::Png)
                .map_err(|e| e.to_string())?;
        }
        "webp" => {
            // the `image` crate only supports lossless WebP encoding
            let rgba = img.to_rgba8();
            image::codecs::webp::WebPEncoder::new_lossless(&mut out)
                .write_image(
                    rgba.as_raw(),
                    rgba.width(),
                    rgba.height(),
                    ExtendedColorType::Rgba8,
                )
                .map_err(|e| e.to_string())?;
        }
        other => return Err(format!("unsupported format: {other}")),
    }
    Ok(out.into_inner())
}

/// Filename without directory components and without its extension.
fn base_stem(name: &str) -> String {
    let file = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match file.rfind('.') {
        Some(i) if i > 0 => file[..i].to_string(),
        _ => file.to_string(),
    }
}

/// `<dir>/<stem>.<ext>`, adding `_1`, `_2`, … if it exists (unless overwriting).
fn unique_path(dir: &Path, stem: &str, ext: &str, overwrite: bool) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if overwrite || !first.exists() {
        return first;
    }
    let mut n = 1;
    loop {
        let candidate = dir.join(format!("{stem}_{n}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}
