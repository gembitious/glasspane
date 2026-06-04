// glasspane — UX prototype (MOCK data).
//
// This is the visual target described in CLAUDE.md §8: a 3-pane explorer-style
// image viewer with a folder/zip tree, a manually virtualized thumbnail grid,
// a collapsible preview panel, and a fullscreen viewer. Everything here runs on
// mock data and a *simulated* async thumbnail load. Phase v3 (§9) swaps the
// mock data for real backend calls via src/lib/viewerApi.ts — the layout and
// interactions stay the same.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
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
};

const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace';

// ---------------------------------------------------------------------------
// Mock model
// ---------------------------------------------------------------------------

type Fmt = "webp" | "avif" | "jpg" | "png" | "gif";
type NodeKind = "dir" | "archive";

interface TreeNode {
  id: string;
  name: string;
  kind: NodeKind;
  count: number;
  children?: TreeNode[];
}

interface GridItem {
  id: string;
  name: string;
  fmt: Fmt;
  size: number; // bytes
  w: number;
  h: number;
}

type SortKey = "name" | "format" | "size";
type ThumbSizeKey = "S" | "M" | "L";

const TILE: Record<ThumbSizeKey, number> = { S: 120, M: 168, L: 232 };
const GAP = 12;
const LABEL_H = 34;
const OVERSCAN_ROWS = 3;

const ALL_FORMATS: Fmt[] = ["webp", "avif", "jpg", "png", "gif"];

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const TREE: TreeNode[] = [
  {
    id: "root",
    name: "D:\\images",
    kind: "dir",
    count: 0,
    children: [
      { id: "wallpapers", name: "wallpapers", kind: "dir", count: 248 },
      {
        id: "photos",
        name: "photos",
        kind: "dir",
        count: 0,
        children: [
          { id: "photos-2024", name: "2024", kind: "dir", count: 1320 },
          { id: "photos-2025", name: "2025", kind: "dir", count: 642 },
        ],
      },
      { id: "manga.cbz", name: "one-shot.cbz", kind: "archive", count: 38 },
      { id: "screens.zip", name: "screenshots.zip", kind: "archive", count: 510 },
      { id: "renders", name: "renders", kind: "dir", count: 87 },
    ],
  },
];

const FORMAT_POOL: Fmt[] = ["webp", "avif", "webp", "jpg", "png", "webp", "avif", "gif"];

// deterministic pseudo-random from a string seed
function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mockItems(node: TreeNode | null): GridItem[] {
  if (!node || node.count <= 0) return [];
  const items: GridItem[] = [];
  const base = seedFrom(node.id);
  for (let i = 0; i < node.count; i++) {
    const r = seedFrom(`${node.id}:${i}`);
    const fmt = FORMAT_POOL[(base + i) % FORMAT_POOL.length];
    const w = 640 + (r % 7) * 160;
    const h = 480 + ((r >> 3) % 6) * 200;
    const size = 80_000 + (r % 4_000_000);
    const name = `${node.kind === "archive" ? "page" : "img"}_${String(i + 1).padStart(4, "0")}.${fmt}`;
    items.push({ id: `${node.id}:${i}`, name, fmt, size, w, h });
  }
  return items;
}

