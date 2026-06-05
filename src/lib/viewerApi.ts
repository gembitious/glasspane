// viewerApi.ts — frontend bridge to the glasspane Rust backend.
//
// Two planes (see CLAUDE.md §6):
//   - data plane:  typed `invoke` wrappers (directory/archive listings + metadata)
//   - image plane: `imgsrv://` URL builders streamed straight into <img>
//
// Keep these contracts in sync with src-tauri/src/imaging.rs.

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types (mirror the Rust structs)
// ---------------------------------------------------------------------------

export type EntryKind = "dir" | "archive" | "image";

export interface DirEntry {
  name: string;
  path: string;
  kind: EntryKind;
  /** byte size from filesystem metadata (0 if unavailable) */
  size: number;
  /** modified time, seconds since the Unix epoch (0 if unavailable) */
  mtime: number;
}

export interface ArchiveEntry {
  name: string;
  /** uncompressed byte size of the entry */
  size: number;
  /** monotonic sort key from the entry's DOS date/time (not a true epoch) */
  mtime: number;
}

export interface ImageMeta {
  width: number;
  height: number;
  size: number;
}

/**
 * A source for the image-bytes plane / metadata.
 * If `archive` is set, `path` is the entry name *inside* that zip;
 * otherwise `path` is a filesystem path.
 */
export interface Src {
  archive?: string;
  path: string;
}

/**
 * Frontend item model used by the grid / preview / viewer.
 *   - folder image → { name, path }
 *   - zip entry    → { name: entry, path: entry, archive: zipPath }
 */
export interface ImgRef {
  name: string;
  path: string;
  archive?: string;
}

// ---------------------------------------------------------------------------
// Data plane — invoke commands
// ---------------------------------------------------------------------------

export function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path });
}

export function listArchive(path: string): Promise<ArchiveEntry[]> {
  return invoke<ArchiveEntry[]>("list_archive", { path });
}

export function imageMeta(ref: ImgRef): Promise<ImageMeta> {
  return invoke<ImageMeta>("image_meta", { src: refToSrc(ref) });
}

function refToSrc(ref: ImgRef): Src {
  return ref.archive ? { archive: ref.archive, path: ref.path } : { path: ref.path };
}

// ---------------------------------------------------------------------------
// Image-bytes plane — imgsrv:// URL builders
// ---------------------------------------------------------------------------

// Tauri serves custom protocols differently per platform: on Windows the
// scheme is folded into an http origin, elsewhere it stays a real scheme.
function imgsrvOrigin(): string {
  const isWindows =
    typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
  return isWindows ? "http://imgsrv.localhost" : "imgsrv://localhost";
}

/** Cached JPEG thumbnail, longest side ≈ `w`. */
export function thumbUrl(ref: ImgRef, w: number): string {
  const params = new URLSearchParams();
  params.set("path", ref.path);
  params.set("w", String(w));
  if (ref.archive) params.set("archive", ref.archive);
  return `${imgsrvOrigin()}/thumb?${params.toString()}`;
}

/** Full image bytes (original bytes when webview-safe, else transcoded JPEG). */
export function fullUrl(ref: ImgRef): string {
  const params = new URLSearchParams();
  params.set("path", ref.path);
  if (ref.archive) params.set("archive", ref.archive);
  return `${imgsrvOrigin()}/full?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Batch conversion (decode -> re-encode)
// ---------------------------------------------------------------------------

export type ConvertFormat = "jpg" | "png" | "webp";

export interface ConvertOpts {
  format: ConvertFormat;
  destDir: string;
  /** JPEG quality 1–100; ignored for png/webp (lossless). */
  quality?: number;
  /** Overwrite existing files instead of adding a numeric suffix. */
  overwrite?: boolean;
}

export interface ConvertFailure {
  name: string;
  error: string;
}

export interface ConvertReport {
  ok: number;
  failed: ConvertFailure[];
  outputs: string[];
}

/** Convert images to `opts.format` in `opts.destDir`. */
export function convertImages(refs: ImgRef[], opts: ConvertOpts): Promise<ConvertReport> {
  return invoke<ConvertReport>("convert_images", { sources: refs.map(refToSrc), opts });
}
