# glasspane — project brief & build plan

> **How to use this file.** Save it as `CLAUDE.md` in the repo root — Claude Code reads it
> automatically. To start, tell Claude Code: _"Read CLAUDE.md, then begin Phase 0."_
> Five starter files are provided in the repo by the user (see §4); reuse them. If any is
> missing, regenerate it from the contracts in §6–§8. This brief is self-contained — it does
> not assume access to the chat it came from.

---

## 1. What we're building

**glasspane** — a fast, lightweight, personal image viewer. An explorer-style browser that
treats `.zip`/`.cbz` archives like folders, views **WebP/AVIF natively**, and keeps a
**virtualized thumbnail grid** smooth on folders with thousands of images. Desktop app via
**Tauri 2** (small, fast binary).

**Why it exists.** It replaces a heavy viewer (ALSee) and a light-but-no-explorer one
(Honeyview). Two pain points drove the design:

1. Browsing image collections that live **inside zip files**, going in and out frequently.
2. **Native WebP viewing**, so there's no more converting images just to look at them.

It's built to fit one user's workflow — favor sharp, fast, focused behavior over breadth.

### Non-goals (for now)

- No built-in image editing.
- **No conversion/export module yet** (explicitly deferred — see §11). Native WebP/AVIF
  viewing removes the old "convert-to-view" need.
- Not targeting mobile.

---

## 2. Target workflow (what must feel good)

- Open a root folder; navigate a tree of folders **and** zip archives (zips expand and behave
  like folders).
- Click a folder or zip → its images fill a thumbnail grid; scrolling stays smooth at
  thousands of images.
- Single-click selects (preview panel updates); double-click / Enter opens a **fullscreen
  viewer** with `←` `→` `Home` `End` `Esc`.
- WebP and AVIF show **without any conversion step**.

---

## 3. Stack

