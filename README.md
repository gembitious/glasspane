# glasspane

A fast, lightweight image viewer built around my own workflow: an explorer-style
browser that treats `.zip`/`.cbz` archives like folders, native WebP/AVIF viewing,
and a virtualized thumbnail grid that stays smooth on folders with thousands of
images.

Built with **Tauri 2** (Rust backend + web frontend) for a small, fast binary.

## Status

Usable day to day. Everything in the target workflow is wired to the real backend:
folder/archive tree, virtualized grid, fullscreen reader (wheel paging, fit modes,
neighbour preloading), search, multi-select, batch convert, and an on-disk cache for
thumbnails and transcoded full images. CI gates PRs (type-check, clippy, tests) and the
release workflow produces deb/rpm, msi/exe, and dmg bundles.

WebP works everywhere. **AVIF decode is opt-in** (`--features avif`, needs libdav1d) and
currently only enabled on Linux/macOS builds — Windows AVIF support is the next milestone.

## Stack

- Frontend: React + TypeScript + Vite
- Backend: Rust (Tauri 2)
- Image decode: [`image`](https://crates.io/crates/image) (WebP is pure-Rust; AVIF via the opt-in `avif` feature / libdav1d)
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

- **Node.js 20.19+ or 22.12+** (Vite 7's minimum). The repo pins Node 22 via `.nvmrc` —
  `nvm use` (or `fnm use`) picks it up. Older 20.x prints a Vite "please upgrade" error.
- **Rust (stable)** via [rustup](https://rustup.rs/) — `npm run tauri build` shells out to
  `cargo`, so a missing toolchain fails with `cargo metadata … program not found`.
- The rest of the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS
  (WebView, build tools).

**AVIF is opt-in.** The default build needs no extra system libraries and works everywhere
(WebP/JPEG/PNG/GIF). AVIF decode links the system **libdav1d** (≥ 1.3.0) through pkg-config, so
it's behind the `avif` cargo feature — enable it only where libdav1d is available:

```bash
npm run tauri dev   -- --features avif
npm run tauri build -- --features avif
```

- Debian/Ubuntu: `sudo apt install libdav1d-dev pkg-config` (needs 24.04+; 22.04 ships 0.9.x)
- macOS: `brew install dav1d pkg-config`
- Windows: provide `dav1d` via vcpkg (fiddly) — or just omit `--features avif`; AVIF files then
  show a broken-thumbnail placeholder while everything else works.

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

**Fullscreen viewer:** the scroll **wheel pages** prev/next (`←`/`→`/`Home`/`End` also navigate,
`Esc` closes). Zoom with **`Ctrl`+wheel** or `+`/`-`; `0` or double-click resets; drag to pan.
**Fit modes** — 화면 (fit) / 너비 (width) / 실제 (actual) — are in the info bar and persist; in
너비/실제 the wheel **scrolls a tall page** and only turns the page at the top/bottom edge.
Adjacent pages are preloaded so paging is instant; a spinner shows while a page loads.

## Other niceties

- **Address bar:** double-click the breadcrumb (or the `✎` button) to type/paste any folder or
  `.zip`/`.cbz` path and jump there; `↑` goes to the parent folder (even above the current root).
- **Drag and drop** a folder or `.zip`/`.cbz` onto the window to open it.
- **Copy path** of the selected image from the preview panel.
- The **window size and position are remembered** across launches.

## Building & releasing

```bash
npm run tauri build                      # release binary + default bundles for the host OS
npm run tauri build -- --bundles nsis    # pick bundles for this build only (overrides config)
npm run tauri build -- --no-bundle       # release binary only (fastest)
```

Default bundle targets (`bundle.targets` in `tauri.conf.json`): `deb`/`rpm` on Linux,
`nsis`/`msi` on Windows, `dmg`/`app` on macOS — targets that don't apply to the host OS are
ignored. **AppImage is off by default** (it's ~78 MB and rarely needed); build it on demand
with `--bundles appimage`.

Pushing a `v*` tag (or running the **release** workflow manually) builds bundles for
macOS, Linux, and Windows via [`tauri-action`](.github/workflows/release.yml) and attaches
them to a draft GitHub Release. A manual run lets you choose the Linux bundles
(`deb,rpm` by default, or include `appimage`); tag pushes use the default.

## Roadmap

- [x] Wire the UI to real directories and archives
- [x] Background thumbnail decode + on-disk cache
- [x] AVIF decode (enable the `avif-native` feature)
- [x] Keyboard-first navigation polish
- [x] Filename search/filter + recent folders
- [x] Batch export / convert module (jpg/png/webp)
- [x] Multi-select + date/size sort
- [x] Packaging (release build + CI release workflow)
