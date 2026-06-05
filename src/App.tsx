// glasspane — main viewer UI (Phase v3: wired to the Rust backend).
//
// The 3-pane layout from the prototype (CLAUDE.md §8) now runs on real data:
//   - a lazily-loaded folder/zip tree (list_dir)
//   - a manually virtualized thumbnail grid backed by the imgsrv:// protocol
//   - a preview panel with real metadata (image_meta) and the full image
//   - a fullscreen viewer (fullUrl) with keyboard navigation
//
// Backend contracts live in src/lib/viewerApi.ts (kept in sync with imaging.rs).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  listDir,
  listArchive,
  imageMeta,
  thumbUrl,
  fullUrl,
  convertImages,
  revealInExplorer,
  type DirEntry,
  type ImageMeta,
  type ConvertFormat,
  type ConvertReport,
} from "./lib/viewerApi";
import "./App.css";

// ---------------------------------------------------------------------------
// Palette (dark "developer-tool" aesthetic)
// ---------------------------------------------------------------------------

const C = {
  bg: "#0d0f12",
  panel: "#13161b",
  panelAlt: "#171b21",
  border: "#232a33",
  borderSoft: "#1c222a",
  text: "#e6e8eb",
  textDim: "#8a93a0",
  textFaint: "#5b6470",
  accent: "#4c9aff",
  accentSoft: "#1f3a5f",
  webp: "#34d399",
  avif: "#c084fc",
  badge: "#2a323d",
  skeleton: "#1b2027",
  ring: "#4c9aff",
  danger: "#ef6a6a",
};

const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type NodeKind = "dir" | "archive";
type SortKey = "name" | "format" | "size" | "date";
type ThumbSizeKey = "S" | "M" | "L";

/** A grid item — a superset of viewerApi's ImgRef plus UI-only fields. */
interface Item {
  id: string;
  name: string;
  path: string;
  archive?: string;
  fmt: string;
  size: number;
  mtime: number;
}

const TILE: Record<ThumbSizeKey, number> = { S: 120, M: 168, L: 232 };
const THUMB_W: Record<ThumbSizeKey, number> = { S: 192, M: 256, L: 384 };
// Preview panel uses a large cached thumbnail rather than decoding the full
// original; the fullscreen viewer still loads full resolution.
const PREVIEW_W = 1024;
const GAP = 12;

// Natural-order name comparison so "page2" sorts before "page10" (matters a lot
// for numbered comic/zip pages). One reused Collator is cheap.
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byName = (a: string, b: string) => nameCollator.compare(a, b);

// The displayed/copyable path for an item (zip entries show archive › entry).
function itemPath(it: { archive?: string; path: string }): string {
  return it.archive ? `${it.archive} › ${it.path}` : it.path;
}

// Copy text to the clipboard, falling back to execCommand where the async
// Clipboard API is unavailable/blocked in the webview.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
const LABEL_H = 34;
const OVERSCAN_ROWS = 3;

// Known formats that get filter chips; anything else always shows.
const KNOWN_FORMATS = ["webp", "avif", "jpg", "png", "gif"] as const;
type KnownFormat = (typeof KNOWN_FORMATS)[number];

const ROOT_KEY = "glasspane.root";
const RECENT_KEY = "glasspane.recent";
const RECENT_MAX = 8;
const PREFS_KEY = "glasspane.prefs";

// ---------------------------------------------------------------------------
// Path / format helpers
// ---------------------------------------------------------------------------

function sepOf(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

// Parent directory of a path (keeps the root: "/a" → "/", "C:\\a" → "C:\\").
function parentDir(p: string): string {
  const sep = sepOf(p);
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return trimmed;
  if (idx === 0) return sep; // unix root "/"
  if (trimmed[idx - 1] === ":") return trimmed.slice(0, idx + 1) + sep; // "C:\\"
  return trimmed.slice(0, idx);
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function fmtOf(name: string): string {
  const e = extOf(name);
  return e === "jpeg" ? "jpg" : e;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function itemIdOf(path: string, archive?: string): string {
  return archive ? `${archive}::${path}` : path;
}

interface Crumb {
  name: string;
  path: string;
  kind: NodeKind;
}

function breadcrumb(root: string, sel: string, selKind: NodeKind): Crumb[] {
  const sep = sepOf(root);
  const crumbs: Crumb[] = [{ name: baseName(root) || root, path: root, kind: "dir" }];
  if (sel === root || !sel.startsWith(root)) return crumbs;

  let rest = sel.slice(root.length);
  while (rest.startsWith(sep)) rest = rest.slice(1);
  const segs = rest.split(sep).filter(Boolean);

  let acc = root;
  segs.forEach((s, i) => {
    acc = acc.endsWith(sep) ? acc + s : acc + sep + s;
    crumbs.push({ name: s, path: acc, kind: i === segs.length - 1 ? selKind : "dir" });
  });
  return crumbs;
}

// ===========================================================================
// App
// ===========================================================================

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];
  } catch {
    return [];
  }
}

interface UiPrefs {
  thumbSize: ThumbSizeKey;
  sortKey: SortKey;
  previewOpen: boolean;
}

function loadPrefs(): UiPrefs {
  const fallback: UiPrefs = { thumbSize: "M", sortKey: "name", previewOpen: true };
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return {
      thumbSize: v.thumbSize in TILE ? v.thumbSize : fallback.thumbSize,
      sortKey: ["name", "format", "size", "date"].includes(v.sortKey) ? v.sortKey : fallback.sortKey,
      previewOpen: typeof v.previewOpen === "boolean" ? v.previewOpen : fallback.previewOpen,
    };
  } catch {
    return fallback;
  }
}

const initialPrefs = loadPrefs();

