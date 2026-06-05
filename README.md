# image-viewer

A fast, lightweight image viewer built around my own workflow: an explorer-style
browser that treats `.zip`/`.cbz` archives like folders, native WebP/AVIF viewing,
and a virtualized thumbnail grid that stays smooth on folders with thousands of
images.

Built with **Tauri 2** (Rust backend + web frontend) for a small, fast binary.

## Status

Early development. The interactive UX prototype is in place; backend wiring
(directory + archive reading, off-thread thumbnail decode) is being connected.

## Stack

- Frontend: React + TypeScript + Vite
- Backend: Rust (Tauri 2)
- Image decode: [`image`](https://crates.io/crates/image) (WebP is pure-Rust; AVIF via the `avif-native` feature / libdav1d)
- Archives: [`zip`](https://crates.io/crates/zip) (reads entries without extracting)

## Architecture

- Listing and metadata go over Tauri `invoke` commands (`list_dir`, `list_archive`, `image_meta`).
- Image bytes are served through a custom URI-scheme protocol (`imgsrv://…`)
  straight to `<img>` — no base64 over the IPC bridge.
- Thumbnails are decoded off the main thread and cached on disk, keyed by the
  source file's (size, mtime), so revisiting a folder is instant.

## Project structure

```
src/
  App.tsx            # viewer UI (folder/zip tree + virtualized grid + fullscreen viewer)
  lib/viewerApi.ts   # invoke wrappers + imgsrv URL builders
src-tauri/
  src/imaging.rs     # invoke commands + imgsrv protocol + thumbnail cache
  src/lib.rs         # registers the protocol and the commands
  tauri.conf.json    # CSP allows the imgsrv scheme
```

## Getting started

```bash
npm install
npm run tauri dev      # run the desktop app in dev mode
npm run tauri build    # produce a release binary
```

### Prerequisites

Besides the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/), AVIF decoding
links the system **libdav1d**:

- Debian/Ubuntu: `sudo apt install libdav1d-dev`
- macOS: `brew install dav1d`
- Windows: install `dav1d` via vcpkg

If libdav1d is unavailable, drop the `avif-native` feature from `src-tauri/Cargo.toml`; the app
still builds and AVIF files simply show a broken-thumbnail placeholder.

## Keyboard shortcuts

**Thumbnail grid** (when the fullscreen viewer is closed):

| Key | Action |
| :-- | :-- |
| `←` `→` | Move selection by one |
| `↑` `↓` | Move selection by one row |
| `PageUp` `PageDown` | Move selection by one page |
| `Home` `End` | First / last image |
| `Shift` + move | Extend the selection range |
| `Ctrl/Cmd` + click | Toggle an image in the selection |
| `Shift` + click | Select a range |
| `Ctrl/Cmd` + `A` | Select all |
| `Enter` / `F` | Open the active image fullscreen |

**Fullscreen viewer:** `←` `→` navigate, `Home` `End` jump to first/last, `Esc` closes.
The selected tile always scrolls into view as you move.

## Building & releasing

```bash
npm run tauri build              # release binary + native bundles for the host OS
npm run tauri build -- --no-bundle   # release binary only (skips deb/AppImage/etc.)
```

Pushing a `v*` tag (or running the **release** workflow manually) builds bundles for
macOS, Linux, and Windows via [`tauri-action`](.github/workflows/release.yml) and attaches
them to a draft GitHub Release.

## Roadmap

- [x] Wire the UI to real directories and archives
- [x] Background thumbnail decode + on-disk cache
- [x] AVIF decode (enable the `avif-native` feature)
- [x] Keyboard-first navigation polish
- [x] Filename search/filter + recent folders
- [x] Batch export / convert module (jpg/png/webp)
- [x] Multi-select + date/size sort
- [x] Packaging (release build + CI release workflow)
