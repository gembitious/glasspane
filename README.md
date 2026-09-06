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

WebP and AVIF both view natively; see **Prerequisites** below for how AVIF decode is built.

## Stack

- Frontend: React + TypeScript + Vite
- Backend: Rust (Tauri 2)
- Image decode: [`image`](https://crates.io/crates/image) for WebP/JPEG/PNG/GIF; AVIF via [`avif-parse`](https://crates.io/crates/avif-parse) + [`rav1d`](https://crates.io/crates/rav1d) (the Rust port of dav1d) — all pure Rust
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

**AVIF is built in — no extra libraries on any OS.** AVIF is decoded in pure Rust
(`avif-parse` reads the container, `rav1d` — the Rust port of dav1d — decodes the AV1 payload),
so the plain `npm run tauri build` supports it on Windows, macOS, and Linux alike. It sits behind
the `avif` cargo feature, which is **on by default**; `--no-default-features` drops it if you ever
want a slightly smaller binary.

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
- **Last position is remembered per folder/archive** — come back and the same image is selected
  with the grid scrolled to it. Paging in the fullscreen viewer moves that selection too, so
  closing the viewer lands on the page you were reading.
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
- [x] AVIF decode — pure Rust (rav1d), on by default on every platform
- [x] Keyboard-first navigation polish
- [x] Filename search/filter + recent folders
- [x] Batch export / convert module (jpg/png/webp)
- [x] Multi-select + date/size sort
- [x] Packaging (release build + CI release workflow)