// a stable color pair per item, used to fake the decoded thumbnail
function tileColors(id: string): [string, string] {
  const r = seedFrom(id);
  const hue = r % 360;
  const hue2 = (hue + 40 + (r % 60)) % 360;
  return [`hsl(${hue} 45% 32%)`, `hsl(${hue2} 50% 22%)`];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

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

function findPath(nodes: TreeNode[], id: string, trail: TreeNode[] = []): TreeNode[] | null {
  for (const n of nodes) {
    const next = [...trail, n];
    if (n.id === id) return next;
    if (n.children) {
      const found = findPath(n.children, id, next);
      if (found) return found;
    }
  }
  return null;
}

// ===========================================================================
// App
// ===========================================================================

export default function App() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["root", "photos"]));
  const [selectedNodeId, setSelectedNodeId] = useState<string>("wallpapers");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [thumbSize, setThumbSize] = useState<ThumbSizeKey>("M");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [activeFormats, setActiveFormats] = useState<Set<Fmt>>(new Set(ALL_FORMATS));
  const [previewOpen, setPreviewOpen] = useState(true);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const selectedNode = useMemo(() => {
    const p = findPath(TREE, selectedNodeId);
    return p ? p[p.length - 1] : null;
  }, [selectedNodeId]);

  const nodePath = useMemo(() => findPath(TREE, selectedNodeId) ?? [], [selectedNodeId]);

  // raw mock items for the selected node
  const rawItems = useMemo(() => mockItems(selectedNode), [selectedNode]);

  // filter + sort
  const items = useMemo(() => {
    const filtered = rawItems.filter((it) => activeFormats.has(it.fmt));
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortKey) {
        case "name":
          return a.name.localeCompare(b.name);
        case "format":
          return a.fmt.localeCompare(b.fmt) || a.name.localeCompare(b.name);
        case "size":
          return b.size - a.size;
      }
    });
    return sorted;
  }, [rawItems, activeFormats, sortKey]);

  // ----- virtualization state -----
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  // reset selection + scroll when the node changes
  useEffect(() => {
    setSelectedItemId(null);
    setViewerIndex(null);
    if (gridRef.current) gridRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [selectedNodeId]);

  const selectedItem = useMemo(
    () => items.find((it) => it.id === selectedItemId) ?? null,
    [items, selectedItemId],
  );

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
  const cellH = tile + LABEL_H;
  const cols = Math.max(1, Math.floor((viewport.w - GAP) / (tile + GAP)));
  const rows = Math.ceil(items.length / cols);
  const totalH = rows * (cellH + GAP) + GAP;

  const firstRow = Math.max(0, Math.floor(scrollTop / (cellH + GAP)) - OVERSCAN_ROWS);
  const visibleRows = Math.ceil(viewport.h / (cellH + GAP)) + OVERSCAN_ROWS * 2;
  const firstIdx = firstRow * cols;
  const lastIdx = Math.min(items.length, (firstRow + visibleRows) * cols);
  const visible = items.slice(firstIdx, lastIdx);

  // ----- simulated thumbnail load (replaced by real <img> onLoad in v3) -----
  const loadedRef = useRef<Set<string>>(new Set());
  const [, setLoadTick] = useState(0);
  useEffect(() => {
    const timers: number[] = [];
    for (const it of visible) {
      if (loadedRef.current.has(it.id)) continue;
      const delay = 120 + (seedFrom(it.id) % 520);
      const t = window.setTimeout(() => {
        loadedRef.current.add(it.id);
        setLoadTick((v) => v + 1);
      }, delay);
      timers.push(t);
    }
    return () => timers.forEach((t) => clearTimeout(t));
    // re-run as the visible window shifts
  }, [firstIdx, lastIdx, items]);

  // ----- fullscreen viewer -----
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

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleFormat = (f: Fmt) =>
    setActiveFormats((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  // =========================================================================
  // Render
  // =========================================================================

  return (
    <div style={S.app}>
      <TitleBar />

      <Toolbar
        nodePath={nodePath}
        onCrumb={setSelectedNodeId}
        thumbSize={thumbSize}
        setThumbSize={setThumbSize}
        sortKey={sortKey}
        setSortKey={setSortKey}
        activeFormats={activeFormats}
        toggleFormat={toggleFormat}
        previewOpen={previewOpen}
        setPreviewOpen={setPreviewOpen}
      />

      <div style={S.body}>
        {/* left: tree */}
        <aside style={S.tree}>
          <div style={S.paneHeader}>EXPLORER</div>
          <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
            {TREE.map((n) => (
              <TreeRow
                key={n.id}
                node={n}
                depth={0}
                expanded={expanded}
                toggleExpand={toggleExpand}
                selectedNodeId={selectedNodeId}
                onSelect={setSelectedNodeId}
              />
            ))}
          </div>
        </aside>

        {/* center: virtualized grid */}
        <main
          ref={gridRef}
          style={S.grid}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        >
          {items.length === 0 ? (
            <div style={S.empty}>이 위치에 표시할 이미지가 없습니다.</div>
          ) : (
            <div style={{ position: "relative", height: totalH, width: "100%" }}>
              {visible.map((it, k) => {
                const idx = firstIdx + k;
                const row = Math.floor(idx / cols);
                const col = idx % cols;
                const left = GAP + col * (tile + GAP);
                const top = GAP + row * (cellH + GAP);
                return (
                  <Tile
                    key={it.id}
                    item={it}
                    tile={tile}
                    left={left}
                    top={top}
                    loaded={loadedRef.current.has(it.id)}
                    selected={it.id === selectedItemId}
                    onSelect={() => setSelectedItemId(it.id)}
                    onOpen={() => openViewer(it.id)}
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
            onOpenFull={() => selectedItem && openViewer(selectedItem.id)}
            onClose={() => setPreviewOpen(false)}
          />
        )}
      </div>

      <StatusBar
        count={items.length}
        node={selectedNode}
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
          nodePath={nodePath}
          onPrev={() => setViewerIndex((i) => (i === null ? i : Math.max(0, i - 1)))}
          onNext={() =>
            setViewerIndex((i) => (i === null ? i : Math.min(items.length - 1, i + 1)))
          }
          onClose={() => setViewerIndex(null)}
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
  nodePath: TreeNode[];
  onCrumb: (id: string) => void;
  thumbSize: ThumbSizeKey;
  setThumbSize: (s: ThumbSizeKey) => void;
  sortKey: SortKey;
  setSortKey: (s: SortKey) => void;
  activeFormats: Set<Fmt>;
  toggleFormat: (f: Fmt) => void;
  previewOpen: boolean;
  setPreviewOpen: (b: boolean) => void;
}

function Toolbar(p: ToolbarProps) {
  return (
    <div style={S.toolbarWrap}>
      {/* row 1: actions + breadcrumb */}
      <div style={S.toolbarRow}>
        <button style={S.primaryBtn} title="폴더를 선택해 트리 루트로 엽니다 (v3에서 연결)">
          폴더 열기
        </button>
        <div style={S.crumbs}>
          {p.nodePath.map((n, i) => (
            <span key={n.id} style={{ display: "inline-flex", alignItems: "center" }}>
              {i > 0 && <span style={{ color: C.textFaint, margin: "0 6px" }}>›</span>}
              <button
                style={{ ...S.crumb, color: i === p.nodePath.length - 1 ? C.text : C.textDim }}
                onClick={() => p.onCrumb(n.id)}
              >
                {n.name}
              </button>
            </span>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button
          style={{ ...S.ghostBtn, color: p.previewOpen ? C.accent : C.textDim }}
          onClick={() => p.setPreviewOpen(!p.previewOpen)}
          title="미리보기 패널 토글"
        >
          {p.previewOpen ? "미리보기 ▣" : "미리보기 ▢"}
        </button>
      </div>

      {/* row 2: size + filter + sort */}
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
          {ALL_FORMATS.map((f) => {
            const on = p.activeFormats.has(f);
            const hl = f === "webp" ? C.webp : f === "avif" ? C.avif : C.textDim;
            const highlight = f === "webp" || f === "avif";
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
          {(["name", "format", "size"] as SortKey[]).map((s) => (
            <button
              key={s}
              style={{ ...S.segBtn, ...(p.sortKey === s ? S.segBtnOn : null) }}
              onClick={() => p.setSortKey(s)}
            >
              {s === "name" ? "이름" : s === "format" ? "형식" : "크기"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree row
// ---------------------------------------------------------------------------

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggleExpand: (id: string) => void;
  selectedNodeId: string;
  onSelect: (id: string) => void;
}

function TreeRow({ node, depth, expanded, toggleExpand, selectedNodeId, onSelect }: TreeRowProps) {
  const hasChildren = !!node.children?.length;
  const isOpen = expanded.has(node.id);
  const isSel = node.id === selectedNodeId;
  const icon = node.kind === "archive" ? "🗜" : isOpen ? "📂" : "📁";

  return (
    <div>
      <div
        style={{
          ...S.treeRow,
          paddingLeft: 8 + depth * 14,
          background: isSel ? C.accentSoft : "transparent",
          color: isSel ? C.text : C.textDim,
        }}
        onClick={() => onSelect(node.id)}
        onDoubleClick={() => hasChildren && toggleExpand(node.id)}
      >
        <span
          style={{ width: 14, display: "inline-block", color: C.textFaint, cursor: "pointer" }}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) toggleExpand(node.id);
          }}
        >
          {hasChildren ? (isOpen ? "▾" : "▸") : ""}
        </span>
        <span style={{ marginRight: 6 }}>{icon}</span>
        <span
          style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {node.name}
        </span>
        {node.count > 0 && <span style={S.treeCount}>{node.count}</span>}
      </div>
      {hasChildren && isOpen && (
        <div>
          {node.children!.map((c) => (
            <TreeRow
              key={c.id}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              toggleExpand={toggleExpand}
              selectedNodeId={selectedNodeId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid tile
// ---------------------------------------------------------------------------

interface TileProps {
  item: GridItem;
  tile: number;
  left: number;
  top: number;
  loaded: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}

function Tile({ item, tile, left, top, loaded, selected, onSelect, onOpen }: TileProps) {
  const [ca, cb] = tileColors(item.id);
  return (
    <div
      style={{ position: "absolute", left, top, width: tile, height: tile + LABEL_H }}
      onClick={onSelect}
      onDoubleClick={onOpen}
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
          boxShadow: selected ? `0 0 0 4px ${C.accentSoft}` : "none",
        }}
      >
        {/* simulated decoded thumbnail (a real <img src={thumbUrl(...)}/> in v3) */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `linear-gradient(135deg, ${ca}, ${cb})`,
            opacity: loaded ? 1 : 0,
            transition: "opacity .28s ease",
          }}
        />
        {!loaded && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              color: C.textFaint,
              fontFamily: MONO,
              fontSize: 11,
            }}
          >
            …
          </div>
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

function FormatBadge({ fmt }: { fmt: Fmt }) {
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
      {fmt}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Preview panel
// ---------------------------------------------------------------------------

interface PreviewProps {
  item: GridItem | null;
  onOpenFull: () => void;
  onClose: () => void;
}

function PreviewPanel({ item, onOpenFull, onClose }: PreviewProps) {
  const [ca, cb] = item ? tileColors(item.id) : ["#1b2027", "#13161b"];
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
              background: `linear-gradient(135deg, ${ca}, ${cb})`,
              aspectRatio: `${item.w} / ${item.h}`,
              maxHeight: "46%",
            }}
          />
          <div style={{ padding: "0 14px", overflow: "auto", flex: 1 }}>
            <Meta label="이름" value={item.name} mono />
            <Meta label="형식" value={item.fmt.toUpperCase()} />
            <Meta label="해상도" value={`${item.w} × ${item.h}`} mono />
            <Meta label="크기" value={fmtBytes(item.size)} mono />
            <Meta label="경로" value={`…/${item.name}`} mono dim />
          </div>
          <div style={{ padding: 12, borderTop: `1px solid ${C.borderSoft}` }}>
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
  node: TreeNode | null;
  sortKey: SortKey;
  selectedName: string | null;
  cols: number;
  rows: number;
}

function StatusBar({ count, node, sortKey, selectedName, cols, rows }: StatusProps) {
  const sortLabel = sortKey === "name" ? "이름" : sortKey === "format" ? "형식" : "크기";
  return (
    <div style={S.statusBar}>
      <Stat>{count.toLocaleString()} 이미지</Stat>
      <Sep />
      <Stat>{node?.name ?? "—"}</Stat>
      <Sep />
      <Stat>정렬: {sortLabel}</Stat>
      <div style={{ flex: 1 }} />
      {selectedName && (
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
  item: GridItem;
  index: number;
  total: number;
  nodePath: TreeNode[];
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

function Viewer({ item, index, total, nodePath, onPrev, onNext, onClose }: ViewerProps) {
  const [ca, cb] = tileColors(item.id);
  const pathLabel = nodePath.map((n) => n.name).join(" › ");
  return (
    <div style={S.viewerBackdrop} onClick={onClose}>
      <button
        style={{ ...S.navBtn, left: 16 }}
        onClick={(e) => {
          e.stopPropagation();
          onPrev();
        }}
      >
        ‹
      </button>

      <div
        style={{
          maxWidth: "82vw",
          maxHeight: "82vh",
          aspectRatio: `${item.w} / ${item.h}`,
          width: "min(82vw, 1200px)",
          borderRadius: 10,
          border: `1px solid ${C.border}`,
          background: `linear-gradient(135deg, ${ca}, ${cb})`,
          boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
        }}
        onClick={(e) => e.stopPropagation()}
      />

      <button
        style={{ ...S.navBtn, right: 16 }}
        onClick={(e) => {
          e.stopPropagation();
          onNext();
        }}
      >
        ›
      </button>

      <div style={S.viewerInfo} onClick={(e) => e.stopPropagation()}>
        <span style={{ fontFamily: MONO, color: C.textDim }}>
          {pathLabel} › <span style={{ color: C.text }}>{item.name}</span>
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO, color: C.textDim }}>
          {index + 1} / {total}
        </span>
        <Sep />
        <span style={{ fontFamily: MONO, color: C.textDim }}>100%</span>
        <button style={{ ...S.iconBtn, marginLeft: 12 }} onClick={onClose} title="닫기 (Esc)">
          ✕
        </button>
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
  crumbs: { display: "flex", alignItems: "center", marginLeft: 6, overflow: "hidden" },
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
  grid: { flex: 1, minWidth: 0, overflow: "auto", background: C.bg },
  empty: { height: "100%", display: "grid", placeItems: "center", color: C.textFaint, fontSize: 13 },
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
};