export default function App() {
  const [rootPath, setRootPath] = useState<string | null>(() => localStorage.getItem(ROOT_KEY));
  const [recent, setRecent] = useState<string[]>(loadRecent);

  // tree state
  const [dirCache, setDirCache] = useState<Record<string, DirEntry[]>>({});
  const [archiveCount, setArchiveCount] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set());

  // selection / grid
  const [selected, setSelected] = useState<{ path: string; kind: NodeKind } | null>(null);
  const [nodeItems, setNodeItems] = useState<Item[]>([]);
  const [gridLoading, setGridLoading] = useState(false);
  const [gridError, setGridError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [cursorId, setCursorId] = useState<string | null>(null);
  const anchorRef = useRef<string | null>(null);

  // toolbar (size / sort / preview persist across sessions)
  const [thumbSize, setThumbSize] = useState<ThumbSizeKey>(() => initialPrefs.thumbSize);
  const [sortKey, setSortKey] = useState<SortKey>(() => initialPrefs.sortKey);
  const [activeFormats, setActiveFormats] = useState<Set<KnownFormat>>(new Set(KNOWN_FORMATS));
  const [previewOpen, setPreviewOpen] = useState(() => initialPrefs.previewOpen);
  const [query, setQuery] = useState("");

  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ thumbSize, sortKey, previewOpen }));
  }, [thumbSize, sortKey, previewOpen]);

  // viewer
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  // batch convert
  const [convertOpen, setConvertOpen] = useState(false);

  // metadata cache (preview + size sort); null = fetched-but-failed/unknown
  const metaRef = useRef<Record<string, ImageMeta | null>>({});
  const [metaTick, setMetaTick] = useState(0);

  // thumbnail load tracking
  const loadedRef = useRef<Set<string>>(new Set());
  const brokenRef = useRef<Set<string>>(new Set());
  const [loadTick, setLoadTick] = useState(0);
  const bumpLoad = useCallback(() => setLoadTick((v) => v + 1), []);

  // -------------------------------------------------------------------------
  // Tree loading
  // -------------------------------------------------------------------------

  const ensureDir = useCallback(
    async (path: string): Promise<DirEntry[]> => {
      const cached = dirCache[path];
      if (cached) return cached;
      setLoadingNodes((s) => new Set(s).add(path));
      try {
        const entries = await listDir(path);
        setDirCache((c) => ({ ...c, [path]: entries }));
        return entries;
      } finally {
        setLoadingNodes((s) => {
          const n = new Set(s);
          n.delete(path);
          return n;
        });
      }
    },
    [dirCache],
  );

  // -------------------------------------------------------------------------
  // Open root folder
  // -------------------------------------------------------------------------

  const openRoot = useCallback((picked: string) => {
    setRootPath(picked);
    localStorage.setItem(ROOT_KEY, picked);
    setRecent((prev) => {
      const next = [picked, ...prev.filter((p) => p !== picked)].slice(0, RECENT_MAX);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      return next;
    });
    // reset everything tied to the previous root
    setDirCache({});
    setArchiveCount({});
    setExpanded(new Set([picked]));
    setSelected({ path: picked, kind: "dir" });
  }, []);

  const pickFolder = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") openRoot(picked);
  }, [openRoot]);

  // Open a dropped path: a folder becomes the new root; a .zip/.cbz opens with
  // its parent as the root and the archive selected so its images load.
  const openDropped = useCallback(
    (path: string) => {
      if (/\.(zip|cbz)$/i.test(path)) {
        const parent = path.replace(/[\\/][^\\/]*$/, "");
        openRoot(parent || path);
        setSelected({ path, kind: "archive" });
      } else {
        openRoot(path);
      }
    },
    [openRoot],
  );

  // Native drag-and-drop (Tauri delivers real filesystem paths).
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "over" || e.payload.type === "enter") setDragOver(true);
        else if (e.payload.type === "leave") setDragOver(false);
        else if (e.payload.type === "drop") {
          setDragOver(false);
          if (e.payload.paths.length) openDropped(e.payload.paths[0]);
        }
      })
      .then((f) => {
        unlisten = f;
      });
    return () => unlisten?.();
  }, [openDropped]);

  // expand root + select it on first mount when a root was persisted
  useEffect(() => {
    if (rootPath && !selected) {
      setExpanded((s) => new Set(s).add(rootPath));
      setSelected({ path: rootPath, kind: "dir" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

  // -------------------------------------------------------------------------
  // Grid loading on selection
  // -------------------------------------------------------------------------

  const gridRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    if (!selected) {
      setNodeItems([]);
      return;
    }
    let cancelled = false;
    setGridLoading(true);
    setGridError(null);
    setSelectedIds(new Set());
    setCursorId(null);
    anchorRef.current = null;
    setViewerIndex(null);
    setQuery("");
    metaRef.current = {};
    loadedRef.current = new Set();
    brokenRef.current = new Set();
    if (gridRef.current) gridRef.current.scrollTop = 0;
    setScrollTop(0);

    (async () => {
      try {
        let items: Item[];
        if (selected.kind === "archive") {
          const entries = await listArchive(selected.path);
          if (cancelled) return;
          setArchiveCount((c) => ({ ...c, [selected.path]: entries.length }));
          items = entries.map((e) => ({
            id: itemIdOf(e.name, selected.path),
            name: e.name,
            path: e.name,
            archive: selected.path,
            fmt: fmtOf(e.name),
            size: e.size,
            mtime: e.mtime,
          }));
        } else {
          const entries = await ensureDir(selected.path);
          if (cancelled) return;
          items = entries
            .filter((e) => e.kind === "image")
            .map((e) => ({
              id: itemIdOf(e.path),
              name: e.name,
              path: e.path,
              fmt: fmtOf(e.name),
              size: e.size,
              mtime: e.mtime,
            }));
        }
        if (!cancelled) setNodeItems(items);
      } catch (err) {
        if (!cancelled) {
          setGridError(String(err));
          setNodeItems([]);
        }
      } finally {
        if (!cancelled) setGridLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // -------------------------------------------------------------------------
  // Filter + sort
  // -------------------------------------------------------------------------

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = nodeItems.filter((it) => {
      if (q && !it.name.toLowerCase().includes(q)) return false;
      const known = (KNOWN_FORMATS as readonly string[]).includes(it.fmt);
      return known ? activeFormats.has(it.fmt as KnownFormat) : true;
    });
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortKey) {
        case "name":
          return byName(a.name, b.name);
        case "format":
          return a.fmt.localeCompare(b.fmt) || byName(a.name, b.name);
        case "size":
          return b.size - a.size || byName(a.name, b.name);
        case "date":
          return b.mtime - a.mtime || byName(a.name, b.name);
      }
    });
    return sorted;
  }, [nodeItems, activeFormats, sortKey, query]);

  // the "active" item drives the preview and is the base for keyboard moves
  const selectedItem = useMemo(
    () => items.find((it) => it.id === cursorId) ?? null,
    [items, cursorId],
  );

  const selectedItems = useMemo(
    () => items.filter((it) => selectedIds.has(it.id)),
    [items, selectedIds],
  );

  // click selection with ctrl/cmd (toggle) and shift (range) modifiers
  const selectItem = useCallback(
    (id: string, mods: { ctrl: boolean; shift: boolean }) => {
      setCursorId(id);
      if (mods.shift && anchorRef.current) {
        const a = items.findIndex((it) => it.id === anchorRef.current);
        const b = items.findIndex((it) => it.id === id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setSelectedIds(new Set(items.slice(lo, hi + 1).map((it) => it.id)));
          return;
        }
      }
      if (mods.ctrl) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        anchorRef.current = id;
        return;
      }
      setSelectedIds(new Set([id]));
      anchorRef.current = id;
    },
    [items],
  );

  // -------------------------------------------------------------------------
  // Metadata fetching (lazy)
  // -------------------------------------------------------------------------

  const fetchMeta = useCallback((it: Item) => {
    if (it.id in metaRef.current) return;
    metaRef.current[it.id] = null; // mark in-flight to avoid duplicates
    imageMeta(it)
      .then((m) => {
        metaRef.current[it.id] = m;
      })
      .catch(() => {
        metaRef.current[it.id] = null;
      })
      .finally(() => setMetaTick((v) => v + 1));
  }, []);

  // preview metadata (resolution) for the active item; size/date come from the
  // listing, so sorting never needs to decode anything.
  useEffect(() => {
    if (selectedItem) fetchMeta(selectedItem);
  }, [selectedItem, fetchMeta]);

  // -------------------------------------------------------------------------
  // Virtualization
  // -------------------------------------------------------------------------

  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tile = TILE[thumbSize];
  const thumbW = THUMB_W[thumbSize];
  const cellH = tile + LABEL_H;
  const cols = Math.max(1, Math.floor((viewport.w - GAP) / (tile + GAP)));
  const rows = Math.ceil(items.length / cols);
  const totalH = rows * (cellH + GAP) + GAP;

  const firstRow = Math.max(0, Math.floor(scrollTop / (cellH + GAP)) - OVERSCAN_ROWS);
  const visibleRows = Math.ceil(viewport.h / (cellH + GAP)) + OVERSCAN_ROWS * 2;
  const firstIdx = firstRow * cols;
  const lastIdx = Math.min(items.length, (firstRow + visibleRows) * cols);
  const visible = items.slice(firstIdx, lastIdx);

  // -------------------------------------------------------------------------
  // Fullscreen viewer + keyboard nav
  // -------------------------------------------------------------------------

  const openViewer = useCallback(
    (id: string) => {
      const idx = items.findIndex((it) => it.id === id);
      if (idx >= 0) setViewerIndex(idx);
    },
    [items],
  );

  useEffect(() => {
    if (viewerIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewerIndex(null);
      else if (e.key === "ArrowRight")
        setViewerIndex((i) => (i === null ? i : Math.min(items.length - 1, i + 1)));
      else if (e.key === "ArrowLeft")
        setViewerIndex((i) => (i === null ? i : Math.max(0, i - 1)));
      else if (e.key === "Home") setViewerIndex(0);
      else if (e.key === "End") setViewerIndex(items.length - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerIndex, items.length]);

  // keep a grid index visible by nudging the scroll container
  const scrollIndexIntoView = useCallback(
    (index: number) => {
      const el = gridRef.current;
      if (!el) return;
      const top = GAP + Math.floor(index / cols) * (cellH + GAP);
      if (top < el.scrollTop) el.scrollTop = top - GAP;
      else if (top + cellH > el.scrollTop + el.clientHeight)
        el.scrollTop = top + cellH - el.clientHeight + GAP;
      setScrollTop(el.scrollTop);
    },
    [cols, cellH],
  );

  // grid keyboard navigation (active only when the fullscreen viewer is closed)
  useEffect(() => {
    if (viewerIndex !== null || items.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;

      const cur = cursorId ? items.findIndex((it) => it.id === cursorId) : -1;
      const pageRows = Math.max(1, Math.floor(viewport.h / (cellH + GAP)));
      const last = items.length - 1;
      const clamp = (n: number) => Math.max(0, Math.min(last, n));
      let next = cur;

      // Ctrl/Cmd+A selects everything
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        setSelectedIds(new Set(items.map((it) => it.id)));
        return;
      }

      switch (e.key) {
        case "ArrowRight":
          next = cur < 0 ? 0 : clamp(cur + 1);
          break;
        case "ArrowLeft":
          next = cur < 0 ? 0 : clamp(cur - 1);
          break;
        case "ArrowDown":
          next = cur < 0 ? 0 : clamp(cur + cols);
          break;
        case "ArrowUp":
          next = cur < 0 ? 0 : clamp(cur - cols);
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = last;
          break;
        case "PageDown":
          next = cur < 0 ? 0 : clamp(cur + pageRows * cols);
          break;
        case "PageUp":
          next = cur < 0 ? 0 : clamp(cur - pageRows * cols);
          break;
        case "Enter":
        case "f":
        case "F":
          if (cur >= 0) {
            e.preventDefault();
            openViewer(items[cur].id);
          }
          return;
        default:
          return;
      }
      e.preventDefault();
      // Shift+move extends the range from the anchor; a plain move resets it
      selectItem(items[next].id, { ctrl: false, shift: e.shiftKey });
      scrollIndexIntoView(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerIndex, items, cursorId, cols, cellH, viewport.h, openViewer, scrollIndexIntoView, selectItem]);

  // -------------------------------------------------------------------------
  // Tree interactions
  // -------------------------------------------------------------------------

  const toggleExpand = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          void ensureDir(path);
        }
        return next;
      });
    },
    [ensureDir],
  );

  const selectNode = useCallback((path: string, kind: NodeKind) => {
    setSelected({ path, kind });
  }, []);

  const toggleFormat = (f: KnownFormat) =>
    setActiveFormats((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  const crumbs = useMemo(
    () => (rootPath && selected ? breadcrumb(rootPath, selected.path, selected.kind) : []),
    [rootPath, selected],
  );

  // Explorer-style address bar: jump to any typed/pasted path. A folder or zip
  // inside the current root just selects (tree preserved); anything else re-roots.
  const navigateToPath = useCallback(
    (raw: string) => {
      const path = raw.trim().replace(/[\\/]+$/, "");
      if (!path) return;
      const isArchive = /\.(zip|cbz)$/i.test(path);
      const inRoot =
        rootPath && (path === rootPath || path.startsWith(rootPath + sepOf(rootPath)));
      if (inRoot) {
        if (!isArchive) setExpanded((s) => new Set(s).add(path));
        setSelected({ path, kind: isArchive ? "archive" : "dir" });
      } else if (isArchive) {
        openRoot(parentDir(path));
        setSelected({ path, kind: "archive" });
      } else {
        openRoot(path);
      }
    },
    [rootPath, openRoot],
  );

  const navigateUp = useCallback(() => {
    const here = selected?.path ?? rootPath;
    if (here) navigateToPath(parentDir(here));
  }, [selected, rootPath, navigateToPath]);

  const selectedNodeName = selected ? baseName(selected.path) : null;

  // =========================================================================
  // Render
  // =========================================================================

  // touch loadTick so the grid re-renders as thumbnails load / fail
  void loadTick;
  void metaTick;

  return (
    <div style={S.app}>
      {dragOver && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(10,12,16,0.62)",
            border: `2px dashed ${C.accent}`,
            display: "grid",
            placeItems: "center",
            pointerEvents: "none",
            color: C.text,
            fontFamily: MONO,
            fontSize: 16,
          }}
        >
          여기에 폴더 또는 zip을 놓아 열기
        </div>
      )}
      <TitleBar />

      <Toolbar
        crumbs={crumbs}
        onPickFolder={pickFolder}
        recent={recent}
        onPickRecent={openRoot}
        onCrumb={selectNode}
        onNavigatePath={navigateToPath}
        onUp={navigateUp}
        query={query}
        setQuery={setQuery}
        thumbSize={thumbSize}
        setThumbSize={setThumbSize}
        sortKey={sortKey}
        setSortKey={setSortKey}
        activeFormats={activeFormats}
        toggleFormat={toggleFormat}
        previewOpen={previewOpen}
        setPreviewOpen={setPreviewOpen}
        canConvert={items.length > 0}
        onOpenConvert={() => setConvertOpen(true)}
      />

      <div style={S.body}>
        {/* left: tree */}
        <aside style={S.tree}>
          <div style={S.paneHeader}>EXPLORER</div>
          <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
            {!rootPath ? (
              <div style={{ padding: 16, color: C.textFaint, fontSize: 12, lineHeight: 1.6 }}>
                폴더가 열려 있지 않습니다.
                <br />
                <button style={{ ...S.primaryBtn, marginTop: 10 }} onClick={pickFolder}>
                  폴더 열기
                </button>
              </div>
            ) : (
              <TreeRow
                path={rootPath}
                name={baseName(rootPath) || rootPath}
                kind="dir"
                depth={0}
                dirCache={dirCache}
                archiveCount={archiveCount}
                expanded={expanded}
                loadingNodes={loadingNodes}
                selectedPath={selected?.path ?? null}
                onToggle={toggleExpand}
                onSelect={selectNode}
              />
            )}
          </div>
        </aside>

        {/* center: virtualized grid */}
        <main
          ref={gridRef}
          style={S.grid}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        >
          {gridError ? (
            <div style={{ ...S.empty, color: C.danger }}>불러오기 실패: {gridError}</div>
          ) : gridLoading ? (
            <div style={S.empty}>불러오는 중…</div>
          ) : items.length === 0 ? (
            <div style={S.empty}>
              {!selected
                ? "폴더 또는 zip을 선택하세요."
                : query.trim()
                  ? `"${query.trim()}"에 해당하는 이미지가 없습니다.`
                  : "이 위치에 표시할 이미지가 없습니다."}
            </div>
          ) : (
            <div style={{ position: "relative", height: totalH, width: "100%" }}>
              {visible.map((it, k) => {
                const idx = firstIdx + k;
                const row = Math.floor(idx / cols);
                const col = idx % cols;
                return (
                  <Tile
                    key={it.id}
                    item={it}
                    tile={tile}
                    thumbW={thumbW}
                    left={GAP + col * (tile + GAP)}
                    top={GAP + row * (cellH + GAP)}
                    loaded={loadedRef.current.has(it.id)}
                    broken={brokenRef.current.has(it.id)}
                    selected={selectedIds.has(it.id)}
                    cursor={it.id === cursorId}
                    onSelect={(e) =>
                      selectItem(it.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
                    }
                    onOpen={() => openViewer(it.id)}
                    onLoaded={() => {
                      loadedRef.current.add(it.id);
                      bumpLoad();
                    }}
                    onBroken={() => {
                      brokenRef.current.add(it.id);
                      bumpLoad();
                    }}
                  />
                );
              })}
            </div>
          )}
        </main>

        {/* right: preview */}
        {previewOpen && (
          <PreviewPanel
            item={selectedItem}
            meta={selectedItem ? metaRef.current[selectedItem.id] ?? null : null}
            onOpenFull={() => selectedItem && openViewer(selectedItem.id)}
            onClose={() => setPreviewOpen(false)}
          />
        )}
      </div>

      <StatusBar
        count={items.length}
        selectedCount={selectedIds.size}
        nodeName={selectedNodeName}
        sortKey={sortKey}
        selectedName={selectedItem?.name ?? null}
        cols={cols}
        rows={rows}
      />

      {viewerIndex !== null && items[viewerIndex] && (
        <Viewer
          item={items[viewerIndex]}
          index={viewerIndex}
          total={items.length}
          crumbs={crumbs}
          neighbors={[items[viewerIndex - 1], items[viewerIndex + 1]].filter(Boolean)}
          onPrev={() => setViewerIndex((i) => (i === null ? i : Math.max(0, i - 1)))}
          onNext={() =>
            setViewerIndex((i) => (i === null ? i : Math.min(items.length - 1, i + 1)))
          }
          onClose={() => setViewerIndex(null)}
        />
      )}

      {convertOpen && (
        <ConvertDialog
          selected={selectedItems}
          all={items}
          onClose={() => setConvertOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Title bar
// ---------------------------------------------------------------------------

function TitleBar() {
  return (
    <div style={S.titleBar}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={S.logoDot} />
        <span style={{ fontWeight: 600, letterSpacing: 0.3 }}>glasspane</span>
        <span style={{ color: C.textFaint, fontSize: 12 }}>image viewer</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar (two rows)
// ---------------------------------------------------------------------------

interface ToolbarProps {
  crumbs: Crumb[];
  onPickFolder: () => void;
  recent: string[];
  onPickRecent: (path: string) => void;
  onCrumb: (path: string, kind: NodeKind) => void;
  onNavigatePath: (path: string) => void;
  onUp: () => void;
  query: string;
  setQuery: (s: string) => void;
  thumbSize: ThumbSizeKey;
  setThumbSize: (s: ThumbSizeKey) => void;
  sortKey: SortKey;
  setSortKey: (s: SortKey) => void;
  activeFormats: Set<KnownFormat>;
  toggleFormat: (f: KnownFormat) => void;
  previewOpen: boolean;
  setPreviewOpen: (b: boolean) => void;
  canConvert: boolean;
  onOpenConvert: () => void;
}

function Toolbar(p: ToolbarProps) {
  const [recentOpen, setRecentOpen] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [draft, setDraft] = useState("");
  const currentPath = p.crumbs.length ? p.crumbs[p.crumbs.length - 1].path : "";
  const beginEdit = () => {
    setDraft(currentPath);
    setEditingPath(true);
  };
  const commitEdit = () => {
    setEditingPath(false);
    if (draft.trim()) p.onNavigatePath(draft);
  };
  return (
    <div style={S.toolbarWrap}>
      <div style={S.toolbarRow}>
        <button style={S.primaryBtn} onClick={p.onPickFolder} title="폴더를 선택해 트리 루트로 엽니다">
          폴더 열기
        </button>
        <div style={{ position: "relative" }}>
          <button
            style={{ ...S.ghostBtn, opacity: p.recent.length ? 1 : 0.5 }}
            disabled={!p.recent.length}
            onClick={() => setRecentOpen((v) => !v)}
            title="최근 연 폴더"
          >
            최근 ▾
          </button>
          {recentOpen && p.recent.length > 0 && (
            <>
              <div style={S.dropdownScrim} onClick={() => setRecentOpen(false)} />
              <div style={S.dropdown}>
                {p.recent.map((path) => (
                  <button
                    key={path}
                    style={S.dropdownItem}
                    title={path}
                    onClick={() => {
                      setRecentOpen(false);
                      p.onPickRecent(path);
                    }}
                  >
                    <span style={{ marginRight: 6 }}>📁</span>
                    <span style={S.dropdownName}>{baseName(path) || path}</span>
                    <span style={S.dropdownPath}>{path}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button
          style={{ ...S.iconBtn, opacity: currentPath ? 1 : 0.4 }}
          disabled={!currentPath}
          onClick={p.onUp}
          title="상위 폴더 (한 단계 위로)"
        >
          ↑
        </button>
        {editingPath ? (
          <input
            style={S.pathInput}
            value={draft}
            autoFocus
            spellCheck={false}
            placeholder="경로 입력 후 Enter (폴더 또는 .zip/.cbz)"
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              else if (e.key === "Escape") setEditingPath(false);
            }}
            onBlur={() => setEditingPath(false)}
          />
        ) : (
          <div
            style={S.crumbs}
            title="클릭하면 경로를 직접 입력할 수 있습니다"
            onDoubleClick={beginEdit}
          >
            {p.crumbs.map((c, i) => (
              <span key={c.path} style={{ display: "inline-flex", alignItems: "center" }}>
                {i > 0 && <span style={{ color: C.textFaint, margin: "0 6px" }}>›</span>}
                <button
                  style={{ ...S.crumb, color: i === p.crumbs.length - 1 ? C.text : C.textDim }}
                  onClick={() => p.onCrumb(c.path, c.kind)}
                  title={c.path}
                >
                  {c.name}
                </button>
              </span>
            ))}
          </div>
        )}
        <button
          style={S.iconBtn}
          // keep the input focused (don't blur-cancel) when clicking to commit
          onMouseDown={(e) => e.preventDefault()}
          onClick={editingPath ? commitEdit : beginEdit}
          title="경로 직접 입력"
        >
          {editingPath ? "↵" : "✎"}
        </button>
        <div style={{ flex: 1 }} />
        <div style={S.searchWrap}>
          <span style={{ color: C.textFaint, fontSize: 12 }}>🔎</span>
          <input
            style={S.searchInput}
            value={p.query}
            placeholder="파일명 검색…"
            onChange={(e) => p.setQuery(e.currentTarget.value)}
          />
          {p.query && (
            <button style={S.searchClear} onClick={() => p.setQuery("")} title="지우기">
              ✕
            </button>
          )}
        </div>
        <button
          style={{ ...S.ghostBtn, color: p.previewOpen ? C.accent : C.textDim }}
          onClick={() => p.setPreviewOpen(!p.previewOpen)}
          title="미리보기 패널 토글"
        >
          {p.previewOpen ? "미리보기 ▣" : "미리보기 ▢"}
        </button>
      </div>

      <div style={{ ...S.toolbarRow, borderTop: `1px solid ${C.borderSoft}` }}>
        <span style={S.toolLabel}>크기</span>
        <div style={S.segment}>
          {(["S", "M", "L"] as ThumbSizeKey[]).map((s) => (
            <button
              key={s}
              style={{ ...S.segBtn, ...(p.thumbSize === s ? S.segBtnOn : null) }}
              onClick={() => p.setThumbSize(s)}
            >
              {s}
            </button>
          ))}
        </div>

        <span style={{ ...S.toolLabel, marginLeft: 16 }}>형식</span>
        <div style={{ display: "flex", gap: 6 }}>
          {KNOWN_FORMATS.map((f) => {
            const on = p.activeFormats.has(f);
            const highlight = f === "webp" || f === "avif";
            const hl = f === "webp" ? C.webp : C.avif;
            return (
              <button
                key={f}
                onClick={() => p.toggleFormat(f)}
                style={{
                  ...S.chip,
                  color: on ? (highlight ? hl : C.text) : C.textFaint,
                  borderColor: on ? (highlight ? hl : C.border) : C.borderSoft,
                  background: on ? C.panelAlt : "transparent",
                  opacity: on ? 1 : 0.55,
                }}
              >
                {f}
              </button>
            );
          })}
        </div>

        <span style={{ ...S.toolLabel, marginLeft: 16 }}>정렬</span>
        <div style={S.segment}>
          {(["name", "format", "size", "date"] as SortKey[]).map((s) => (
            <button
              key={s}
              style={{ ...S.segBtn, ...(p.sortKey === s ? S.segBtnOn : null) }}
              onClick={() => p.setSortKey(s)}
            >
              {s === "name" ? "이름" : s === "format" ? "형식" : s === "size" ? "크기" : "날짜"}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />
        <button
          style={{ ...S.ghostBtn, opacity: p.canConvert ? 1 : 0.5 }}
          disabled={!p.canConvert}
          onClick={p.onOpenConvert}
          title="이미지를 jpg/png/webp로 변환"
        >
          변환…
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree row (recursive, lazily loaded)
// ---------------------------------------------------------------------------

interface TreeRowProps {
  path: string;
  name: string;
  kind: NodeKind;
  depth: number;
  dirCache: Record<string, DirEntry[]>;
  archiveCount: Record<string, number>;
  expanded: Set<string>;
  loadingNodes: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string, kind: NodeKind) => void;
}

function TreeRow(props: TreeRowProps) {
  const { path, name, kind, depth, dirCache, archiveCount, expanded, loadingNodes } = props;
  const { selectedPath, onToggle, onSelect } = props;

  const isDir = kind === "dir";
  const isOpen = expanded.has(path);
  const isSel = selectedPath === path;
  const isLoading = loadingNodes.has(path);

  const children = isDir ? dirCache[path]?.filter((e) => e.kind !== "image") ?? null : null;
  const imageCount = isDir
    ? dirCache[path]?.filter((e) => e.kind === "image").length
    : archiveCount[path];

  const icon = kind === "archive" ? "🗜" : isOpen ? "📂" : "📁";

  return (
    <div>
      <div
        style={{
          ...S.treeRow,
          paddingLeft: 8 + depth * 14,
          background: isSel ? C.accentSoft : "transparent",
          color: isSel ? C.text : C.textDim,
        }}
        onClick={() => onSelect(path, kind)}
        onDoubleClick={() => isDir && onToggle(path)}
        title={path}
      >
        <span
          style={{ width: 14, display: "inline-block", color: C.textFaint, cursor: "pointer" }}
          onClick={(e) => {
            e.stopPropagation();
            if (isDir) onToggle(path);
          }}
        >
          {isDir ? (isOpen ? "▾" : "▸") : ""}
        </span>
        <span style={{ marginRight: 6 }}>{icon}</span>
        <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {name}
        </span>
        {isLoading ? (
          <span style={S.treeCount}>…</span>
        ) : (
          imageCount !== undefined && imageCount > 0 && <span style={S.treeCount}>{imageCount}</span>
        )}
      </div>

      {isDir && isOpen && children && (
        <div>
          {children.length === 0 ? (
            <div style={{ ...S.treeEmpty, paddingLeft: 8 + (depth + 1) * 14 }}>비어 있음</div>
          ) : (
            children.map((c) => (
              <TreeRow
                key={c.path}
                path={c.path}
                name={c.name}
                kind={c.kind === "archive" ? "archive" : "dir"}
                depth={depth + 1}
                dirCache={dirCache}
                archiveCount={archiveCount}
                expanded={expanded}
                loadingNodes={loadingNodes}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid tile (real thumbnail via imgsrv)
// ---------------------------------------------------------------------------

interface TileProps {
  item: Item;
  tile: number;
  thumbW: number;
  left: number;
  top: number;
  loaded: boolean;
  broken: boolean;
  selected: boolean;
  cursor: boolean;
  onSelect: (e: ReactMouseEvent) => void;
  onOpen: () => void;
  onLoaded: () => void;
  onBroken: () => void;
}

function Tile(p: TileProps) {
  const { item, tile, thumbW, left, top, loaded, broken, selected, cursor } = p;
  return (
    <div
      style={{ position: "absolute", left, top, width: tile, height: tile + LABEL_H }}
      onClick={p.onSelect}
      onDoubleClick={p.onOpen}
    >
      <div
        style={{
          position: "relative",
          width: tile,
          height: tile,
          borderRadius: 8,
          overflow: "hidden",
          background: C.skeleton,
          outline: selected ? `2px solid ${C.ring}` : `1px solid ${C.border}`,
          outlineOffset: selected ? 0 : -1,
          boxShadow: cursor
            ? `0 0 0 4px ${C.accentSoft}`
            : selected
              ? `0 0 0 2px ${C.accentSoft}`
              : "none",
        }}
      >
        {broken ? (
          <div style={S.brokenTile} title="이미지를 불러올 수 없습니다">
            ⊘
          </div>
        ) : (
          <img
            src={thumbUrl(item, thumbW)}
            loading="lazy"
            decoding="async"
            onLoad={p.onLoaded}
            onError={p.onBroken}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: loaded ? 1 : 0,
              transition: "opacity .28s ease",
            }}
          />
        )}
        {!loaded && !broken && (
          <div style={S.skelDots}>…</div>
        )}
        <FormatBadge fmt={item.fmt} />
      </div>
      <div
        style={{
          height: LABEL_H,
          display: "flex",
          alignItems: "center",
          fontFamily: MONO,
          fontSize: 11,
          color: selected ? C.text : C.textDim,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          paddingTop: 4,
        }}
        title={item.name}
      >
        {item.name}
      </div>
    </div>
  );
}

function FormatBadge({ fmt }: { fmt: string }) {
  const hl = fmt === "webp" ? C.webp : fmt === "avif" ? C.avif : null;
  return (
    <span
      style={{
        position: "absolute",
        top: 6,
        left: 6,
        fontFamily: MONO,
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        padding: "2px 5px",
        borderRadius: 4,
        color: hl ?? C.textDim,
        background: hl ? "rgba(0,0,0,0.55)" : C.badge,
        border: hl ? `1px solid ${hl}` : `1px solid ${C.border}`,
      }}
    >
      {fmt || "?"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Preview panel
// ---------------------------------------------------------------------------

interface PreviewProps {
  item: Item | null;
  meta: ImageMeta | null;
  onOpenFull: () => void;
  onClose: () => void;
}

function PreviewPanel({ item, meta, onOpenFull, onClose }: PreviewProps) {
  const [copied, setCopied] = useState(false);
  const onCopyPath = async () => {
    if (!item) return;
    if (await copyText(itemPath(item))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  const onReveal = () => {
    if (item) revealInExplorer(item).catch(() => {});
  };
  return (
    <aside style={S.preview}>
      <div style={{ ...S.paneHeader, display: "flex", alignItems: "center" }}>
        <span style={{ flex: 1 }}>PREVIEW</span>
        <button style={S.iconBtn} onClick={onClose} title="패널 닫기">
          ✕
        </button>
      </div>

      {!item ? (
        <div style={{ ...S.empty, padding: 24 }}>이미지를 선택하면 미리보기가 표시됩니다.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <div
            style={{
              margin: 12,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: C.skeleton,
              flex: "0 0 auto",
              maxHeight: "46%",
              display: "grid",
              placeItems: "center",
              overflow: "hidden",
            }}
          >
            <img
              src={thumbUrl(item, PREVIEW_W)}
              alt={item.name}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
            />
          </div>
          <div style={{ padding: "0 14px", overflow: "auto", flex: 1 }}>
            <Meta label="이름" value={item.name} mono />
            <Meta label="형식" value={item.fmt.toUpperCase()} />
            <Meta label="해상도" value={meta ? `${meta.width} × ${meta.height}` : "…"} mono />
            <Meta label="크기" value={item.size ? fmtBytes(item.size) : meta ? fmtBytes(meta.size) : "…"} mono />
            <Meta label="경로" value={itemPath(item)} mono dim />
          </div>
          <div
            style={{
              padding: 12,
              borderTop: `1px solid ${C.borderSoft}`,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ ...S.ghostBtn, flex: 1 }} onClick={onCopyPath} title="이미지 경로 복사">
                {copied ? "복사됨!" : "경로 복사"}
              </button>
              <button
                style={{ ...S.ghostBtn, flex: 1 }}
                onClick={onReveal}
                title="파일 탐색기에서 보기"
              >
                탐색기에서 보기
              </button>
            </div>
            <button style={{ ...S.primaryBtn, width: "100%" }} onClick={onOpenFull}>
              전체화면 열기
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function Meta({
  label,
  value,
  mono,
  dim,
}: {
  label: string;
  value: string;
  mono?: boolean;
  dim?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        padding: "7px 0",
        borderBottom: `1px solid ${C.borderSoft}`,
        fontSize: 12,
      }}
    >
      <span style={{ width: 64, color: C.textFaint, flexShrink: 0 }}>{label}</span>
      <span
        style={{
          flex: 1,
          color: dim ? C.textDim : C.text,
          fontFamily: mono ? MONO : "inherit",
          wordBreak: "break-all",
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

interface StatusProps {
  count: number;
  selectedCount: number;
  nodeName: string | null;
  sortKey: SortKey;
  selectedName: string | null;
  cols: number;
  rows: number;
}

function StatusBar({ count, selectedCount, nodeName, sortKey, selectedName, cols, rows }: StatusProps) {
  const sortLabel =
    sortKey === "name" ? "이름" : sortKey === "format" ? "형식" : sortKey === "size" ? "크기" : "날짜";
  return (
    <div style={S.statusBar}>
      <Stat>{count.toLocaleString()} 이미지</Stat>
      <Sep />
      <Stat>{nodeName ?? "—"}</Stat>
      <Sep />
      <Stat>정렬: {sortLabel}</Stat>
      <div style={{ flex: 1 }} />
      {selectedCount > 1 && (
        <>
          <Stat mono>{selectedCount}개 선택</Stat>
          <Sep />
        </>
      )}
      {selectedCount <= 1 && selectedName && (
        <>
          <Stat mono>{selectedName}</Stat>
          <Sep />
        </>
      )}
      <Stat mono>
        {cols} × {rows}
      </Stat>
    </div>
  );
}

function Stat({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return <span style={{ color: C.textDim, fontFamily: mono ? MONO : "inherit" }}>{children}</span>;
}
function Sep() {
  return <span style={{ color: C.textFaint, margin: "0 10px" }}>•</span>;
}

// ---------------------------------------------------------------------------
// Fullscreen viewer
// ---------------------------------------------------------------------------

interface ViewerProps {
  item: Item;
  index: number;
  total: number;
  crumbs: Crumb[];
  neighbors: Item[];
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

type FitMode = "fit" | "width" | "actual";
const FIT_KEY = "glasspane.fitMode";
const FIT_LABEL: Record<FitMode, string> = { fit: "화면", width: "너비", actual: "실제" };

function fitStyle(mode: FitMode): CSSProperties {
  switch (mode) {
    case "width":
      return { width: "96vw", maxWidth: "none", height: "auto", maxHeight: "none" };
    case "actual":
      return { width: "auto", height: "auto", maxWidth: "none", maxHeight: "none" };
    default:
      return { maxWidth: "86vw", maxHeight: "82vh", width: "auto", height: "auto" };
  }
}

function Viewer({ item, index, total, crumbs, neighbors, onPrev, onNext, onClose }: ViewerProps) {
  const pathLabel = crumbs.map((c) => c.name).join(" › ");
  const backdropRef = useRef<HTMLDivElement | null>(null);

  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [fitMode, setFitMode] = useState<FitMode>(
    () => (localStorage.getItem(FIT_KEY) as FitMode) || "fit",
  );
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const movedRef = useRef(false);
  // latest nav callbacks + a throttle so a trackpad flick doesn't skip pages
  const navRef = useRef({ onPrev, onNext });
  navRef.current = { onPrev, onNext };
  const wheelLockRef = useRef(0);

  // reset zoom/pan/load-state whenever the displayed image changes
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setLoading(true);
    setErrored(false);
  }, [item.id]);

  // remember the fit mode across pages/sessions
  useEffect(() => {
    localStorage.setItem(FIT_KEY, fitMode);
  }, [fitMode]);

  // preload the adjacent full images so wheel-paging is instant
  useEffect(() => {
    const imgs = neighbors.map((n) => {
      const img = new Image();
      img.src = fullUrl(n);
      return img;
    });
    return () => imgs.forEach((img) => (img.src = ""));
  }, [neighbors]);

  const applyZoom = useCallback((next: number) => {
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    setZoom(z);
    if (z === 1) setOffset({ x: 0, y: 0 });
  }, []);

  // Wheel: pages prev/next (Honeyview-style); Ctrl/⌘+wheel zooms.
  // Native non-passive listener so we can preventDefault.
  useEffect(() => {
    const el = backdropRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        setZoom((prev) => {
          const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev * (e.deltaY < 0 ? 1.15 : 0.87)));
          if (z === 1) setOffset({ x: 0, y: 0 });
          return z;
        });
        return;
      }
      if (Math.abs(e.deltaY) < 2) return;
      const now = Date.now();
      if (now - wheelLockRef.current < 120) return; // throttle rapid wheel events
      wheelLockRef.current = now;
      if (e.deltaY > 0) navRef.current.onNext();
      else navRef.current.onPrev();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // +/-/0 zoom keys (arrows/Esc/Home/End are handled by the grid-level handler)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "+" || e.key === "=") applyZoom(zoom + 0.25);
      else if (e.key === "-" || e.key === "_") applyZoom(zoom - 0.25);
      else if (e.key === "0") applyZoom(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, applyZoom]);

  // pannable when zoomed in, or in a fit mode that can overflow the viewport
  const pannable = zoom > 1 || fitMode !== "fit";
  const onMouseDown = (e: ReactMouseEvent) => {
    if (!pannable) return;
    e.preventDefault();
    movedRef.current = false;
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onMouseMove = (e: ReactMouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    movedRef.current = true;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <div
      ref={backdropRef}
      style={S.viewerBackdrop}
      onClick={() => {
        if (!movedRef.current) onClose();
      }}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      {loading && !errored && (
        <div style={S.viewerSpinner} onClick={(e) => e.stopPropagation()}>
          <div style={S.spinner} />
        </div>
      )}
      {errored ? (
        <div style={S.viewerBroken} onClick={(e) => e.stopPropagation()}>
          <div style={{ fontSize: 40, opacity: 0.5 }}>🖼️</div>
          <div style={{ fontFamily: MONO, color: C.textDim, marginTop: 8 }}>
            이미지를 불러올 수 없습니다
          </div>
        </div>
      ) : (
        <img
          src={fullUrl(item)}
          alt={item.name}
          draggable={false}
          onLoad={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setErrored(true);
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            e.stopPropagation();
            applyZoom(zoom > 1 ? 1 : 2);
          }}
          onMouseDown={onMouseDown}
          style={{
            ...fitStyle(fitMode),
            objectFit: "contain",
            borderRadius: 8,
            boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
            opacity: loading ? 0 : 1,
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transition: dragRef.current ? "none" : "transform .12s ease-out, opacity .15s ease",
            cursor: pannable ? (dragRef.current ? "grabbing" : "grab") : "default",
          }}
        />
      )}

      <div style={S.viewerInfo} onClick={(e) => e.stopPropagation()}>
        <span style={{ fontFamily: MONO, color: C.textDim }}>
          {pathLabel} › <span style={{ color: C.text }}>{item.name}</span>
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO, color: C.textDim }}>
          {index + 1} / {total}
        </span>
        <Sep />
        <div style={S.segment}>
          {(["fit", "width", "actual"] as FitMode[]).map((m) => (
            <button
              key={m}
              style={{ ...S.segBtn, ...(fitMode === m ? S.segBtnOn : null) }}
              onClick={(e) => {
                e.stopPropagation();
                setFitMode(m);
              }}
              title={`맞춤: ${FIT_LABEL[m]}`}
            >
              {FIT_LABEL[m]}
            </button>
          ))}
        </div>
        <button
          style={{ ...S.iconBtn, fontFamily: MONO, marginLeft: 8 }}
          onClick={(e) => {
            e.stopPropagation();
            applyZoom(1);
          }}
          title="줌 초기화 (0)"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button style={{ ...S.iconBtn, marginLeft: 12 }} onClick={onClose} title="닫기 (Esc)">
          ✕
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Batch convert dialog
// ---------------------------------------------------------------------------

interface ConvertDialogProps {
  selected: Item[];
  all: Item[];
  onClose: () => void;
}

function ConvertDialog({ selected, all, onClose }: ConvertDialogProps) {
  const [scope, setScope] = useState<"selected" | "all">(selected.length ? "selected" : "all");
  const [format, setFormat] = useState<ConvertFormat>("jpg");
  const [quality, setQuality] = useState(90);
  const [overwrite, setOverwrite] = useState(false);
  const [destDir, setDestDir] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<ConvertReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sources = scope === "selected" ? selected : all;

  const pickDest = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setDestDir(picked);
  };

  const run = async () => {
    if (!destDir || running) return;
    setRunning(true);
    setError(null);
    setReport(null);
    setProgress({ done: 0, total: sources.length });
    try {
      const r = await convertImages(
        sources,
        {
          format,
          destDir,
          quality: format === "jpg" ? quality : undefined,
          overwrite,
        },
        (p) => setProgress({ done: p.done, total: p.total }),
      );
      setReport(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={S.viewerBackdrop} onClick={running ? undefined : onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <span style={{ flex: 1, fontWeight: 600 }}>이미지 변환</span>
          <button style={S.iconBtn} onClick={onClose} disabled={running} title="닫기">
            ✕
          </button>
        </div>

        <div style={{ padding: 16, overflow: "auto" }}>
          {/* scope */}
          <div style={S.field}>
            <span style={S.fieldLabel}>대상</span>
            <div style={S.segment}>
              <button
                style={{
                  ...S.segBtn,
                  ...(scope === "selected" ? S.segBtnOn : null),
                  opacity: selected.length ? 1 : 0.5,
                }}
                disabled={!selected.length}
                onClick={() => setScope("selected")}
              >
                선택 이미지 {selected.length}개
              </button>
              <button
                style={{ ...S.segBtn, ...(scope === "all" ? S.segBtnOn : null) }}
                onClick={() => setScope("all")}
              >
                현재 목록 전체 {all.length}개
              </button>
            </div>
          </div>

          {/* format */}
          <div style={S.field}>
            <span style={S.fieldLabel}>형식</span>
            <div style={S.segment}>
              {(["jpg", "png", "webp"] as ConvertFormat[]).map((f) => (
                <button
                  key={f}
                  style={{ ...S.segBtn, ...(format === f ? S.segBtnOn : null) }}
                  onClick={() => setFormat(f)}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* quality (jpg only) */}
          <div style={{ ...S.field, opacity: format === "jpg" ? 1 : 0.4 }}>
            <span style={S.fieldLabel}>품질</span>
            <input
              type="range"
              min={1}
              max={100}
              value={quality}
              disabled={format !== "jpg"}
              onChange={(e) => setQuality(Number(e.currentTarget.value))}
              style={{ flex: 1 }}
            />
            <span style={{ fontFamily: MONO, width: 32, textAlign: "right" }}>{quality}</span>
          </div>
          {format !== "jpg" && (
            <div style={{ ...S.hint, marginTop: -4 }}>PNG/WebP는 무손실로 저장됩니다.</div>
          )}

          {/* destination */}
          <div style={S.field}>
            <span style={S.fieldLabel}>저장 위치</span>
            <button style={S.ghostBtn} onClick={pickDest} disabled={running}>
              폴더 선택…
            </button>
            <span style={{ ...S.dropdownPath, flex: 1 }} title={destDir}>
              {destDir || "선택되지 않음"}
            </span>
          </div>

          {/* overwrite */}
          <label style={{ ...S.field, cursor: "pointer" }}>
            <span style={S.fieldLabel}>덮어쓰기</span>
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.currentTarget.checked)}
            />
            <span style={S.hint}>끄면 같은 이름은 _1, _2…로 저장</span>
          </label>

          {/* result */}
          {error && <div style={{ ...S.hint, color: C.danger }}>오류: {error}</div>}
          {report && (
            <div style={S.reportBox}>
              <div style={{ color: C.webp }}>성공 {report.ok}개</div>
              {report.failed.length > 0 && (
                <div style={{ color: C.danger, marginTop: 4 }}>
                  실패 {report.failed.length}개
                  <div style={{ maxHeight: 120, overflow: "auto", marginTop: 4 }}>
                    {report.failed.map((f) => (
                      <div key={f.name} style={{ fontFamily: MONO, fontSize: 11 }}>
                        {baseName(f.name)}: {f.error}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={S.modalFooter}>
          <button style={S.ghostBtn} onClick={onClose} disabled={running}>
            {report ? "닫기" : "취소"}
          </button>
          <button
            style={{ ...S.primaryBtn, opacity: !destDir || running ? 0.5 : 1 }}
            onClick={run}
            disabled={!destDir || running}
          >
            {running
              ? `변환 중… ${progress ? `${progress.done}/${progress.total}` : ""}`
              : `변환 시작 (${sources.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const S: Record<string, CSSProperties> = {
  app: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    width: "100vw",
    background: C.bg,
    color: C.text,
    fontSize: 13,
    overflow: "hidden",
  },
  titleBar: {
    height: 38,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    padding: "0 12px",
    background: C.panel,
    borderBottom: `1px solid ${C.border}`,
  },
  logoDot: {
    width: 12,
    height: 12,
    borderRadius: 3,
    background: `linear-gradient(135deg, ${C.accent}, ${C.avif})`,
  },
  toolbarWrap: { flexShrink: 0, background: C.panel, borderBottom: `1px solid ${C.border}` },
  toolbarRow: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", minHeight: 44 },
  crumbs: { display: "flex", alignItems: "center", marginLeft: 6, overflow: "hidden", cursor: "text" },
  pathInput: {
    flex: 1,
    minWidth: 120,
    marginLeft: 6,
    background: C.panelAlt,
    border: `1px solid ${C.accent}`,
    borderRadius: 6,
    outline: "none",
    color: C.text,
    fontFamily: MONO,
    fontSize: 12,
    padding: "5px 8px",
  } as CSSProperties,
  crumb: {
    background: "none",
    border: "none",
    padding: "2px 4px",
    fontFamily: MONO,
    fontSize: 12,
    cursor: "pointer",
  },
  toolLabel: { color: C.textFaint, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  segment: { display: "flex", border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden" },
  segBtn: {
    background: C.panelAlt,
    border: "none",
    color: C.textDim,
    padding: "5px 11px",
    fontSize: 12,
    cursor: "pointer",
  },
  segBtnOn: { background: C.accentSoft, color: C.text },
  chip: {
    border: `1px solid ${C.border}`,
    borderRadius: 14,
    padding: "4px 11px",
    fontFamily: MONO,
    fontSize: 11,
    cursor: "pointer",
  },
  primaryBtn: {
    background: C.accent,
    border: "none",
    color: "#06121f",
    fontWeight: 600,
    padding: "7px 14px",
    borderRadius: 6,
    cursor: "pointer",
  },
  ghostBtn: {
    background: "transparent",
    border: `1px solid ${C.border}`,
    padding: "6px 12px",
    borderRadius: 6,
    cursor: "pointer",
    color: C.textDim,
  },
  dropdownScrim: { position: "fixed", inset: 0, zIndex: 40 },
  dropdown: {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    minWidth: 280,
    maxWidth: 460,
    background: C.panelAlt,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
    padding: 4,
    zIndex: 50,
  },
  dropdownItem: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    background: "transparent",
    border: "none",
    color: C.text,
    padding: "7px 8px",
    borderRadius: 6,
    cursor: "pointer",
    textAlign: "left",
    fontSize: 12,
  },
  dropdownName: { fontWeight: 500, marginRight: 8, flexShrink: 0 },
  dropdownPath: {
    color: C.textFaint,
    fontFamily: MONO,
    fontSize: 11,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  searchWrap: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: C.panelAlt,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: "4px 8px",
    width: 200,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    background: "transparent",
    border: "none",
    outline: "none",
    color: C.text,
    fontFamily: MONO,
    fontSize: 12,
  },
  searchClear: {
    background: "transparent",
    border: "none",
    color: C.textFaint,
    cursor: "pointer",
    padding: 0,
    fontSize: 11,
  },
  iconBtn: {
    background: "transparent",
    border: "none",
    color: C.textDim,
    cursor: "pointer",
    fontSize: 13,
    padding: 4,
  },
  body: { display: "flex", flex: 1, minHeight: 0 },
  tree: {
    width: 256,
    flexShrink: 0,
    background: C.panel,
    borderRight: `1px solid ${C.border}`,
    display: "flex",
    flexDirection: "column",
  },
  paneHeader: {
    height: 30,
    display: "flex",
    alignItems: "center",
    padding: "0 12px",
    fontSize: 10,
    letterSpacing: 1,
    color: C.textFaint,
    background: C.panelAlt,
    borderBottom: `1px solid ${C.borderSoft}`,
  },
  treeRow: {
    display: "flex",
    alignItems: "center",
    height: 26,
    paddingRight: 10,
    cursor: "pointer",
    fontSize: 13,
    userSelect: "none",
  },
  treeCount: { fontFamily: MONO, fontSize: 10, color: C.textFaint, marginLeft: 6 },
  treeEmpty: { fontSize: 11, color: C.textFaint, height: 22, display: "flex", alignItems: "center" },
  grid: { flex: 1, minWidth: 0, overflow: "auto", background: C.bg },
  empty: { height: "100%", display: "grid", placeItems: "center", color: C.textFaint, fontSize: 13 },
  brokenTile: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    color: C.danger,
    fontSize: 28,
    background: C.skeleton,
  },
  skelDots: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    color: C.textFaint,
    fontFamily: MONO,
    fontSize: 11,
    pointerEvents: "none",
  },
  preview: {
    width: 320,
    flexShrink: 0,
    background: C.panel,
    borderLeft: `1px solid ${C.border}`,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  statusBar: {
    height: 26,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    padding: "0 12px",
    background: C.panel,
    borderTop: `1px solid ${C.border}`,
    fontSize: 11,
  },
  viewerBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(6,8,11,0.92)",
    display: "grid",
    placeItems: "center",
    zIndex: 100,
    overflow: "hidden",
  },
  viewerSpinner: {
    position: "fixed",
    inset: 0,
    display: "grid",
    placeItems: "center",
    pointerEvents: "none",
  },
  spinner: {
    width: 38,
    height: 38,
    borderRadius: "50%",
    border: `3px solid ${C.border}`,
    borderTopColor: C.accent,
    animation: "glasspane-spin 0.8s linear infinite",
  },
  viewerBroken: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  },
  navBtn: {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    width: 48,
    height: 64,
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: "rgba(19,22,27,0.8)",
    color: C.text,
    fontSize: 28,
    cursor: "pointer",
  },
  viewerInfo: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    height: 44,
    display: "flex",
    alignItems: "center",
    padding: "0 16px",
    background: C.panel,
    borderTop: `1px solid ${C.border}`,
    fontSize: 12,
  },
  modal: {
    width: "min(92vw, 520px)",
    maxHeight: "86vh",
    display: "flex",
    flexDirection: "column",
    background: C.panel,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
    overflow: "hidden",
  },
  modalHeader: {
    display: "flex",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: `1px solid ${C.borderSoft}`,
    fontSize: 14,
  },
  modalFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: 12,
    borderTop: `1px solid ${C.borderSoft}`,
  },
  field: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14, minHeight: 28 },
  fieldLabel: { width: 70, flexShrink: 0, color: C.textDim, fontSize: 12 },
  hint: { color: C.textFaint, fontSize: 11, marginBottom: 14 },
  reportBox: {
    marginTop: 6,
    padding: 10,
    background: C.panelAlt,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    fontSize: 12,
  },
};
