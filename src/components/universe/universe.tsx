'use client';

// One continuous universe. Galaxies (categories with subcategories) open into their children; stars (categories
// that hold documents) show their planets on orbits; a planet or a star opens as a document read in place.
// One canvas (decorative starlight, particles, star cores; pointer-events none) sits behind imperatively
// positioned DOM buttons (accessible hit targets). Camera and layout live in refs; React state only drives
// which buttons exist, the reader, and the chrome. Design: docs/ARCHIVE_DESIGN.md §5, docs/FABLE_UNIVERSE_BRIEF.md.
import {useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent} from 'react';
import type {Camera, Circle, UniverseCategory, UniverseItem, UniverseSource, Viewport} from './types';
import type {UrlReport, UrlReportCitation} from '../../contracts/types';
import {createTopicSource} from '../../lib/universe-data';
import {loadSpatialSearch, type SpatialNode} from '../../lib/spatial-data';
import {apiGet} from '../../lib/api-client';
import {isUrlQuery} from './url-query';
import {rootCircle, packChildren, placeOrbits, HOLE_KEY, ORBIT_INNER} from './layout';
import {worldToScreen, screenToWorld, zoomAt, panBy, fitCircle, interpolate, inertiaStep, clampScale} from './camera';
import {screenRadius, stageFor, stageScale, isVisible, pickFetchTargets, directionalNode, itemsOpen, STAGE_PX, type Stage, type FetchCandidate} from './lod';
import {makeStarfield, paintStarfield, drawCategoryPoint, drawCategoryParticles, drawCategoryGlow, drawStarCore, makeCategoryParticles, type Star, type Particle} from './starfield';
import {bodyKind, starCircle, CENTER_HOLE, type BodyKind} from './celestial';
import {estimateLabelWidth, resolveLabels, placeStableLabels, stableAnchorBox, labelZoomBucket, labelBucketScale, resolveMotionLabels, EMPTY_LABEL_STATE, type LabelBox, type LabelAnchor, type LabelState, type StableStarInput} from './labels';
import UniverseReader, {readerTargetKey, relationLabel, type ReaderNeighbor, type ReaderTarget} from './reader';
import {hueHex} from './appearance';
import './universe.css';

type CategoryEntry = {category: UniverseCategory; circle: Circle; parentId: string | null; kind: BodyKind; star: Circle};
type ItemEntry = {item: UniverseItem; circle: Circle};
type PointerState = {id: number; startX: number; startY: number; lastX: number; lastY: number; lastAt: number; moved: boolean; samples: {dx: number; dy: number; dt: number; at: number}[]};
type PinchState = {dist: number; mid: {x: number; y: number}};
type Highlight = {itemId: string; until: number};
type SuggestRow = {node: SpatialNode; categoryId: string; starLabel: string};
/** The url-report card's state for the URL the search box currently holds (see url-query.ts). */
type UrlReportState = {status: 'loading' | 'ready' | 'error'; report: UrlReport | null; url: string};

const DRAG_THRESHOLD = 7;
const STILL_MS = 120;
const DOM_DEBOUNCE_MS = 80;
const HIGHLIGHT_MS = 1600;
const NOT_FOUND_MS = 2000;
const IDLE_MS = 2000;
/** Desktop: the pill reveals when the pointer reaches this many pixels of the top edge. */
const HOVER_ZONE_PX = 48;
/** Desktop: after the pointer leaves the zone/pill, an empty and unfocused pill hides after this delay. */
const HOVER_HIDE_MS = 600;
/** Suggestions wait this long after the last keystroke before searching, and need at least this many characters. */
const SUGGEST_DEBOUNCE_MS = 250;
const SUGGEST_MIN_CHARS = 2;
const SUGGEST_MAX_RESULTS = 8;
const MAX_DOM_CATEGORIES = 150;
const MAX_DOM_ITEMS = 400;
const MAX_FETCH = 4;
const ARROW_STEP = 0.12;
const MAX_FLICK = 60;
/** The archive's guide to itself sits at the centre of the universe. */
const CENTER_CATEGORY_ID = 'topic:Morum';
/** Fraction of an opened category's radius where particles dim behind its centred name. */
const NAME_QUIET_RATIO = 0.3;
/** Planet labels: one line under the dot, culled like map labels when they would overlap. Their size follows the star's size on screen. */
const LABEL_FONT_MIN_PX = 11;
const LABEL_FONT_MAX_PX = 17;
/** Star names sit at the centre and scale with the star; planet labels never sit on top of them. */
const NAME_FONT_MIN_PX = 14;
const NAME_FONT_MAX_PX = 38;
/** Planet labels fade in as the star grows from this many screen pixels of radius to twice that. */
const LABEL_FADE_START_PX = 160;
/** Widest a planet title may be before it is cut: grows with the star so a zoomed-in title is never cut for lack of room. */
function labelMaxPx(starRadiusPx: number, viewportWidth: number): number {
  const base = viewportWidth <= 850 ? 144 : 192;
  return Math.max(base, Math.min(520, starRadiusPx * 0.45));
}
const LABEL_PAD_PX = 10;
/** Planet label offset from the dot's surface: 10px on the four axis anchors, 9px on the diagonals (4-1). */
const LABEL_AXIS_GAP_PX = 10;
const LABEL_DIAG_GAP_PX = 9;
/** Screen radius of a planet's drawn dot; labels hang below the dot, not below the (larger) hit circle. */
const DOT_PX = 3;
/** A far star shows its name below its cluster once the cluster is this many pixels across. */
const NAME_FAR_MIN_PX = 5;
const EDGE_PX = 6;
/** The search pill and crumb occupy the bottom of the screen; labels stop above them. Fallback before the
 * chrome's real height is measured (B §4: replaces the old fixed 120px, which cut off once the intro
 * paragraph grew the chrome past it). */
const CHROME_PX_FALLBACK = 120;
const CHROME_MEASURE_MARGIN_PX = 12;

/** Below a far star's cluster the name hangs under it; on an open star it sits at the centre. */
function nameOffsetPx(stage: Stage, radiusPx: number, nameFont: number): number {
  // The lit cluster is much smaller than the category circle, so the name follows the cluster, not the circle.
  return stage === 'nebula' ? Math.min(28, Math.max(10, radiusPx * 0.4)) + 6 + nameFont * 0.65 : 0;
}

function insideViewport(x: number, y: number, width: number, height: number, viewport: Viewport, chromePx: number): boolean {
  return x - width / 2 >= EDGE_PX && x + width / 2 <= viewport.width - EDGE_PX && y - height / 2 >= EDGE_PX && y + height / 2 <= viewport.height - chromePx;
}
/** A planet's opening lines appear under its title once its star fills this many screen pixels of radius. */
/** Untitled records: the label is cut to this many code points, broken at a word boundary, no trailing "…" (4-3). */
const UNTITLED_LABEL_CHARS = 18;
const KEY_ZOOM = 1.35;
const SHOW_STARFIELD = false;
const DOUBLE_CLICK_ZOOM = 2.4;
const WHEEL_STEP = 0.0018;
const WHEEL_MAX_LOG = 0.7;
const ZOOM_SMOOTHING = 0.28;

function itemKey(categoryId: string, itemId: string): string { return `${categoryId}::${itemId}`; }
function splitItemKey(key: string): [string, string] { const i = key.indexOf('::'); return [key.slice(0, i), key.slice(i + 2)]; }
/** A url-report citation's own link, preferring the version it names (a `links` field would win if the
 * contract ever adds one — it does not today) and falling back to the record it belongs to. */
function citationHref(citation: UrlReportCitation): string | null {
  if (citation.version_id) return `/versions/${encodeURIComponent(citation.version_id)}`;
  if (citation.record_id) return `/records/${encodeURIComponent(citation.record_id)}`;
  return null;
}
/** Untitled records are labelled by the first 18 code points of their opening text, cut at a word boundary,
 * with no trailing "…" (4-3: an ellipsis reads as something hidden; the field is not a table of contents).
 * Titled records keep their title as-is, but a trailing sentence period is dropped (the field label is not a
 * sentence). Code points, not UTF-16 units, so a multi-byte character is never split in half. */
function itemLabel(item: UniverseItem): string {
  if (!item.node.untitled) {
    const title = item.title.trim();
    return /[.。]$/.test(title) ? title.slice(0, -1) : title;
  }
  const text = item.snippet.replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  if (chars.length <= UNTITLED_LABEL_CHARS) return text;
  const cut = chars.slice(0, UNTITLED_LABEL_CHARS).join('');
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}
/** Flight time grows a little with the zoom change, so long dives read as travel and short hops stay quick. */
/** Planet label font for a star of this screen radius. */
function labelFontPx(starRadiusPx: number): number {
  return Math.max(LABEL_FONT_MIN_PX, Math.min(LABEL_FONT_MAX_PX, starRadiusPx * 0.04));
}
/** Star name font for a star of this screen radius. */
function nameFontPx(starRadiusPx: number): number {
  return Math.max(NAME_FONT_MIN_PX, Math.min(NAME_FONT_MAX_PX, starRadiusPx * 0.09));
}
function flightMs(from: Camera, to: Camera): number {
  const ratio = Math.abs(Math.log2(to.scale / from.scale));
  return Math.max(420, Math.min(900, 420 + ratio * 110));
}