- **Frontend:** React + TypeScript + Vite
- **Desktop shell + backend:** Tauri 2 (Rust)
- **Image decode:** [`image`](https://crates.io/crates/image) crate — WebP is pure-Rust; AVIF
  via the `avif-decoder` feature (pulls **libdav1d**, deferred — see §10).
- **Archives:** [`zip`](https://crates.io/crates/zip) crate — reads entries without extracting.
- **Folder picker:** `tauri-plugin-dialog`.
- **(optional) persist last folder:** `tauri-plugin-store`.

Rationale: Tauri → tiny/fast binary (the "lightweight" goal); Rust does fast off-thread decode

- zip reading; React lets us reuse the existing prototype UI.

---

## 4. Current state (read this first)

Three artifacts already exist (provided in the repo by the user), **not yet wired together**:

- **The UX prototype** — a complete, working React component with **MOCK data** (folder/zip
  tree, virtualized grid, preview panel, fullscreen viewer, sort/filter, _simulated_ async
  thumbnail load). This is the **visual target**. Lands at `src/App.tsx`.
- **`imaging.rs`** — the **Rust backend module**: invoke commands + the `imgsrv` custom
  protocol + a thumbnail cache + zip support. Lands at `src-tauri/src/imaging.rs`.
- **`viewerApi.ts`** — the **frontend bridge**: typed `invoke` wrappers + `imgsrv` URL
  builders. Lands at `src/lib/viewerApi.ts`.

Also provided: `README.md` and `.gitignore` for the repo root.

**Done:** architecture decided; prototype, backend module, and bridge written.
**Not done:** the real project scaffold, wiring the UI to the backend ("**v3**", §9), AVIF,
packaging.

---

## 5. Phase 0 — repository setup

1. **Scaffold:** `npm create tauri-app@latest glasspane` → choose **TypeScript / React / Vite**.
   Then `cd glasspane && npm install`.
2. **Place provided files:**
   - prototype component → `src/App.tsx` (it's plain React; rename to `.tsx`, fix obvious type
     nits, keep the inline-style approach as-is)
   - `viewerApi.ts` → `src/lib/viewerApi.ts`
   - `imaging.rs` → `src-tauri/src/imaging.rs`
   - `README.md`, `.gitignore` → repo root (merge/replace the scaffolder's `.gitignore`; it must
     ignore `node_modules/`, `src-tauri/target/`, `dist/`)
3. **Apply the wiring edits** in §7.
4. **Sanity check:** `npm run tauri dev` — the prototype UI (still mock data) should boot.
5. **Git + GitHub** (the user runs this — it needs their GitHub auth):
   - GitHub CLI: `gh repo create glasspane --private --source=. --remote=origin --push`
   - or manual: create an empty repo on GitHub (no README/license), then
     `git init` (skip if the scaffolder did it) → `git add .` →
     `git commit -m "Initial commit: Tauri image viewer scaffold + UX prototype"` →
     `git branch -M main` → `git remote add origin <url>` → `git push -u origin main`

**Acceptance:** app boots in dev showing the prototype; repo is pushed to GitHub.

---

## 6. Architecture & contracts

### 6.1 Two planes

- **Data plane (`invoke` commands)** — directory listings and metadata.
- **Image-bytes plane (custom URI protocol `imgsrv://`)** — thumbnail and full-image bytes
  streamed straight into `<img>`. **Do not** send image bytes as base64 over `invoke` (memory
  and IPC-bridge blowup with large images and many thumbnails).

### 6.2 invoke commands (Rust, in `imaging.rs`)

- `list_dir(path: String) -> Vec<DirEntry>`, `DirEntry = { name, path, kind: "dir"|"archive"|"image" }`, sorted dirs-first then name (case-insensitive).
- `list_archive(path: String) -> Vec<ArchiveEntry>`, `ArchiveEntry = { name }` — the image entries inside the zip.
- `image_meta(src: Src) -> ImageMeta`, `ImageMeta = { width, height, size }`.
- `Src = { archive?: string, path: string }` — if `archive` is set, `path` is the **entry name
  inside that zip**; otherwise `path` is a **filesystem path**.

> App commands defined via `generate_handler!` do **not** need a capability/permission entry —
> only _plugin_ commands (e.g. dialog) do (see §7.4).

### 6.3 The `imgsrv` protocol

- `imgsrv://localhost/thumb?path=<...>&w=256[&archive=<zip>]` → cached JPEG thumbnail (longest
  side ≈ `w`), decoded off-thread, disk-cached.
- `imgsrv://localhost/full?path=<...>[&archive=<zip>]` → full image bytes (original bytes for
  webview-safe formats; AVIF/exotic transcoded to JPEG so any webview can render them).
- **Cache key** = container file `(size, mtime)` + inner entry name + `w`. Stored under the app
  cache dir in `/thumbs`.
- The frontend builds these URLs via `viewerApi.ts` (`thumbUrl`, `fullUrl`), which handles the
  per-platform origin (Windows: `http://imgsrv.localhost`; elsewhere: `imgsrv://localhost`).

### 6.4 Frontend item model

`ImgRef = { name, path, archive? }`.

- Folder image → `{ name, path }`.
- Zip entry → `{ name: entry, path: entry, archive: zipPath }`.
  Pass `ImgRef` to `thumbUrl(ref, w)`, `fullUrl(ref)`, and `imageMeta(ref)`.

---

## 7. Wiring edits (to scaffolder-generated files)

### 7.1 `src-tauri/Cargo.toml` → `[dependencies]`

```toml
serde = { version = "1", features = ["derive"] }
image = { version = "0.25" }            # add features = ["avif-decoder"] LATER for AVIF (pulls libdav1d, a C lib)
zip = "2"
tauri-plugin-dialog = "2"               # native folder picker
```

> `imaging.rs` builds fine without `avif-decoder`: WebP/JPEG/PNG/GIF work; AVIF sources just
> error gracefully (broken-thumbnail placeholder) until the feature is enabled.

### 7.2 `src-tauri/src/lib.rs`

```rust
mod imaging;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = imaging::register_imgsrv(tauri::Builder::default());
    builder
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            imaging::list_dir,
            imaging::list_archive,
            imaging::image_meta
        ])
        .run(tauri::generate_context!())
        .expect("error while running glasspane");
}
```

### 7.3 `src-tauri/tauri.conf.json` → `app.security.csp`

```
default-src 'self'; img-src 'self' imgsrv: http://imgsrv.localhost data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com
```

The `imgsrv` scheme is required for images; `unsafe-inline` + the Google-Fonts hosts are
required because the prototype uses inline styles and a Google-Fonts `@import`.

### 7.4 `src-tauri/capabilities/default.json`

Add the dialog plugin permission (and the store plugin permission if you use it):

```json
{ "permissions": ["dialog:allow-open"] }
```

(Merge into the existing `permissions` array.)

---

## 8. Frontend UX spec (the prototype is the visual target)

The provided prototype already implements all of this with mock data; **v3 swaps the mock data
for real backend calls**. Feature list (so it can be rebuilt if ever needed):

- **Layout (3-pane):** left folder/zip **tree** | center virtualized **thumbnail grid** |
  right collapsible **preview panel**. Plus a titlebar, two toolbar rows, and a status bar.
  Dark "developer-tool" aesthetic; JetBrains Mono for filenames/numbers.
- **Tree:** folders and zips shown together; zips expand/behave like folders. Selecting a node
  loads its images into the grid. Item counts shown per node.
- **Virtualized grid (manual, no library):** compute column count from container width and tile
  size; render only the visible rows plus a small overscan; absolute-position tiles inside a
  spacer sized to the full height. Tile = thumbnail + filename + format badge (webp/avif
  highlighted). Selection ring; single-click selects, double-click opens.
- **Thumbnail load:** each tile is a real `<img>` whose `onLoad` flips a per-id "loaded" flag →
  fade-in over a skeleton; the filename shows immediately. Keep a `loadedRef` Set so revisiting
  (plus the browser cache) makes it instant.
- **Toolbar:** clickable breadcrumb (navigate up); thumbnail size S/M/L; format filter chips
  (webp/avif/jpg/png toggles); sort (name / format / size).
- **Status bar:** image count, current node, sort, selected filename, columns × rows.
- **Preview panel (collapsible):** large preview of the selected image (via `fullUrl`),
  metadata (format, resolution, size via `image_meta`, path), and a "전체화면 열기" button.
- **Fullscreen viewer:** large image (via `fullUrl`); prev/next buttons + keyboard
  `←` `→` `Home` `End`; `Esc`/backdrop closes; info bar (path › name, n/total, zoom).

---

## 9. Phase v3 — wire the UI to the backend (main remaining work)

Each task has an acceptance criterion (AC).

1. **Open a root folder.** Add a "폴더 열기" action using `tauri-plugin-dialog`
   `open({ directory: true })`; set the chosen path as the tree root. _(Optional: persist the
   last root with `tauri-plugin-store`.)_
   **AC:** picking a folder shows it as the tree root.

2. **Dynamic tree.** Remove the mock `TREE`. When a folder node expands, call `listDir(path)`
   and show its `dir` + `archive` children (lazily). Images are **not** tree nodes.
   **AC:** the tree reflects the real filesystem; zip files appear as nodes.

3. **Grid data on selection.**
   - folder node → `listDir(path)`, keep `kind === "image"` → map to `ImgRef { name, path }`.
   - archive node → `listArchive(path)` → map to `ImgRef { name: entry, path: entry, archive: path }`.
   - Reset selection + scroll on node change.
     **AC:** selecting a folder or a zip fills the grid with that location's images.

4. **Real thumbnails.** Replace the simulated decode with:

   ```jsx
   <img src={thumbUrl(item, 256)} loading="lazy" decoding="async"
        onLoad={() => { loadedRef.current.add(item.id); setLoadTick(v => v + 1); }}
        onError={/* show a broken-image placeholder */}
        style={{ position:"absolute", inset:0, width:"100%", height:"100%",
                 objectFit:"cover", opacity: loaded ? 1 : 0, transition:"opacity .28s ease" }} />
   ```

   Delete the prototype's simulated `setTimeout` "decode" effect; keep the `loadedRef` cache.
   **AC:** thumbnails render from the disk cache, fade in once, are instant on re-scroll, and a
   broken file shows a placeholder instead of crashing the grid.

5. **Preview metadata.** On selection, call `image_meta(item)` (async) and show the real
   resolution/size; the preview image uses `fullUrl(item)`.
   **AC:** the preview shows correct dimensions/size and updates as the selection changes.

6. **Fullscreen viewer.** Show `fullUrl(item)`; keep the existing keyboard navigation.
   **AC:** opens the full image; `←`/`→` navigate within the current folder/zip; transcoded
   formats (and AVIF, once enabled) display.

7. **Sort.** name/format work from the listing immediately; **size** needs metadata — either
   fetch it lazily and sort once available, or defer size-sort with a clear TODO.
   **AC:** name/format sort works; size-sort works or is clearly deferred.

---

## 10. Gotchas / things to verify

- **Tauri 2.x API:** confirm the `register_asynchronous_uri_scheme_protocol` closure shape
  (`|ctx, request, responder|` → `responder.respond(http::Response…)`) against the installed
  Tauri version; adjust if it differs.
- **AVIF:** start **without** the `avif-decoder` feature so the project builds with zero C deps.
  Enable it later (macOS: `brew install dav1d` + pkg-config; Windows: vcpkg).
- **CSP:** must include the `imgsrv` scheme in `img-src` and the Google-Fonts hosts, or images
  and fonts silently fail to load.
- **Protocol origin differs per platform** — handled in `viewerApi.ts` via a UA check; don't
  hardcode one form.
- **Thumbnail concurrency:** the protocol handler currently spawns a thread per request; a grid
  asking for many thumbnails at once can spawn a lot of threads. Harden with a bounded worker
  pool or a global semaphore (≈ `num_cpus`) around the decode. _(Optimization, not a blocker.)_
- **Large directories:** rely on virtualization + lazy `<img>` so only visible thumbnails
  decode; don't eagerly fetch metadata for an entire listing.
- **This is a real app, not a chat artifact:** `localStorage`/persistent storage is fine here.

---

## 11. Roadmap (after v3)

- Enable AVIF decode (`avif-decoder` + libdav1d).
- **Batch export / convert module** (deferred): right-click a selection / folder / zip → convert
  to jpg/png/webp. Implement decode→encode in Rust. _(The user has an existing PyQt WebP→JPG
  converter whose logic and UX are a useful reference, but here it's reimplemented in Rust.)_
  Build it as an isolated **feature module**, not a plugin system.
- Multi-select; date sort; configurable keybindings.
- Recent folders; filename search/filter.
- Optional: serve disk-cached thumbnails via the built-in `asset:` protocol
  (`convertFileSrc`) as an alternative to `imgsrv` for the thumbnail path (full images and
  zip-internal images still need `imgsrv`).

---

## 12. Conventions & preferences

- TypeScript strict. Keep the **manual virtualization** (avoid heavy grid libraries); keep
  dependencies minimal overall.
- Keep the frontend↔backend **contracts in §6 stable**. If you change a command or URL shape,
  update `viewerApi.ts` and this file in the same change.
- Prefer **complete-file edits** over scattered partial patches when changing a file.
- Small, logical commits; run `npm run tauri dev` to verify each phase before moving on.
- **Ask before** adding a new dependency or changing the §6 architecture.
- **Branch naming:** use `<prefix>/<feature>`, where `<prefix>` is the kind of work
  (`feat`, `fix`, `refactor`, `chore`, `docs`, …) and `<feature>` is a short kebab-case
  description of what's being worked on — e.g. `feat/wire-backend`, `fix/thumbnail-cache-key`,
  `docs/readme`. One branch per logical piece of work.