export default function Universe({initialDoc}: {initialDoc?: string} = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  /** The bottom chrome's real height + margin (B §4), replacing the old fixed 120px label keep-out. */
  const chromeHeightRef = useRef(CHROME_PX_FALLBACK);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const buttonElsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const selectedKeyRef = useRef<string | null>(null);
  /** The body a deliberate tap or arrow key chose; the next tap on it opens it. Focus alone (a mouse press) does not arm. */
  const armedKeyRef = useRef<string | null>(null);

  const sourceRef = useRef<UniverseSource | null>(null);
  const cameraRef = useRef<Camera>({x: 0, y: 0, scale: 1});
  const viewportRef = useRef<Viewport>({width: 0, height: 0});
  const categoriesRef = useRef<Map<string, CategoryEntry>>(new Map());
  const loadedChildrenRef = useRef<Set<string>>(new Set());
  const loadedItemsRef = useRef<Set<string>>(new Set());
  const itemCirclesRef = useRef<Map<string, Map<string, ItemEntry>>>(new Map());
  const starDocsRef = useRef<Map<string, UniverseItem | null>>(new Map());
  const starDocLoadingRef = useRef<Map<string, Promise<UniverseItem | null>>>(new Map());
  const particlesRef = useRef<Map<string, Particle[]>>(new Map());
  const starsRef = useRef<Star[]>(makeStarfield());
  const reducedMotionRef = useRef(false);
  const highlightRef = useRef<Highlight | null>(null);
  const labelsRef = useRef<Set<string>>(new Set());
  /** Which of the 8 fixed anchors each shown planet title landed on, set alongside labelsRef each paint. */
  const labelAnchorsRef = useRef<Map<string, LabelAnchor>>(new Map());
  /** A1: the last still-camera label recompute (labelsRef/labelAnchorsRef are always derived from this). */
  const labelStateRef = useRef<LabelState>(EMPTY_LABEL_STATE);
  /** Item keys whose anchor or visibility changed on the last recompute — these get the one-paint fade class. */
  const labelChangedRef = useRef<Set<string>>(new Set());
  /** True from the first camera-changing input until STILL_MS after the last one (A1: drag, wheel, pinch,
   * flight, inertia). While true, paint() freezes label anchors/visibility and DOM stage/tier membership. */
  const movingRef = useRef(false);
  const rootElRef = useRef<HTMLDivElement>(null);
  /** Declared relations of the open or selected document: version id → predicate label, for marking planets. */
  const relatedRef = useRef<Map<string, string>>(new Map());

  const rafRef = useRef<number | null>(null);
  const flightRafRef = useRef<number | null>(null);
  const flightResolveRef = useRef<(() => void) | null>(null);
  const inertiaRafRef = useRef<number | null>(null);
  const zoomRafRef = useRef<number | null>(null);
  const zoomPendingRef = useRef(0);
  const zoomAnchorRef = useRef({x: 0, y: 0});
  const velocityRef = useRef({x: 0, y: 0});
  const pointerRef = useRef<PointerState | null>(null);
  const activePointersRef = useRef<Set<number>>(new Set());
  const pinchRef = useRef<PinchState | null>(null);
  const suppressClickRef = useRef(false);

  const readerRef = useRef<ReaderTarget | null>(null);
  const returnCameraRef = useRef<Camera | null>(null);
  /** The circle the view was last fitted to. Until the visitor moves the camera, a resize keeps it fitted. */
  const lastFitRef = useRef<{circle: Circle; margin: number} | null>(null);
  const touchedRef = useRef(false);
  const readerPushesRef = useRef(0);

  const stillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notFoundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const domTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committedDomRef = useRef({cats: '', items: ''});
  const fetchControllersRef = useRef<Set<AbortController>>(new Set());
  const searchControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  /** Desktop reveal: true while the pointer sits over the top hover zone or the pill itself. */
  const hoveringSearchRef = useRef(false);
  const hoverHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestControllerRef = useRef<AbortController | null>(null);
  const suggestionsRef = useRef<SuggestRow[]>([]);
  const inputFocusedRef = useRef(false);
  const queryRef = useRef('');
  const urlReportControllerRef = useRef<AbortController | null>(null);

  const [domCategoryIds, setDomCategoryIds] = useState<string[]>([]);
  const [domItemKeys, setDomItemKeys] = useState<string[]>([]);
  const [crumbText, setCrumbText] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [pillHidden, setPillHidden] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  /** Touch or a narrow viewport keeps the search pill visible as before; a fine pointer on a wide screen hides it by default. */
  const [alwaysVisible, setAlwaysVisible] = useState(false);
  const alwaysVisibleRef = useRef(false);
  /** Desktop only: the pill shows on demand (`/`, Cmd/Ctrl+K, or typing while nothing is focused) rather than staying docked. */
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpenRef = useRef(false);
  const searchPrevFocusRef = useRef<HTMLElement | null>(null);
  const [composing, setComposing] = useState(false);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<SuggestRow[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [urlReport, setUrlReport] = useState<UrlReportState | null>(null);
  /** Escape dismisses the url-report card without clearing the typed URL (mirrors clearing the suggestion
   * list); the next keystroke reopens it, same as suggestions reappearing once retyped. */
  const [urlCardClosed, setUrlCardClosed] = useState(false);
  const [reader, setReader] = useState<ReaderTarget | null>(null);
  // Opening a document closes the desktop pill outright, so closing the reader comes back to the plain field.
  useEffect(() => {
    if (!reader) return;
    clearHoverHideTimer();
    hoveringSearchRef.current = false;
    searchPrevFocusRef.current = null;
    if (searchOpenRef.current) { searchOpenRef.current = false; setSearchOpen(false); }
    setSuggestionsBoth([]);
    setHighlightIndex(-1);
  }, [reader]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Canvas and DOM placement -------------------------------------------------------------------------

  function resizeCanvas(): void {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas) return;
    // Item 7: while the camera moves, the backing store drops to 1 device pixel per CSS pixel (a quarter of
    // the fill work on a 2x display); the real ratio comes back once the camera is still. CSS size is unchanged.
    const dpr = movingRef.current ? 1 : window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(viewport.width * dpr));
    const height = Math.max(1, Math.round(viewport.height * dpr));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function bindButton(key: string, el: HTMLButtonElement | null): void {
    if (!el) { buttonElsRef.current.delete(key); return; }
    buttonElsRef.current.set(key, el);
    // Place it now; waiting for the next paint leaves freshly mounted buttons at 0×0 until the camera moves.
    positionButton(key, el, cameraRef.current, viewportRef.current, performance.now());
  }

  /** A2: while the camera is moving, a newly-entered body mounts right away (no debounce — growing the set
   * is cheap, and "immediately" is the point), but nothing already mounted unmounts until the camera is still,
   * so this only ever grows the set in that case. Once still, it settles to exactly the computed set on the
   * usual debounce, which is what lets it shrink back down. */
  function commitDom(cats: string[], items: string[]): void {
    if (!movingRef.current) {
      const catsKey = cats.join(',');
      const itemsKey = items.join(',');
      if (catsKey === committedDomRef.current.cats && itemsKey === committedDomRef.current.items) return;
      if (domTimerRef.current) clearTimeout(domTimerRef.current);
      domTimerRef.current = setTimeout(() => {
        domTimerRef.current = null;
        committedDomRef.current = {cats: catsKey, items: itemsKey};
        setDomCategoryIds(cats);
        setDomItemKeys(items);
      }, DOM_DEBOUNCE_MS);
      return;
    }
    const nextCats = mergeAdditive(committedDomRef.current.cats, cats, MAX_DOM_CATEGORIES);
    const nextItems = mergeAdditive(committedDomRef.current.items, items, MAX_DOM_ITEMS);
    const catsKey = nextCats.join(',');
    const itemsKey = nextItems.join(',');
    if (catsKey === committedDomRef.current.cats && itemsKey === committedDomRef.current.items) return;
    if (domTimerRef.current) clearTimeout(domTimerRef.current);
    domTimerRef.current = null;
    committedDomRef.current = {cats: catsKey, items: itemsKey};
    setDomCategoryIds(nextCats);
    setDomItemKeys(nextItems);
  }

  function mergeAdditive(committedKey: string, desired: string[], max: number): string[] {
    const merged = new Set(committedKey ? committedKey.split(',') : []);
    for (const id of desired) merged.add(id);
    return [...merged].slice(0, max);
  }

  function positionDomButtons(camera: Camera, viewport: Viewport): void {
    const now = performance.now();
    for (const [key, el] of buttonElsRef.current) positionButton(key, el, camera, viewport, now);
  }

  function positionButton(key: string, el: HTMLButtonElement, camera: Camera, viewport: Viewport, now: number): void {
    const isItem = key.includes('::');
    let circle: Circle | undefined;
    if (isItem) {
      const [categoryId, itemId] = splitItemKey(key);
      circle = itemCirclesRef.current.get(categoryId)?.get(itemId)?.circle;
    } else {
      circle = categoriesRef.current.get(key)?.circle;
    }
    if (!circle) return;
    const pos = worldToScreen(camera, viewport, circle);
    const r = Math.max(screenRadius(circle, camera), 1);
    el.style.transform = `translate(${pos.x - r}px, ${pos.y - r}px)`;
    el.style.width = `${r * 2}px`;
    el.style.height = `${r * 2}px`;
    el.dataset.selected = selectedKeyRef.current === key ? 'true' : 'false';
    if (isItem) {
      const [categoryId, itemId] = splitItemKey(key);
      const entry = itemCirclesRef.current.get(categoryId)?.get(itemId);
      const highlight = highlightRef.current;
      const labels = labelsRef.current;
      el.dataset.detail = labels.has(key) ? 'title' : 'none';
      el.dataset.titled = entry && !entry.item.node.untitled ? 'true' : 'false';
      el.dataset.highlight = highlight && highlight.itemId === itemId && now < highlight.until ? 'true' : 'false';
      const related = entry?.item.versionId ? relatedRef.current.get(entry.item.versionId) : undefined;
      if (related) el.dataset.related = related; else delete el.dataset.related;
      const star = categoriesRef.current.get(categoryId);
      const starRadiusPx = star ? screenRadius(star.star, camera) : 0;
      // Colour is keyed to the parent star's on-screen stage, not the (fixed 6px) dot size, and shares the
      // same fade range as the planet label (B §5): it mixes in from the star's own --label-fade below.
      if (entry) el.style.setProperty('--planet-hue-color', hueHex(entry.item.node.appearance.hue));
      const font = labelFontPx(starRadiusPx);
      el.style.setProperty('--label-size', `${font.toFixed(2)}px`);
      el.style.setProperty('--label-line', `${Math.round(font * 1.35)}px`);
      const maxWidth = labelMaxPx(starRadiusPx, viewport.width);
      el.style.setProperty('--label-max', `${Math.round(maxWidth)}px`);
      el.style.setProperty('--label-lines', entry && estimateLabelWidth(itemLabel(entry.item), font) > maxWidth ? '2' : '1');
      el.style.setProperty('--label-fade', Math.max(0, Math.min(1, (starRadiusPx - LABEL_FADE_START_PX * stageScale(viewport)) / (LABEL_FADE_START_PX * stageScale(viewport)))).toFixed(3));
      el.dataset.anchor = labelAnchorsRef.current.get(key) ?? 'b';
      // A1: only a label whose anchor or visibility actually changed on the last (still-camera) recompute
      // gets the brief fade-in; the class is applied for one paint and then cleared by paintLabelChanges.
      if (labelChangedRef.current.has(key)) el.dataset.labelChanged = 'true'; else delete el.dataset.labelChanged;
    } else {
      const entry = categoriesRef.current.get(key);
      el.dataset.stage = entry ? stageFor(screenRadius(entry.circle, camera), entry.category.directCount > 0, entry.category.childCount > 0, stageScale(viewport)) : 'nebula';
      el.dataset.kind = entry?.kind ?? 'empty';
      el.dataset.open = entry && entry.category.directCount > 0 && itemsOpen(screenRadius(entry.star, camera), stageScale(viewport)) ? 'true' : 'false';
      el.dataset.named = labelsRef.current.has(`name:${key}`) ? 'true' : 'false';
      if (entry) {
        const starRadiusPx = screenRadius(entry.star, camera);
        const nameFont = nameFontPx(starRadiusPx);
        el.style.setProperty('--name-size', `${nameFont.toFixed(2)}px`);
        const isStar = entry.kind === 'star' || entry.kind === 'galaxy-star';
        // The reticle hugs the star's own core light (the small bright disc drawStarCore actually paints,
        // starRadiusPx * 0.09 clamped to [2.5, 48]), not the (much larger) hit circle around it — the hit
        // area itself is untouched. A plain galaxy has no core light to hug, so it falls back to the hit
        // circle's own edge, same as before. Capped by the name's own width too, so up close it never grows
        // into a field of scattered ticks (4-5).
        if (isStar) {
          const coreLightRadiusPx = Math.max(2.5, Math.min(48, starRadiusPx * 0.09));
          const nameWidthPx = estimateLabelWidth(entry.category.label, nameFont);
          el.style.setProperty('--reticle-r', `${Math.max(12, Math.min(coreLightRadiusPx + 6, nameWidthPx / 2 + 12, 64)).toFixed(1)}px`);
          // The open star's name stays centred on the core light (owner choice); far away it hangs under
          // its cluster as before.
          el.style.setProperty('--name-dy', `${nameOffsetPx(el.dataset.stage as Stage, r, nameFont).toFixed(1)}px`);
        } else {
          el.style.setProperty('--reticle-r', `${(r + 6).toFixed(1)}px`);
          el.style.setProperty('--name-dy', `${nameOffsetPx(el.dataset.stage as Stage, r, nameFont).toFixed(1)}px`);
        }
      }
    }
  }

  function currentCategoryId(): string | null {
    const camera = cameraRef.current, viewport = viewportRef.current;
    const centre = screenToWorld(camera, viewport, {x: viewport.width / 2, y: viewport.height / 2});
    const limit = 2 * Math.min(viewport.width, viewport.height);
    let best: {id: string; radiusPx: number} | null = null;
    for (const [id, entry] of categoriesRef.current) {
      if (Math.hypot(centre.x - entry.circle.x, centre.y - entry.circle.y) > entry.circle.r) continue;
      const radiusPx = screenRadius(entry.circle, camera);
      // Only an opened category counts as the place you are in; the deepest one wins.
      if (radiusPx < STAGE_PX.open * stageScale(viewport) || radiusPx >= limit * 40) continue;
      if (!best || radiusPx < best.radiusPx) best = {id, radiusPx};
    }
    return best?.id ?? null;
  }

  function computeCrumb(): string {
    const id = currentCategoryId();
    if (!id) return '';
    const labels: string[] = [];
    let cursor: string | null = id;
    while (cursor) {
      const entry: CategoryEntry | undefined = categoriesRef.current.get(cursor);
      if (!entry) break;
      labels.unshift(entry.category.label);
      cursor = entry.parentId;
    }
    const entry = categoriesRef.current.get(id);
    const inStar = entry && entry.category.directCount > 0 && itemsOpen(screenRadius(entry.star, cameraRef.current), stageScale(viewportRef.current));
    return labels.join(' › ') + (inStar ? ` · 행성 ${entry.category.directCount}` : '');
  }

  // ---- Paint ----------------------------------------------------------------------------------------------

  function paint(): void {
    rafRef.current = null;
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || viewport.width <= 0 || viewport.height <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const camera = cameraRef.current;
    const k = stageScale(viewport);
    const reading = readerRef.current !== null;
    // While a document is open the field stays, but every light behind the text is turned well down.
    const dim = reading ? 0.22 : 1;

    ctx.clearRect(0, 0, viewport.width, viewport.height);
    // Decorative starlight is off for now (2026-09-23): it was barely visible and only added motion behind the data.
    if (SHOW_STARFIELD) paintStarfield(ctx, starsRef.current, camera, viewport, reading ? 0.3 : 1);

    const catNodes: {id: string; radiusPx: number}[] = [];
    const itemNodes: {key: string; radiusPx: number}[] = [];
    const boxes: LabelBox[] = [];
    // Planet titles are placed after every star's name is known, against their own star's dots, in a
    // pan-invariant frame at a quantised zoom (labels.ts placeStableLabels), so panning never moves a title.
    const bucketScale = labelBucketScale(labelZoomBucket(camera.scale));
    const stableStars: StableStarInput[] = [];
    const stableBlockers: LabelBox[] = [];
    const screenLabels = new Map<string, {x: number; y: number; width: number; height: number}>();
    // Under-cluster names belong to the far view only: once any body in view is at the open or items stage
    // (the visitor is inside a star), neighbouring nebula-stage stars keep their names until they open themselves.
    let insideStar = false;
    for (const entry of categoriesRef.current.values()) {
      if (!isVisible(entry.circle, camera, viewport)) continue;
      const stage = stageFor(screenRadius(entry.circle, camera), entry.category.directCount > 0, entry.category.childCount > 0, k);
      if (stage === 'open' || stage === 'items') { insideStar = true; break; }
    }
    rootElRef.current?.setAttribute('data-inside-star', insideStar ? 'true' : 'false');
    for (const [id, entry] of categoriesRef.current) {
      if (!isVisible(entry.circle, camera, viewport)) continue;
      const radiusPx = screenRadius(entry.circle, camera);
      const stage: Stage = stageFor(radiusPx, entry.category.directCount > 0, entry.category.childCount > 0, k);
      const screenPos = worldToScreen(camera, viewport, entry.circle);
      const starRadiusPx = screenRadius(entry.star, camera);
      const open = entry.category.directCount > 0 && itemsOpen(starRadiusPx, k);
      if (stage === 'point') {
        drawCategoryPoint(ctx, screenPos, entry.category.mass, dim);
      } else {
        let points = particlesRef.current.get(id);
        if (!points) { points = makeCategoryParticles(entry.circle, entry.category.layoutSeed, entry.category.mass, entry.kind === 'star' ? 2.3 : 1.6); particlesRef.current.set(id, points); }
        if (stage === 'nebula') {
          // Far away a star is a soft point; as it grows, more of its particles light up.
          const t = Math.min(1, (radiusPx - STAGE_PX.nebula * k) / ((STAGE_PX.open - STAGE_PX.nebula) * k));
          drawCategoryParticles(ctx, points.slice(0, Math.ceil(points.length * (0.25 + 0.75 * t))), camera, viewport, (0.35 + 0.65 * t) * dim);
        } else {
          const fade = Math.max(0.05, 1 - (radiusPx - STAGE_PX.open * k) / ((STAGE_PX.items - STAGE_PX.open) * k));
          drawCategoryParticles(ctx, points, camera, viewport, fade * dim, {x: entry.circle.x, y: entry.circle.y, r: entry.circle.r * NAME_QUIET_RATIO});
          if (!reading) drawCategoryGlow(ctx, screenPos, radiusPx);
        }
        // A star's light. Dimmer once its name sits on it, like the particles behind the name.
        if (entry.kind === 'star' || entry.kind === 'galaxy-star') drawStarCore(ctx, screenPos, starRadiusPx, (stage === 'nebula' ? 0.85 : 0.35) * dim);
        catNodes.push({id, radiusPx});
        // The name at the centre takes its place before any planet label.
        // Far away the name hangs under the cluster and competes with its neighbours like any map label.
        const far = stage === 'nebula';
        if (!far || (!insideStar && (selectedKeyRef.current === id || radiusPx >= NAME_FAR_MIN_PX * k))) {
          const nameFont = nameFontPx(starRadiusPx);
          const namePos = worldToScreen(camera, viewport, entry.star);
          const nameY = namePos.y + nameOffsetPx(stage, radiusPx, nameFont);
          const nameWidth = far ? estimateLabelWidth(entry.category.label, nameFont) : Math.min(estimateLabelWidth(entry.category.label, nameFont), starRadiusPx * 0.68);
          const nameHeight = nameFont * 1.3;
          if (!far || insideViewport(namePos.x, nameY, nameWidth, nameHeight, viewport, chromeHeightRef.current)) {
            boxes.push({id: `name:${id}`, x: namePos.x, y: nameY, width: nameWidth, height: nameHeight, priority: far ? 1e6 + entry.category.mass : 2e6});
          }
        }
      }
      if (open) {
        const items = itemCirclesRef.current.get(id);
        if (!items) continue;
        const font = labelFontPx(starRadiusPx);
        const lineHeight = Math.round(font * 1.35);
        const maxWidth = labelMaxPx(starRadiusPx, viewport.width);
        // The same sizes at the bucket's scale, for the pan-invariant layout.
        const bucketStarPx = entry.star.r * bucketScale;
        const bucketFont = labelFontPx(bucketStarPx);
        const bucketLine = Math.round(bucketFont * 1.35);
        const bucketMax = labelMaxPx(bucketStarPx, viewport.width);
        // The open star's centred name is the first thing its planets' titles must avoid.
        const bucketNameFont = nameFontPx(bucketStarPx);
        stableBlockers.push({id: `name:${id}`, x: entry.star.x * bucketScale, y: entry.star.y * bucketScale,
          width: Math.min(estimateLabelWidth(entry.category.label, bucketNameFont), bucketStarPx * 0.68), height: bucketNameFont * 1.3, priority: 2e6});
        // Every planet of the star takes part (not only those on screen), so panning never changes the set.
        const dots: StableStarInput['dots'] = [];
        const labels: StableStarInput['labels'] = [];
        // Built every frame, moving or not: a new planet entering the viewport (or reaching this stage) must be
        // able to claim a free anchor immediately (resolveMotionLabels below), not only once the camera settles.
        for (const [itemId, entryItem] of items) {
          const key = itemKey(id, itemId);
          dots.push({id: itemId, x: entryItem.circle.x, y: entryItem.circle.y});
          const label = itemLabel(entryItem.item);
          const selected = selectedKeyRef.current === key;
          const lit = highlightRef.current?.itemId === itemId;
          const priority = (selected ? 1e6 : 0) + (lit ? 1e5 : 0) + (entryItem.item.node.untitled ? 0 : 10) + Math.min(entryItem.circle.r * bucketScale, 9);
          // A long title wraps onto a second line rather than being cut; its box grows to match.
          const bucketFull = estimateLabelWidth(label, bucketFont);
          labels.push({id: key, dotId: itemId, x: entryItem.circle.x, y: entryItem.circle.y,
            width: Math.min(bucketFull, bucketMax), height: bucketLine * (bucketFull > bucketMax ? 2 : 1), priority});
          if (!isVisible(entryItem.circle, camera, viewport)) continue;
          itemNodes.push({key, radiusPx: screenRadius(entryItem.circle, camera)});
          const pos = worldToScreen(camera, viewport, entryItem.circle);
          const fullWidth = estimateLabelWidth(label, font);
          screenLabels.set(key, {x: pos.x, y: pos.y, width: Math.min(fullWidth, maxWidth), height: lineHeight * (fullWidth > maxWidth ? 2 : 1)});
        }
        // Bigger stars claim spots first; the order never depends on where the camera is.
        stableStars.push({id, order: entry.star.r, dots, labels});
      }
    }
    // A1/A2: while the camera is moving, an existing label never relocates or hides on its own — but a body
    // that is newly visible this frame (entered the viewport, or just reached this stage) may still take a
    // free anchor and fade in right away, and a body that left the viewport may fade out; only an actual
    // collision between two already-shown labels waits for the still-time recompute (resolveMotionLabels).
    const prevLabelState = labelStateRef.current;
    const {state: labelState} = resolveMotionLabels(movingRef.current, prevLabelState, () => {
      const resolved = resolveLabels(boxes, LABEL_PAD_PX);
      // Item 8: sticky anchors, chosen per zoom bucket in a pan-invariant frame. Every placed title keeps its
      // anchor in the state (on screen or not) so it sticks when it comes back into view.
      const anchors = placeStableLabels(stableStars, bucketScale, {
        axisGap: DOT_PX + LABEL_AXIS_GAP_PX, diagGap: DOT_PX + LABEL_DIAG_GAP_PX, pad: LABEL_PAD_PX, dotPx: DOT_PX,
        blockers: stableBlockers, prev: prevLabelState.anchors, always: key => selectedKeyRef.current === key,
      });
      // Being off screen or under the bottom chrome only hides a title; it never moves one.
      for (const [key, anchor] of anchors) {
        const at = screenLabels.get(key);
        if (!at) continue;
        const box = stableAnchorBox(at, anchor, 1, DOT_PX + LABEL_AXIS_GAP_PX, DOT_PX + LABEL_DIAG_GAP_PX);
        if (selectedKeyRef.current === key || insideViewport(box.x, box.y, box.width, box.height, viewport, chromeHeightRef.current)) resolved.add(key);
      }
      return {visible: resolved, anchors};
    });
    // Only a title that appears fades in; one whose anchor changed slides there (universe.css), and one that
    // disappears fades out through its own opacity transition.
    const changed = new Set<string>();
    if (labelState !== prevLabelState) for (const key of labelState.visible) if (!prevLabelState.visible.has(key)) changed.add(key);
    labelStateRef.current = labelState;
    labelChangedRef.current = changed;
    if (changed.size > 0) {
      // Clear the one-paint fade marker once the 160ms CSS animation has had time to run, so it never
      // replays for a label that did not change again on the next still recompute.
      setTimeout(() => { labelChangedRef.current = new Set(); schedulePaint(); }, 200);
    }
    labelAnchorsRef.current = labelState.anchors;
    labelsRef.current = labelState.visible;

    // Item 6: while reading, blur the finished frame once, in the bitmap itself (the field is still behind
    // the text, so this runs only on the rare repaint), instead of a CSS filter recomposited every frame.
    if (reading) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.filter = `blur(${(2 * (canvas.width / Math.max(1, viewport.width))).toFixed(1)}px)`;
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(canvas, 0, 0);
      ctx.restore();
    }

    positionDomButtons(camera, viewport);
    // A2: a new item/category entering the mounted DOM set applies even while moving (commitDom only grows the
    // set in that case); one leaving it only unmounts once the camera is still, same as commitDom always did.
    catNodes.sort((a, b) => b.radiusPx - a.radiusPx);
    itemNodes.sort((a, b) => b.radiusPx - a.radiusPx);
    commitDom(catNodes.slice(0, MAX_DOM_CATEGORIES).map(n => n.id), itemNodes.slice(0, MAX_DOM_ITEMS).map(n => n.key));

    const nextCrumb = computeCrumb();
    setCrumbText(prev => (prev === nextCrumb ? prev : nextCrumb));
  }

  function schedulePaint(): void {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(paint);
  }

  // ---- Camera motion ------------------------------------------------------------------------------------

  function stopFlight(): void {
    if (flightRafRef.current !== null) { cancelAnimationFrame(flightRafRef.current); flightRafRef.current = null; }
    // An interrupted flight (another fly/glide/pan starting mid-animation) must still resolve its promise —
    // otherwise a caller awaiting it (search hand-off) would hang forever.
    if (flightResolveRef.current) { const resolve = flightResolveRef.current; flightResolveRef.current = null; resolve(); }
  }
  function stopInertia(): void {
    if (inertiaRafRef.current !== null) { cancelAnimationFrame(inertiaRafRef.current); inertiaRafRef.current = null; }
    velocityRef.current = {x: 0, y: 0};
  }
  function stopZoom(): void {
    if (zoomRafRef.current !== null) { cancelAnimationFrame(zoomRafRef.current); zoomRafRef.current = null; }
    zoomPendingRef.current = 0;
  }

  function updateUrl(categoryId: string | null, target: ReaderTarget | null = readerRef.current, push = false): void {
    const params = new URLSearchParams();
    if (categoryId) params.set('c', categoryId);
    if (target?.kind === 'doc') params.set('doc', target.versionId);
    if (target?.kind === 'star-missing') params.set('star', target.categoryId);
    const url = params.size ? `/?${params.toString()}` : '/';
    if (push) window.history.pushState({universe: true}, '', url);
    else window.history.replaceState({universe: true}, '', url);
  }

  async function fetchStarDoc(categoryId: string, signal?: AbortSignal): Promise<UniverseItem | null> {
    if (starDocsRef.current.has(categoryId)) return starDocsRef.current.get(categoryId) ?? null;
    const source = sourceRef.current;
    if (!source) return null;
    let pending = starDocLoadingRef.current.get(categoryId);
    if (!pending) {
      pending = source.star(categoryId, signal).then(doc => { if (mountedRef.current) starDocsRef.current.set(categoryId, doc); return doc; }).finally(() => starDocLoadingRef.current.delete(categoryId));
      starDocLoadingRef.current.set(categoryId, pending);
    }
    return pending;
  }

  async function fetchItemsFor(categoryId: string, signal?: AbortSignal): Promise<void> {
    if (itemCirclesRef.current.has(categoryId)) return;
    const entry = categoriesRef.current.get(categoryId);
    const source = sourceRef.current;
    if (!entry || !source) return;
    loadedItemsRef.current.add(categoryId);
    try {
      const [items] = await Promise.all([source.items(categoryId, signal), fetchStarDoc(categoryId, signal).catch(() => null)]);
      if (!mountedRef.current) return;
      const ages = items.map(item => (item.node.createdAt ? Date.parse(item.node.createdAt) : null));
      const validAges = ages.filter((a): a is number => a !== null && Number.isFinite(a));
      const oldest = validAges.length ? Math.min(...validAges) : 0;
      const newest = validAges.length ? Math.max(...validAges) : 0;
      const ageSpan = newest - oldest || 1;
      const planets = items.map((item, i) => ({
        id: item.id,
        // ageRank input: 1 = oldest. Raw age (older = smaller timestamp), normalised; placeOrbits ranks it itself.
        ageRank: ages[i] === null ? 0.5 : 1 - (ages[i]! - oldest) / ageSpan,
        reviewRank: item.node.reviewCount === null ? 0.5 : item.node.reviewCount,
      }));
      const circles = placeOrbits(entry.star, categoryId, planets, entry.category.layoutSeed);
      const map = new Map<string, ItemEntry>();
      for (const item of items) { const circle = circles.get(item.id); if (circle) map.set(item.id, {item, circle}); }
      itemCirclesRef.current.set(categoryId, map);
      schedulePaint();
    } catch { loadedItemsRef.current.delete(categoryId); }
  }

  function placeCategory(kid: UniverseCategory, circle: Circle, parentId: string | null, hole: Circle | undefined): void {
    const kind = bodyKind(kid);
    categoriesRef.current.set(kid.id, {category: kid, circle, parentId, kind, star: starCircle(kid, circle, hole?.r ?? circle.r * ORBIT_INNER)});
  }

  async function fetchChildrenFor(categoryId: string, signal?: AbortSignal): Promise<void> {
    const entry = categoriesRef.current.get(categoryId);
    const source = sourceRef.current;
    if (!entry || !source) { loadedChildrenRef.current.delete(categoryId); return; }
    try {
      const kids = await source.children(categoryId, signal);
      if (!mountedRef.current) return;
      const circles = packChildren(entry.circle, kids.map(kid => ({id: kid.id, mass: kid.mass})), entry.category.layoutSeed, undefined, CENTER_HOLE * Math.sqrt(Math.max(1, ...kids.map(kid => kid.mass))));
      const hole = circles.get(HOLE_KEY);
      // The parent's own documents orbit inside the reserved centre now that its size is known.
      if (hole && entry.kind === 'galaxy-star') entry.star = hole;
      for (const kid of kids) {
        const circle = circles.get(kid.id);
        if (circle) placeCategory(kid, circle, categoryId, undefined);
      }
      schedulePaint();
    } catch { loadedChildrenRef.current.delete(categoryId); }
  }

  async function fetchNearby(): Promise<void> {
    const source = sourceRef.current;
    if (!source) return;
    const candidates: FetchCandidate[] = [...categoriesRef.current.entries()].map(([id, entry]) => ({id, circle: entry.circle, starCircle: entry.star, childCount: entry.category.childCount, directCount: entry.category.directCount}));
    const {children, items} = pickFetchTargets(candidates, cameraRef.current, viewportRef.current, loadedChildrenRef.current, loadedItemsRef.current, MAX_FETCH);
    if (children.length === 0 && items.length === 0) return;
    const controller = new AbortController();
    fetchControllersRef.current.add(controller);
    for (const id of children) loadedChildrenRef.current.add(id);
    await Promise.all([...children.map(id => fetchChildrenFor(id, controller.signal)), ...items.map(id => fetchItemsFor(id, controller.signal))]);
    fetchControllersRef.current.delete(controller);
  }

  /** A1: flips the root's `data-moving` attribute directly (no React state/re-render — this can fire every
   * animation frame during a flight or inertia glide). CSS keyed off it turns off dot/label/button transitions
   * for the duration, so nothing "shuffles" mid-motion; it flips back once the camera is STILL_MS quiet. */
  function setMoving(value: boolean): void {
    if (movingRef.current === value) return;
    movingRef.current = value;
    rootElRef.current?.setAttribute('data-moving', value ? 'true' : 'false');
    if ((window.devicePixelRatio || 1) > 1) { resizeCanvas(); schedulePaint(); }
    if (!value) schedulePaint(); // one recompute now that the camera is still again
  }

  function markCameraChanged(): void {
    setMoving(true);
    if (stillTimerRef.current) clearTimeout(stillTimerRef.current);
    stillTimerRef.current = setTimeout(() => { stillTimerRef.current = null; setMoving(false); void fetchNearby(); }, STILL_MS);
  }

  function clearHoverHideTimer(): void {
    if (hoverHideTimerRef.current) { clearTimeout(hoverHideTimerRef.current); hoverHideTimerRef.current = null; }
  }

  /** Desktop: reveal the pill (no focus) while the pointer is over the top zone or the pill itself. */
  function revealSearch(): void {
    hoveringSearchRef.current = true;
    clearHoverHideTimer();
    if (!searchOpenRef.current) { searchOpenRef.current = true; setSearchOpen(true); }
  }

  /** Desktop: 600ms after the pointer leaves (or the input blurs), hide the pill if it is still empty and unfocused. */
  function scheduleAutoHide(): void {
    clearHoverHideTimer();
    hoverHideTimerRef.current = setTimeout(() => {
      hoverHideTimerRef.current = null;
      if (hoveringSearchRef.current || inputFocusedRef.current || queryRef.current.trim() !== '') return;
      searchOpenRef.current = false;
      setSearchOpen(false);
    }, HOVER_HIDE_MS);
  }

  function onSearchHoverLeave(): void {
    hoveringSearchRef.current = false;
    scheduleAutoHide();
  }

  /** Desktop: reveal the search pill and focus it, remembering what had focus so it can be restored on hide. */
  function openSearch(): void {
    if (!searchOpenRef.current) {
      const active = document.activeElement;
      searchPrevFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    searchOpenRef.current = true;
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  /** Hides the desktop pill again and returns focus to wherever it came from, or the viewport. */
  function closeSearch(): void {
    if (!searchOpenRef.current) return;
    searchOpenRef.current = false;
    setSearchOpen(false);
    clearHoverHideTimer();
    hoveringSearchRef.current = false;
    if (searchDebounceRef.current) { clearTimeout(searchDebounceRef.current); searchDebounceRef.current = null; }
    suggestControllerRef.current?.abort();
    suggestionsRef.current = [];
    setSuggestions([]);
    setHighlightIndex(-1);
    const prev = searchPrevFocusRef.current;
    searchPrevFocusRef.current = null;
    if (prev && document.contains(prev)) prev.focus();
    else containerRef.current?.focus();
  }

  function markActive(): void {
    touchedRef.current = true;
    setPillHidden(true);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setPillHidden(false), IDLE_MS);
  }

  /** `categoryId` undefined leaves the URL alone (the reader already wrote it); null means "wherever we landed". */
  function afterFly(categoryId: string | null | undefined): void {
    if (categoryId !== undefined) updateUrl(categoryId ?? currentCategoryId());
    markCameraChanged();
    void fetchNearby();
  }

  /** Returns a promise that resolves once the camera has actually arrived — a caller that re-centres or
   * focuses right after a fly (search hand-off does both) must await this, not just call it and move on:
   * the flight runs over several animation frames, and reading cameraRef.current before it settles would
   * capture a mid-flight scale, permanently losing the zoom-in (centreOn only pans, it never re-zooms). */
  function flyTo(circle: Circle, categoryId: string | null, margin = 0.8): Promise<void> {
    lastFitRef.current = {circle, margin};
    touchedRef.current = false;
    return glideTo(fitCircle(viewportRef.current, circle, margin), categoryId);
  }

  function glideTo(target: Camera, categoryId: string | null | undefined = null): Promise<void> {
    stopInertia();
    stopFlight();
    stopZoom();
    if (reducedMotionRef.current) {
      cameraRef.current = target;
      schedulePaint();
      afterFly(categoryId);
      return Promise.resolve();
    }
    const from = {...cameraRef.current};
    const duration = flightMs(from, target);
    const start = performance.now();
    return new Promise<void>(resolve => {
      flightResolveRef.current = resolve;
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        cameraRef.current = interpolate(from, target, t);
        schedulePaint();
        if (t < 1) { setMoving(true); flightRafRef.current = requestAnimationFrame(tick); }
        else { flightRafRef.current = null; flightResolveRef.current = null; afterFly(categoryId); resolve(); }
      };
      flightRafRef.current = requestAnimationFrame(tick);
    });
  }

  /** Wheel zoom eases toward its target over a few frames instead of jumping per notch. */
  function smoothZoom(logFactor: number, anchor: {x: number; y: number}): void {
    stopFlight();
    zoomAnchorRef.current = anchor;
    if (reducedMotionRef.current) {
      cameraRef.current = zoomAt(cameraRef.current, viewportRef.current, anchor, Math.exp(logFactor));
      schedulePaint();
      return;
    }
    zoomPendingRef.current = Math.max(-WHEEL_MAX_LOG, Math.min(WHEEL_MAX_LOG, zoomPendingRef.current + logFactor));
    if (zoomRafRef.current !== null) return;
    const tick = () => {
      const pending = zoomPendingRef.current;
      const step = Math.abs(pending) < 0.004 ? pending : pending * ZOOM_SMOOTHING;
      cameraRef.current = zoomAt(cameraRef.current, viewportRef.current, zoomAnchorRef.current, Math.exp(step));
      zoomPendingRef.current = pending - step;
      schedulePaint();
      markCameraChanged();
      if (Math.abs(zoomPendingRef.current) > 0.0005) zoomRafRef.current = requestAnimationFrame(tick);
      else { zoomRafRef.current = null; zoomPendingRef.current = 0; }
    };
    zoomRafRef.current = requestAnimationFrame(tick);
  }

  function zoomCentre(factor: number): void {
    const viewport = viewportRef.current;
    smoothZoom(Math.log(factor), {x: viewport.width / 2, y: viewport.height / 2});
    markCameraChanged();
    markActive();
  }

  // ---- Selection and navigation -------------------------------------------------------------------------

  /** Arrow keys move to the nearest rendered node in that direction and centre it; Enter then opens it. */
  function stepSelection(key: string): boolean {
    const nodes = [...buttonElsRef.current].map(([nodeKey, el]) => {
      const rect = el.getBoundingClientRect();
      return {key: nodeKey, el, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width};
    }).filter(node => node.width > 0);
    if (!nodes.length) return false;
    const viewport = viewportRef.current;
    const current = nodes.find(node => node.key === selectedKeyRef.current)
      ?? nodes.reduce((best, node) => Math.hypot(node.x - viewport.width / 2, node.y - viewport.height / 2) < Math.hypot(best.x - viewport.width / 2, best.y - viewport.height / 2) ? node : best);
    const next = current.key === selectedKeyRef.current ? directionalNode(nodes, current, key) : current;
    if (!next) return true;
    select(next.key);
    armedKeyRef.current = next.key;
    next.el.focus({preventScroll: true});
    const world = screenToWorld(cameraRef.current, viewport, {x: next.x, y: next.y});
    glideTo({...cameraRef.current, x: world.x, y: world.y}, null);
    return true;
  }

  function select(key: string | null): void {
    selectedKeyRef.current = key;
    schedulePaint();
  }

  function activateSelection(): void {
    const key = selectedKeyRef.current;
    if (!key) return;
    if (key.includes('::')) {
      const [categoryId, id] = splitItemKey(key);
      const entry = itemCirclesRef.current.get(categoryId)?.get(id);
      if (entry) openItem(entry.item, categoryId);
      return;
    }
    const entry = categoriesRef.current.get(key);
    if (!entry) return;
    if (entry.category.directCount > 0 && itemsOpen(screenRadius(entry.star, cameraRef.current), stageScale(viewportRef.current))) { void openStar(key); return; }
    flyTo(entry.circle, key);
  }

  function flyToParentOrRoot(): void {
    const id = currentCategoryId();
    if (!id) { flyTo(rootCircle(), null, 0.92); return; }
    const entry = categoriesRef.current.get(id);
    const parentId = entry?.parentId ?? null;
    const parentEntry = parentId ? categoriesRef.current.get(parentId) : null;
    flyTo(parentEntry ? parentEntry.circle : rootCircle(), parentId, parentEntry ? 0.8 : 0.92);
  }

  function showNotFound(): void {
    setNotFound(true);
    if (notFoundTimerRef.current) clearTimeout(notFoundTimerRef.current);
    notFoundTimerRef.current = setTimeout(() => setNotFound(false), NOT_FOUND_MS);
  }

  function highlightItem(id: string): void {
    highlightRef.current = {itemId: id, until: performance.now() + HIGHLIGHT_MS};
    schedulePaint();
    setTimeout(() => schedulePaint(), HIGHLIGHT_MS);
  }

  // ---- Reader ---------------------------------------------------------------------------------------------

  /** `camera` moves the view only for arrivals from search or a link; a tap opens the document where the view already is. */
  function openReader(target: ReaderTarget, camera: Camera | null, push: boolean): void {
    if (!readerRef.current) returnCameraRef.current = camera ? {...cameraRef.current} : null;
    readerRef.current = target;
    setReader(target);
    relatedRef.current = new Map();
    // A double tap that opened the document must not leave the article text selected.
    window.getSelection()?.removeAllRanges();
    if (push) { updateUrl(target.categoryId, target, true); readerPushesRef.current += 1; }
    else updateUrl(target.categoryId, target);
    if (camera) glideTo(camera, undefined);
    else schedulePaint();
  }

  function closeReader(viaHistory: boolean): void {
    const open = readerRef.current;
    if (!open) return;
    readerRef.current = null;
    setReader(null);
    relatedRef.current = new Map();
    const back = returnCameraRef.current;
    returnCameraRef.current = null;
    if (viaHistory && readerPushesRef.current > 0) { readerPushesRef.current -= 1; window.history.back(); }
    else updateUrl(open.categoryId, null);
    if (back) glideTo(back, null); else schedulePaint();
    const el = selectedKeyRef.current ? buttonElsRef.current.get(selectedKeyRef.current) : null;
    el?.focus({preventScroll: true});
  }

  function openItem(item: UniverseItem, categoryId: string, push = true): void {
    const category = categoriesRef.current.get(categoryId);
    if (!item.versionId || !category) { window.location.assign(item.href); return; }
    select(itemKey(categoryId, item.id));
    openReader({kind: 'doc', versionId: item.versionId, role: 'planet', categoryId, categoryLabel: category.category.label, planetCount: category.category.directCount}, null, push);
  }

  async function openStar(categoryId: string, push = true): Promise<void> {
    const entry = categoriesRef.current.get(categoryId);
    if (!entry) return;
    select(categoryId);
    const doc = await fetchStarDoc(categoryId).catch(() => null);
    if (!mountedRef.current) return;
    const common = {categoryId, categoryLabel: entry.category.label, planetCount: entry.category.directCount};
    const target: ReaderTarget = doc?.versionId ? {kind: 'doc', versionId: doc.versionId, role: 'star', ...common} : {kind: 'star-missing', ...common};
    openReader(target, null, push);
  }

  /** From the reader: open another version (an earlier one, a related record). Camera stays; the field marks it if it is here. */
  function openVersionFromReader(versionId: string): void {
    const open = readerRef.current;
    if (!open) return;
    const category = categoriesRef.current.get(open.categoryId);
    const target: ReaderTarget = {kind: 'doc', versionId, role: 'planet', categoryId: open.categoryId, categoryLabel: category?.category.label ?? '', planetCount: category?.category.directCount ?? 0};
    readerRef.current = target;
    setReader(target);
    updateUrl(open.categoryId, target, true);
    readerPushesRef.current += 1;
  }

  const onNeighbors = useCallback((neighbors: ReaderNeighbor[]) => {
    relatedRef.current = new Map(neighbors.map(n => [n.versionId, relationLabel(n.predicate)]));
    schedulePaint();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Open what a URL names (a document or a star without one) after the field around it is placed. */
  async function restoreReader(params: URLSearchParams, signal: AbortSignal): Promise<void> {
    const source = sourceRef.current;
    if (!source) return;
    const doc = params.get('doc'), star = params.get('star');
    if (star) {
      const entry = categoriesRef.current.get(star);
      if (!entry) return;
      cameraRef.current = fitCircle(viewportRef.current, entry.star, 0.8);
      await fetchItemsFor(star, signal);
      if (signal.aborted) return;
      await openStar(star, false);
      return;
    }
    if (!doc) return;
    const path = await source.pathTo(doc, signal);
    const categoryId = path[path.length - 1];
    const entry = categoryId ? categoriesRef.current.get(categoryId) : undefined;
    if (!entry || signal.aborted) return;
    cameraRef.current = fitCircle(viewportRef.current, entry.star, 0.8);
    await fetchItemsFor(categoryId, signal);
    if (signal.aborted) return;
    const items = itemCirclesRef.current.get(categoryId);
    const found = items ? [...items.values()].find(candidate => candidate.item.versionId === doc) : undefined;
    const starDoc = starDocsRef.current.get(categoryId);
    if (found) openItem(found.item, categoryId, false);
    else if (starDoc && starDoc.versionId === doc) await openStar(categoryId, false);
    else openReader({kind: 'doc', versionId: doc, role: 'planet', categoryId, categoryLabel: entry.category.label, planetCount: entry.category.directCount}, null, false);
  }

  /** Choosing a suggestion (Enter or click) flies to the body and selects it, the same way the /search deep
   * link does — it never opens the reader. Enter again (now that the body is selected) or the usual double
   * tap opens it from there, same as any other planet or star. */
  /** Hides the search pill completely after a suggestion (or a ?q= deep link) hands off to a selected body:
   * closes the suggestion list, clears the typed query, blurs the input and drops the pill — unlike
   * closeSearch(), it does not restore focus to wherever it came from, since focusSelectedBody() below is
   * about to move focus to the body itself. */
  function hideSearchAfterHandoff(): void {
    if (searchDebounceRef.current) { clearTimeout(searchDebounceRef.current); searchDebounceRef.current = null; }
    searchControllerRef.current?.abort();
    suggestControllerRef.current?.abort();
    suggestionsRef.current = [];
    setSuggestionsBoth([]);
    setHighlightIndex(-1);
    clearHoverHideTimer();
    hoveringSearchRef.current = false;
    searchOpenRef.current = false;
    setSearchOpen(false);
    queryRef.current = '';
    setQuery('');
    searchPrevFocusRef.current = null;
    searchInputRef.current?.blur();
  }

  /** Moves keyboard focus to a selected body's button once it exists in the DOM. The DOM only gains new
   * buttons after commitDom's debounce, so a body picked from search may not be mounted yet: retry a few
   * times rather than focus nothing (or the wrong element). */
  function focusBody(key: string, attempts = 20): void {
    const el = buttonElsRef.current.get(key);
    if (el) { el.focus({preventScroll: true}); return; }
    if (attempts <= 0 || !mountedRef.current) return;
    setTimeout(() => focusBody(key, attempts - 1), DOM_DEBOUNCE_MS);
  }

  async function openSearchResult(node: SpatialNode, categoryId: string): Promise<void> {
    if (node.target.kind !== 'version') return;
    const versionId = node.target.id;
    const entry = categoryId ? categoriesRef.current.get(categoryId) : undefined;
    if (!entry) { showNotFound(); return; }
    if (readerRef.current) closeReader(true);
    // Await the flight itself, not just the item fetch: on a warm cache fetchItemsFor can resolve before the
    // multi-frame flight animation does, and centreOn below only pans — reading the camera mid-flight would
    // freeze it at a partial zoom and the item would never actually open.
    await Promise.all([flyTo(entry.star, categoryId), fetchItemsFor(categoryId)]);
    if (!mountedRef.current) return;
    const items = itemCirclesRef.current.get(categoryId);
    const found = items ? [...items.values()].find(candidate => candidate.item.versionId === versionId) : undefined;
    if (found) {
      const key = itemKey(categoryId, found.item.id);
      select(key);
      centreOn(found.circle);
      highlightItem(found.item.id);
      hideSearchAfterHandoff();
      focusBody(key);
      return;
    }
    const starDoc = starDocsRef.current.get(categoryId);
    if (starDoc && starDoc.versionId === versionId) { select(categoryId); hideSearchAfterHandoff(); focusBody(categoryId); return; }
    // Neither a fetched planet nor the star's own document matched (a race with a slow fetch): the fly
    // already landed on the right star, so at least select it rather than opening anything.
    select(categoryId);
    hideSearchAfterHandoff();
    focusBody(categoryId);
  }

  function setSuggestionsBoth(list: SuggestRow[]): void {
    suggestionsRef.current = list;
    setSuggestions(list);
  }

  async function chooseSuggestion(pick: SuggestRow): Promise<void> {
    if (searchDebounceRef.current) { clearTimeout(searchDebounceRef.current); searchDebounceRef.current = null; }
    setSuggestionsBoth([]);
    setHighlightIndex(-1);
    // Choosing a suggestion flies to the body, selects it, and hands focus to it — openSearchResult hides
    // the pill entirely (query cleared, list closed, input blurred) so the next Enter opens the reader
    // instead of re-running the search.
    await openSearchResult(pick.node, pick.categoryId);
  }

  /** The suggestion dropdown's search: reuses loadSpatialSearch (one call per debounce), resolving each
   * hit's star name via source.pathTo, which is an in-memory lookup once the home page has loaded — no
   * extra network calls beyond the search itself. */
  async function runSuggest(trimmed: string): Promise<void> {
    const source = sourceRef.current;
    if (!source) return;
    suggestControllerRef.current?.abort();
    const controller = new AbortController();
    suggestControllerRef.current = controller;
    try {
      const result = await loadSpatialSearch(trimmed, {scope: 'current', include_context: false}, controller.signal);
      if (controller.signal.aborted || !mountedRef.current) return;
      const versionNodes = result.nodes.filter((node): node is SpatialNode & {target: {kind: 'version'; id: string}} => node.target.kind === 'version').slice(0, SUGGEST_MAX_RESULTS);
      const rows = await Promise.all(versionNodes.map(async node => {
        const path = await source.pathTo(node.target.id, controller.signal).catch(() => []);
        const categoryId = path[path.length - 1] ?? '';
        const starLabel = categoryId ? categoriesRef.current.get(categoryId)?.category.label ?? '' : '';
        return {node, categoryId, starLabel};
      }));
      if (controller.signal.aborted || !mountedRef.current) return;
      setSuggestionsBoth(rows);
      setHighlightIndex(-1);
    } catch { if (!controller.signal.aborted) setSuggestionsBoth([]); }
  }

  /** The url-report card's own debounced lookup: `GET /url-report?url=` for the query the box currently
   * holds, guarded against races the same way runSuggest is (abort the previous call, ignore a stale
   * response). Never a truth verdict either — see the ArchiveCheck/QuoteCheck comments in contracts/types.ts. */
  async function runUrlReport(url: string): Promise<void> {
    urlReportControllerRef.current?.abort();
    const controller = new AbortController();
    urlReportControllerRef.current = controller;
    setUrlReport({status: 'loading', report: null, url});
    try {
      const report = await apiGet<UrlReport>(`/url-report?url=${encodeURIComponent(url)}`, controller.signal);
      if (controller.signal.aborted || !mountedRef.current) return;
      setUrlReport({status: 'ready', report, url});
    } catch {
      if (!controller.signal.aborted) setUrlReport({status: 'error', report: null, url});
    }
  }

  /** Debounced entry point for the suggestion list (cleared below the minimum character count) and, when
   * the query looks like a URL (owner decision 2026-09-28), for the url-report card instead — same debounce
   * timing, and the two are mutually exclusive: a URL query never runs the record search. */
  function scheduleSuggest(text: string): void {
    if (searchDebounceRef.current) { clearTimeout(searchDebounceRef.current); searchDebounceRef.current = null; }
    setUrlCardClosed(false);
    const trimmed = text.trim();
    const asUrl = isUrlQuery(trimmed);
    if (asUrl) {
      suggestControllerRef.current?.abort();
      setSuggestionsBoth([]);
      setHighlightIndex(-1);
      searchDebounceRef.current = setTimeout(() => { searchDebounceRef.current = null; void runUrlReport(asUrl); }, SUGGEST_DEBOUNCE_MS);
      return;
    }
    if (urlReport !== null) { urlReportControllerRef.current?.abort(); setUrlReport(null); }
    if (trimmed.length < SUGGEST_MIN_CHARS) {
      suggestControllerRef.current?.abort();
      setSuggestionsBoth([]);
      setHighlightIndex(-1);
      return;
    }
    searchDebounceRef.current = setTimeout(() => { searchDebounceRef.current = null; void runSuggest(trimmed); }, SUGGEST_DEBOUNCE_MS);
  }

  async function runSearch(text: string): Promise<void> {
    const trimmed = text.trim();
    const source = sourceRef.current;
    if (!trimmed || !source) return;
    searchControllerRef.current?.abort();
    const controller = new AbortController();
    searchControllerRef.current = controller;
    try {
      const result = await loadSpatialSearch(trimmed, {scope: 'current', include_context: false}, controller.signal);
      const hit = result.nodes.find(node => node.target.kind === 'version');
      const versionId = hit && hit.target.kind === 'version' ? hit.target.id : null;
      const path = versionId ? await source.pathTo(versionId, controller.signal) : [];
      const categoryId = path[path.length - 1];
      const entry = categoryId ? categoriesRef.current.get(categoryId) : undefined;
      if (!hit || !entry) { showNotFound(); return; }
      if (readerRef.current) closeReader(true);
      // See openSearchResult: await the flight itself so centreOn below never freezes a mid-flight zoom.
      await Promise.all([flyTo(entry.star, categoryId), fetchItemsFor(categoryId, controller.signal)]);
      if (!mountedRef.current) return;
      const items = itemCirclesRef.current.get(categoryId);
      const found = items ? [...items.values()].find(candidate => candidate.item.versionId === versionId) : undefined;
      if (found) {
        const key = itemKey(categoryId, found.item.id);
        select(key);
        centreOn(found.circle);
        hideSearchAfterHandoff();
        focusBody(key);
      }
      highlightItem(hit.key);
    } catch { if (!controller.signal.aborted) showNotFound(); }
  }

  // Newly mounted buttons have no size until the next paint positions them.
  useEffect(() => { schedulePaint(); }, [domCategoryIds, domItemKeys]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { schedulePaint(); }, [reader]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Mount: build the source, place the roots, honour deep links, then keep fetching as the camera settles.
  useEffect(() => {
    mountedRef.current = true;
    const container = containerRef.current;
    if (!container) return;
    reducedMotionRef.current = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Touch pointers and narrow screens keep the search pill docked (as before); a fine pointer on >=850px hides it by default.
    const narrowQuery = matchMedia('(pointer: coarse), (max-width: 849.98px)');
    const onNarrowChange = () => { alwaysVisibleRef.current = narrowQuery.matches; setAlwaysVisible(narrowQuery.matches); };
    onNarrowChange();
    narrowQuery.addEventListener('change', onNarrowChange);
    viewportRef.current = {width: container.clientWidth, height: container.clientHeight};
    resizeCanvas();
    const source = createTopicSource();
    sourceRef.current = source;
    const controller = new AbortController();
    fetchControllersRef.current.add(controller);

    (async () => {
      try {
        const roots = await source.children(null, controller.signal);
        if (!mountedRef.current) return;
        const circles = packChildren(rootCircle(), roots.map(cat => ({id: cat.id, mass: cat.mass})), 0, CENTER_CATEGORY_ID);
        for (const cat of roots) { const circle = circles.get(cat.id); if (circle) placeCategory(cat, circle, null, undefined); }
        if (containerRef.current) { viewportRef.current = {width: containerRef.current.clientWidth, height: containerRef.current.clientHeight}; resizeCanvas(); }
        const params = new URLSearchParams(window.location.search);
        // /versions/:id server-renders the universe with the document's id in the path, not the query
        // string: fold it in here as if it had arrived as ?doc=, the same deep-link shape the field already reads.
        if (initialDoc && !params.has('doc') && !params.has('star')) params.set('doc', initialDoc);
        const target = params.get('c');
        const targetEntry = target ? categoriesRef.current.get(target) : null;
        // With no explicit target, open on the "Morum" star itself (its own field guide), framed close enough
        // that its planet names are already readable — the same fit used when a star is entered directly.
        const morumEntry = !targetEntry
          ? categoriesRef.current.get(CENTER_CATEGORY_ID) ?? [...categoriesRef.current.values()].find(entry => entry.category.label === 'Morum')
          : null;
        const fit = targetEntry
          ? {circle: targetEntry.circle, margin: 0.8}
          : morumEntry
            ? {circle: morumEntry.star, margin: 0.8}
            : {circle: rootCircle(), margin: 0.92};
        cameraRef.current = fitCircle(viewportRef.current, fit.circle, fit.margin);
        lastFitRef.current = fit;
        schedulePaint();
        markCameraChanged();
        await restoreReader(params, controller.signal);
        schedulePaint();
        // /search redirects here with ?q=: fill the pill and run the same search a typed query would.
        const initialQuery = params.get('q');
        if (initialQuery && initialQuery.trim()) {
          openSearch();
          setQuery(initialQuery);
          void runSearch(initialQuery);
        }
      } catch (error) {
        // Roots stay empty; nothing to place. An aborted load (React's dev double-mount) is expected.
        if (!(error instanceof DOMException && error.name === 'AbortError')) console.error(error);
      }
    })();

    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as {__universe?: unknown}).__universe = () => ({armed: armedKeyRef.current, selected: selectedKeyRef.current, camera: cameraRef.current, viewport: viewportRef.current, categories: [...categoriesRef.current.values()].map(entry => ({id: entry.category.id, circle: entry.circle, star: entry.star})), fit: lastFitRef.current});
    }
    const onResize = () => {
      if (!containerRef.current) return;
      viewportRef.current = {width: containerRef.current.clientWidth, height: containerRef.current.clientHeight};
      resizeCanvas();
      // Before the visitor has moved anything (or while the pane was still 0×0), a resize re-fits the same view.
      const fit = lastFitRef.current;
      if (fit && !touchedRef.current && viewportRef.current.width > 0 && viewportRef.current.height > 0 && !readerRef.current) {
        cameraRef.current = fitCircle(viewportRef.current, fit.circle, fit.margin);
        markCameraChanged();
      }
      schedulePaint();
    };
    window.addEventListener('resize', onResize);
    // A tab that loads in the background gets no animation frames: when it becomes visible, paint the
    // current camera and let nearby bodies load, so the first view is never a stale frame from before the fit.
    const onVisible = () => { if (document.visibilityState === 'visible') { schedulePaint(); markCameraChanged(); } };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    // A tab opened in the background can change size without a window resize event.
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    // B §4: the label keep-out follows the chrome's actual measured height (it grows when the intro
    // paragraph is showing) instead of a fixed guess.
    const chromeObserver = new ResizeObserver(entries => {
      const height = entries[0]?.contentRect.height;
      if (height) { chromeHeightRef.current = Math.round(height) + CHROME_MEASURE_MARGIN_PX; schedulePaint(); }
    });
    if (chromeRef.current) chromeObserver.observe(chromeRef.current);

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (readerRef.current) return;
      const rect = container.getBoundingClientRect();
      const anchor = {x: event.clientX - rect.left, y: event.clientY - rect.top};
      // Trackpad pinch arrives as a wheel with ctrlKey: follow the fingers directly. Notches and two-finger scroll ease.
      if (event.ctrlKey) {
        stopFlight();
        cameraRef.current = zoomAt(cameraRef.current, viewportRef.current, anchor, Math.exp(-event.deltaY * 0.01));
        schedulePaint();
      } else {
        const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * viewportRef.current.height : event.deltaY;
        smoothZoom(-delta * WHEEL_STEP, anchor);
      }
      markCameraChanged();
      markActive();
    };
    container.addEventListener('wheel', onWheel, {passive: false});

    const pinchInfo = (event: TouchEvent): PinchState => {
      const rect = container.getBoundingClientRect();
      const [a, b] = [event.touches[0], event.touches[1]];
      return {dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), mid: {x: (a.clientX + b.clientX) / 2 - rect.left, y: (a.clientY + b.clientY) / 2 - rect.top}};
    };
    const onTouchStart = (event: TouchEvent) => { if (event.touches.length === 2) { stopFlight(); stopInertia(); stopZoom(); pinchRef.current = pinchInfo(event); } };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !pinchRef.current) return;
      event.preventDefault();
      const next = pinchInfo(event);
      const factor = pinchRef.current.dist > 0 ? next.dist / pinchRef.current.dist : 1;
      cameraRef.current = zoomAt(cameraRef.current, viewportRef.current, pinchRef.current.mid, factor);
      cameraRef.current = panBy(cameraRef.current, next.mid.x - pinchRef.current.mid.x, next.mid.y - pinchRef.current.mid.y);
      pinchRef.current = next;
      schedulePaint();
      markCameraChanged();
      markActive();
    };
    const onTouchEnd = (event: TouchEvent) => { if (event.touches.length < 2) pinchRef.current = null; };
    container.addEventListener('touchstart', onTouchStart, {passive: true});
    container.addEventListener('touchmove', onTouchMove, {passive: false});
    container.addEventListener('touchend', onTouchEnd);
    container.addEventListener('touchcancel', onTouchEnd);

    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const inField = target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
      // No search while a document is open: `/` and Cmd/Ctrl+K do nothing until the reader closes. `/` is still
      // claimed (preventDefault) so the site shell's own search dialog does not open over the reader either.
      if (event.key === '/' && !inField) { event.preventDefault(); if (!readerRef.current) openSearch(); return; }
      if (!inField && !readerRef.current && !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); return; }
      if (inField || event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); if (readerRef.current) closeReader(true); else flyToParentOrRoot(); return; }
      // The reader owns every other key while it is open (its own column cursor for the arrows, Enter to
      // activate, Space/PageUp/PageDown to page) via its own window keydown listener — nothing left to do here.
      if (readerRef.current) return;
      if (event.key === 'Enter') { event.preventDefault(); activateSelection(); return; }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomCentre(KEY_ZOOM); return; }
      if (event.key === '-') { event.preventDefault(); zoomCentre(1 / KEY_ZOOM); return; }
      if (!event.key.startsWith('Arrow')) return;
      event.preventDefault();
      if (!event.shiftKey && stepSelection(event.key)) return;
      const viewport = viewportRef.current;
      const dx = event.key === 'ArrowLeft' ? viewport.width * ARROW_STEP : event.key === 'ArrowRight' ? -viewport.width * ARROW_STEP : 0;
      const dy = event.key === 'ArrowUp' ? viewport.height * ARROW_STEP : event.key === 'ArrowDown' ? -viewport.height * ARROW_STEP : 0;
      cameraRef.current = panBy(cameraRef.current, dx, dy);
      schedulePaint();
      markCameraChanged();
      markActive();
    };
    window.addEventListener('keydown', onKey);

    // Back closes the reader (or reopens it when going forward); the camera returns to where the reader was opened.
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const wantsReader = params.has('doc') || params.has('star');
      if (!wantsReader && readerRef.current) { closeReader(false); return; }
      if (wantsReader) {
        const key = params.get('doc') ? `doc:${params.get('doc')}` : `star:${params.get('star')}`;
        if (readerRef.current && readerTargetKey(readerRef.current) === key) return;
        void restoreReader(params, new AbortController().signal);
      }
    };
    window.addEventListener('popstate', onPopState);

    return () => {
      mountedRef.current = false;
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      resizeObserver.disconnect();
      chromeObserver.disconnect();
      narrowQuery.removeEventListener('change', onNarrowChange);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPopState);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      // Reset, not just cancel: React's dev double-mount reruns this effect and schedulePaint checks for null.
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      stopFlight();
      stopInertia();
      stopZoom();
      if (stillTimerRef.current) clearTimeout(stillTimerRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (notFoundTimerRef.current) clearTimeout(notFoundTimerRef.current);
      if (domTimerRef.current) clearTimeout(domTimerRef.current);
      for (const c of fetchControllersRef.current) c.abort();
      searchControllerRef.current?.abort();
      urlReportControllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Pointer input ------------------------------------------------------------------------------------

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    activePointersRef.current.add(event.pointerId);
    if (activePointersRef.current.size > 1) { pointerRef.current = null; return; }
    stopFlight();
    stopInertia();
    stopZoom();
    pointerRef.current = {id: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, lastAt: performance.now(), moved: false, samples: []};
    markActive();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    const now = performance.now();
    const dx = event.clientX - pointer.lastX, dy = event.clientY - pointer.lastY, dt = Math.max(now - pointer.lastAt, 1);
    pointer.samples.push({dx, dy, dt, at: now});
    if (pointer.samples.length > 3) pointer.samples.shift();
    pointer.lastX = event.clientX; pointer.lastY = event.clientY; pointer.lastAt = now;
    const wasMoved = pointer.moved;
    pointer.moved ||= Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) >= DRAG_THRESHOLD;
    if (pointer.moved && !wasMoved) { try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* already released */ } }
    if (!pointer.moved) return;
    cameraRef.current = panBy(cameraRef.current, dx, dy);
    schedulePaint();
    markCameraChanged();
    markActive();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    activePointersRef.current.delete(event.pointerId);
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    pointerRef.current = null;
    suppressClickRef.current = pointer.moved;
    if (pointer.moved) setTimeout(() => { suppressClickRef.current = false; }, 0);
    if (cancelled || !pointer.moved || reducedMotionRef.current) return;
    const now = performance.now();
    const recent = pointer.samples.filter(sample => now - sample.at <= 80);
    let vx = 0, vy = 0;
    if (recent.length) {
      let sumDx = 0, sumDy = 0, sumDt = 0;
      for (const sample of recent) { sumDx += sample.dx; sumDy += sample.dy; sumDt += sample.dt; }
      if (sumDt > 0) { vx = (sumDx / sumDt) * 16; vy = (sumDy / sumDt) * 16; }
    }
    const speed = Math.hypot(vx, vy);
    if (speed > MAX_FLICK) { vx = (vx / speed) * MAX_FLICK; vy = (vy / speed) * MAX_FLICK; }
    velocityRef.current = {x: vx, y: vy};
    const tick = () => {
      const {velocity, delta} = inertiaStep(velocityRef.current, 16);
      cameraRef.current = panBy(cameraRef.current, delta.x, delta.y);
      velocityRef.current = velocity;
      schedulePaint();
      markCameraChanged();
      if (velocity.x !== 0 || velocity.y !== 0) inertiaRafRef.current = requestAnimationFrame(tick);
      else inertiaRafRef.current = null;
    };
    inertiaRafRef.current = requestAnimationFrame(tick);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Double-click on the field zooms in around the pointer; on a body it opens it. */
  const onDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest('button')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const anchor = {x: event.clientX - rect.left, y: event.clientY - rect.top};
    const target = zoomAt(cameraRef.current, viewportRef.current, anchor, DOUBLE_CLICK_ZOOM);
    glideTo({...target, scale: clampScale(target.scale)}, null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Centre a body on screen at the current zoom, so a first tap only brings it closer and never opens anything. */
  function centreOn(circle: Circle): void {
    glideTo({...cameraRef.current, x: circle.x, y: circle.y}, null);
  }

  const onCategoryClick = useCallback((id: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    if (suppressClickRef.current) return;
    const entry = categoriesRef.current.get(id);
    if (!entry) return;
    const wasArmed = armedKeyRef.current === id;
    armedKeyRef.current = id;
    select(id);
    const camera = cameraRef.current, viewport = viewportRef.current;
    const open = entry.category.directCount > 0 && itemsOpen(screenRadius(entry.star, camera), stageScale(viewport));
    if (open) {
      // Inside an open star, its name at the centre is the description: one tap selects it, a second (or a double tap) opens it.
      const field = containerRef.current?.getBoundingClientRect() ?? {left: 0, top: 0};
      const centre = worldToScreen(camera, viewport, entry.star);
      const distance = Math.hypot(event.clientX - field.left - centre.x, event.clientY - field.top - centre.y);
      if (distance <= screenRadius(entry.star, camera) * ORBIT_INNER) {
        if (wasArmed || event.detail >= 2) void openStar(id);
        else centreOn(entry.star);
        return;
      }
      if (event.detail >= 2) return;
      flyTo(entry.star, id);
      return;
    }
    flyTo(entry.circle, id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onItemClick = useCallback((item: UniverseItem, categoryId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    if (suppressClickRef.current) return;
    const key = itemKey(categoryId, item.id);
    // First tap: select and centre the planet (its title shows). Second tap, double tap or Enter: read it.
    if (armedKeyRef.current !== key && event.detail < 2) {
      armedKeyRef.current = key;
      select(key);
      const circle = itemCirclesRef.current.get(categoryId)?.get(item.id)?.circle;
      if (circle) centreOn(circle);
      return;
    }
    openItem(item, categoryId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      // Escape closes the suggestion list first (or the url-report card); a second Escape hides the pill
      // (desktop only — the docked pill stays).
      if (suggestionsRef.current.length > 0) { setSuggestionsBoth([]); setHighlightIndex(-1); return; }
      if (isUrlQuery(query.trim()) && !urlCardClosed) { setUrlCardClosed(true); return; }
      if (!alwaysVisible) closeSearch();
      return;
    }
    if (event.key === 'ArrowDown' && suggestionsRef.current.length > 0) {
      event.preventDefault();
      setHighlightIndex(index => (index + 1) % suggestionsRef.current.length);
      return;
    }
    if (event.key === 'ArrowUp' && suggestionsRef.current.length > 0) {
      event.preventDefault();
      setHighlightIndex(index => (index <= 0 ? suggestionsRef.current.length - 1 : index - 1));
      return;
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || composing) return;
    event.preventDefault();
    if (!urlCardClosed && isUrlQuery(query.trim())) {
      const first = urlReport?.status === 'ready' ? urlReport.report?.citations[0] : null;
      const href = first ? citationHref(first) : null;
      if (href) window.location.assign(href);
      return;
    }
    const list = suggestionsRef.current;
    if (list.length > 0) { void chooseSuggestion(list[highlightIndex >= 0 && highlightIndex < list.length ? highlightIndex : 0]); return; }
    const trimmed = query.trim();
    if (trimmed.length >= SUGGEST_MIN_CHARS) {
      void runSuggest(trimmed).then(() => {
        const found = suggestionsRef.current;
        if (found.length > 0) void chooseSuggestion(found[0]); else showNotFound();
      });
    }
  }

  // Touch/narrow: docked pill, hidden only while idle-and-unfocused (unchanged). Desktop: hidden until the pointer
  // reaches the bottom edge or the pill is opened explicitly. Never rendered while a document is open.
  const dockHidden = alwaysVisible ? pillHidden && !inputFocused : !searchOpen;
  const suggestListId = 'universe-suggestions';

  function renderSuggestions() {
    return (
      <ul className="universe-suggestions" id={suggestListId} role="listbox">
        {suggestions.map((item, index) => (
          <li key={item.node.key} id={`universe-suggestion-${index}`} role="option" aria-selected={index === highlightIndex}
            className="universe-suggestion" data-highlighted={index === highlightIndex}
            onMouseEnter={() => setHighlightIndex(index)}
            onMouseDown={event => event.preventDefault()}
            onClick={() => void chooseSuggestion(item)}>
            <span className="universe-suggestion-title">{item.node.title?.trim() || '(제목 없음)'}</span>
            {item.starLabel && <span className="universe-suggestion-star">{item.starLabel}</span>}
            {item.node.snippet && <span className="universe-suggestion-snippet">{item.node.snippet}</span>}
          </li>
        ))}
      </ul>
    );
  }

  /** Quote-check counts, `found` combining every found_* bucket (owner decision 2026-09-28: the
   * distinction matters to the checker, not to a person glancing at the card). */
  function quoteFoundCount(report: UrlReport): number {
    const q = report.counts.quote_states;
    return q.found_exact + q.found_normalized + q.found_fragments;
  }

  function renderUrlCard(displayUrl: string) {
    const state = urlReport;
    const report = state?.status === 'ready' ? state.report : null;
    const encoded = encodeURIComponent(displayUrl);
    return (
      <div className="universe-suggestions universe-url-card" id={suggestListId} role="status">
        <p className="universe-url-header">{displayUrl}</p>
        {(!state || state.status === 'loading') && <p className="universe-url-status">조회 중…</p>}
        {state?.status === 'error' && <p className="universe-url-status">조회하지 못했습니다</p>}
        {report && (
          <>
            <p className="universe-url-status">
              {report.counts.sources > 0 || report.counts.citations > 0 ? '확인 기록 있음' : '확인된 적 없음 — 문제없음이라는 뜻은 아닙니다'}
            </p>
            {(report.counts.sources > 0 || report.counts.citations > 0) && (
              <>
                <p className="universe-url-line">출처 {report.counts.sources} · 인용 {report.counts.citations} · 정정 {report.counts.corrections}</p>
                <p className="universe-url-line">인용문 대조 found {quoteFoundCount(report)} · not_found {report.counts.quote_states.not_found}</p>
                {report.counts.archive_states && (
                  <p className="universe-url-line">
                    보관본 대조 found {report.counts.archive_states.found} · not_found {report.counts.archive_states.not_found} · 스냅샷 없음 {report.counts.archive_states.no_snapshot}
                  </p>
                )}
                {report.citations.slice(0, 2).map(citation => {
                  const href = citationHref(citation);
                  const body = (
                    <>
                      <span className="universe-url-citation-quote">{citation.quote || citation.explanation}</span>
                      <span className="universe-url-citation-title">{citation.title?.trim() || '(제목 없음)'}</span>
                    </>
                  );
                  return (
                    <p className="universe-url-citation" key={citation.evidence_id}>
                      {href ? <a href={href}>{body}</a> : body}
                    </p>
                  );
                })}
              </>
            )}
          </>
        )}
        <p className="universe-url-line">
          <a href={`/api/v2/url-report?url=${encoded}`} target="_blank" rel="noreferrer">API로 보기</a>
        </p>
      </div>
    );
  }

  function renderSearchPill() {
    const urlQuery = urlCardClosed ? null : isUrlQuery(query.trim());
    return (
      <div className="universe-search" data-hidden={dockHidden}
        onMouseEnter={alwaysVisible ? undefined : revealSearch}
        onMouseLeave={alwaysVisible ? undefined : onSearchHoverLeave}>
        <label className="universe-sr-only" htmlFor="universe-query">우주 검색</label>
        <input id="universe-query" ref={searchInputRef} value={query} autoComplete="off" placeholder="검색 또는 URL"
          role="combobox" aria-expanded={suggestions.length > 0 || urlQuery !== null} aria-controls={suggestListId} aria-autocomplete="list"
          aria-activedescendant={highlightIndex >= 0 ? `universe-suggestion-${highlightIndex}` : undefined}
          onChange={event => { const value = event.target.value; queryRef.current = value; setQuery(value); scheduleSuggest(value); }}
          onFocus={() => {
            inputFocusedRef.current = true;
            setInputFocused(true);
            clearHoverHideTimer();
            if (!searchOpenRef.current) { searchOpenRef.current = true; setSearchOpen(true); }
          }}
          onBlur={() => {
            inputFocusedRef.current = false;
            setInputFocused(false);
            setSuggestionsBoth([]);
            setHighlightIndex(-1);
            urlReportControllerRef.current?.abort();
            setUrlReport(null);
            setUrlCardClosed(false);
            if (!alwaysVisible) scheduleAutoHide();
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={event => { setComposing(false); const value = event.currentTarget.value; queryRef.current = value; setQuery(value); scheduleSuggest(value); }}
          onKeyDown={onSearchKeyDown} />
        {urlQuery ? renderUrlCard(urlQuery) : suggestions.length > 0 && renderSuggestions()}
      </div>
    );
  }

  function renderCategoryButton(id: string) {
    const entry = categoriesRef.current.get(id);
    if (!entry) return null;
    return (
      <button key={id} type="button" className="universe-category" aria-label={`${entry.category.label}, ${entry.kind === 'galaxy' ? '은하' : entry.kind === 'galaxy-star' ? '항성이 있는 은하' : '항성'}`}
        ref={el => bindButton(id, el)} onClick={event => onCategoryClick(id, event)} onFocus={() => select(id)}>
        <span className="universe-category-label">{entry.category.label}</span>
        <span className="universe-reticle" aria-hidden="true" />
      </button>
    );
  }

  function renderItemButton(key: string) {
    const [categoryId, id] = splitItemKey(key);
    const entry = itemCirclesRef.current.get(categoryId)?.get(id);
    if (!entry) return null;
    return (
      <button key={key} type="button" className="universe-item" aria-label={itemLabel(entry.item) || '기록'}
        ref={el => bindButton(key, el)} onClick={event => onItemClick(entry.item, categoryId, event)} onFocus={() => select(key)}>
        <span className="universe-item-dot" aria-hidden="true" />
        <span className="universe-reticle" aria-hidden="true" />
        <span className="universe-item-title">{itemLabel(entry.item)}</span>
      </button>
    );
  }

  return (
    <div ref={rootElRef} className="universe-root" data-reading={reader !== null} data-moving="false">
      <canvas ref={canvasRef} className="universe-canvas" aria-hidden="true" />
      <div ref={containerRef} className="universe-viewport" tabIndex={-1} aria-hidden={reader !== null}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={event => finishPointer(event)} onPointerCancel={event => finishPointer(event, true)}
        onDoubleClick={onDoubleClick}>
        {domCategoryIds.map(renderCategoryButton)}
        {domItemKeys.map(renderItemButton)}
      </div>
      {reader && (
        <UniverseReader target={reader} reducedMotion={reducedMotionRef.current}
          onClose={() => closeReader(true)} onOpenVersion={openVersionFromReader} onNeighbors={onNeighbors} />
      )}
      {/* Desktop only: a 48px hover strip along the bottom edge reveals the pill without focusing it. No search
          at all while a document is open: no strip, no pill, no shortcut. */}
      {!alwaysVisible && !reader && (
        <div className="universe-hover-zone" aria-hidden="true" onMouseEnter={revealSearch} onMouseLeave={onSearchHoverLeave} />
      )}
      <div ref={chromeRef} className="universe-chrome">
        {/* Desktop: no visible hint or caption line (owner decision); the caption stays for screen readers only. */}
        <p className={`universe-crumb${alwaysVisible ? '' : ' universe-sr-only'}`} aria-live="polite" data-hidden={alwaysVisible ? reader !== null : false}>
          {notFound ? '찾지 못했다' : crumbText}
        </p>
        {!reader && renderSearchPill()}
      </div>
    </div>
  );
}
