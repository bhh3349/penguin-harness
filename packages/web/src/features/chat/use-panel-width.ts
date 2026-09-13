/**
 * Width shared by everything that docks beside the chat: the Workspace files panel, the
 * Agents panel, the Memory panel, and a left or right terminal pane — plus the drag-to-resize
 * machinery the three panels mount.
 *
 * All of them are MUTUALLY EXCLUSIVE — opening one displaces the others — so to the user they
 * read as a single side panel that swaps its content. Independent widths made that swap
 * jump, which is why the width is one value here rather than a per-surface preference: a
 * width dragged on any of them is the width the next one opens at, immediately and after a
 * reload. The terminal pane brings its own resize gesture (it can dock on either side) and
 * writes through setPanelWidth.
 *
 * "Immediately" is what rules out a `useState` per panel over one storage key: only the panel
 * that was mounted and dragged would update, and the others would keep a stale copy until their
 * next remount. So the value lives in a module-level store every hook subscribes to, and the
 * persisted preference is written once per drag (mouseup), not per frame.
 *
 * Width is a layout preference, not session data: it is never reset on a Session switch. What a
 * panel *opens* at while nothing has been dragged is the one thing that is per panel — see
 * `defaultWidthFor` and the `workbench` entry in it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";
import type { PanelKind } from "../dock/dock-state";

const MIN_WIDTH = 320;
const WIDTH_STORAGE_KEY = "penguin.panelWidth";

/**
 * The chat column's own floor, in px. The panel stops here rather than squeezing it.
 *
 * This replaced a cap of "half the window, never past 720px": that stopped the drag while the
 * chat column was still wide, which read as a panel that simply had a fixed width — the divider
 * could barely move on a normal window. What the chat can actually spare is the honest bound.
 */
export const CHAT_MIN_WIDTH = 420;

/**
 * The pinned sidebar and its collapsed rail, in px — app-layout's `lg:w-72` and `w-12`. The
 * sidebar is the first thing that yields when a panel takes width: below the point where both
 * fit (see `fitsWithSidebar`) app-layout shows the rail instead of squeezing the chat column.
 */
export const SIDEBAR_WIDTH = 288;
export const SIDEBAR_RAIL_WIDTH = 48;

/** Below this window width (Tailwind's `md`) the sidebar is not rendered at all — nothing to yield. */
export const SIDEBAR_VISIBLE_WIDTH = 768;

/**
 * Width cap: everything the window can spare once the chat column keeps its minimum and the
 * sidebar is down to its rail. A wide window therefore lets the panel grow genuinely wide (a
 * preview or a transcript wants the room), and the cap scales with the window instead of
 * being a constant.
 */
export function maxWidthFor(windowWidth: number): number {
  return Math.max(MIN_WIDTH, Math.round(windowWidth - SIDEBAR_RAIL_WIDTH - CHAT_MIN_WIDTH));
}

/**
 * Whether an expanded sidebar still fits beside a panel this wide — the layout question
 * app-layout asks before showing the pinned sidebar. Equality fits: the chat column sitting
 * exactly at its minimum is the intent, not an overflow.
 */
export function fitsWithSidebar(windowWidth: number, panelWidth: number): boolean {
  if (windowWidth < SIDEBAR_VISIBLE_WIDTH) return true; // no sidebar on screen to make room for
  return SIDEBAR_WIDTH + CHAT_MIN_WIDTH + panelWidth <= windowWidth;
}

/**
 * Whether the pinned sidebar has to stand down because a panel is taking its room. Only a dock
 * on the *right* edge competes for horizontal space: a bottom dock costs height, and below `lg`
 * (`isNarrow()`) the docks merge into that same bottom surface, so neither is a reason to yield.
 * Pure, so the rule reads as one sentence and is testable; app-layout supplies the dock facts.
 */
export function sidebarYieldsTo(
  windowWidth: number,
  panelWidth: number,
  rightDockOpen: boolean,
  narrow: boolean,
): boolean {
  if (!rightDockOpen || narrow) return false;
  return !fitsWithSidebar(windowWidth, panelWidth);
}

/**
 * Default width ≈ 40% of the window, clamped within the min/max bounds, and **per panel where a
 * panel differs** (D34): the dock is one column, but what a tenant needs from it is not one
 * number. The 40% is the reading surfaces' — the subagent transcript and the file tree, the
 * latter because below 480px it falls back to its single-column drill-down — and the workbench
 * asks for half of it, lazily: it is a browser with a page in it, and at 40% of a 1920px window
 * it stood 768px wide beside the conversation.
 *
 * Only the *default* is per panel. A dragged width is still one stored preference that every
 * panel opens at (see the file header), so the tab strip keeps behaving like one column once the
 * user has said what they want.
 */
const DEFAULT_RATIO: Partial<Record<PanelKind, number>> = { workbench: 0.2 };
/** What a tenant that names no ratio asks for: the transcript, the tree, a terminal. */
const FALLBACK_RATIO = 0.4;

export function defaultWidthFor(windowWidth: number, kind?: PanelKind): number {
  const ratio = (kind === undefined ? undefined : DEFAULT_RATIO[kind]) ?? FALLBACK_RATIO;
  return Math.min(maxWidthFor(windowWidth), Math.max(MIN_WIDTH, Math.round(windowWidth * ratio)));
}

/**
 * Sizes the column to `kind`'s default — **unless the user has dragged one**, in which case that
 * single stored preference is what every panel opens at and this does nothing. The dock calls it
 * as its active tab changes; a reader that seeds lazily (`readWidth`) gets the fallback ratio,
 * and this then corrects it rather than double-seeding.
 */
export function seedPanelWidth(kind: PanelKind | undefined): void {
  if (storedWidth() !== null) return;
  writeWidth(defaultWidthFor(window.innerWidth, kind));
}

/** Reads the stored preference; null when nothing is stored (or storage is unreadable). */
function storedWidth(): number | null {
  try {
    const own = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    return Number.isFinite(own) && own > 0 ? own : null;
  } catch {
    return null; // quota / private mode: fall back to the proportional default
  }
}

/** Initial width: the stored preference (clamped back within this window's bounds, so an oversized value carried over from another device can't crowd out the chat column) over the proportional default. */
function initialWidth(): number {
  const stored = storedWidth();
  if (stored === null) return defaultWidthFor(window.innerWidth);
  return Math.min(maxWidthFor(window.innerWidth), Math.max(MIN_WIDTH, Math.round(stored)));
}

// —— Module-level store: one width, every subscriber re-renders on change ——

// null = not initialized yet: the width stays lazy (computed on the first read, i.e. the
// first mounted panel's render), exactly like the pre-zustand module variable — an eager
// initialWidth() at module load would run the legacy-key migration on every page load.
const widthStore = createStore<{ width: number | null }>(() => ({ width: null }));

function readWidth(): number {
  const { width } = widthStore.getState();
  if (width !== null) return width;
  // First read happens during the first subscriber's render, before anything subscribed:
  // seeding via setState here notifies nobody, so it is safe inside a render.
  const initial = initialWidth();
  widthStore.setState({ width: initial });
  return initial;
}

function writeWidth(next: number): void {
  if (next === widthStore.getState().width) return;
  widthStore.setState({ width: next });
}

export interface PanelWidthState {
  width: number;
  resizing: boolean;
  startResize: (e: ReactMouseEvent<HTMLDivElement>) => void;
  /** Double-clicking the drag handle: width reverts to the window-proportional default, and the stored preference is cleared. */
  resetWidth: () => void;
  /** Ref to the docked panel's root node: drag-to-resize uses its right edge to compute the target width. */
  panelRef: RefObject<HTMLDivElement | null>;
}

/** The current shared width, read outside React (measuring a drop region mid-drag). */
export function panelWidth(): number {
  return readWidth();
}

/** Subscribes to the shared width alone — for a consumer with its own resize gesture. */
export function usePanelWidthValue(): number {
  return useStore(widthStore, () => readWidth());
}

/**
 * Subscribes to the one *question* the sidebar asks of the width — "does this panel leave room
 * for an expanded sidebar?" — rather than to the width itself: a drag writes the width every
 * frame, and a layout this size (the sidebar's session list included) has no business re-rendering
 * on each of them to answer a yes/no that changes at most once per drag.
 */
export function useSidebarYields(
  windowWidth: number,
  rightDockOpen: boolean,
  narrow: boolean,
): boolean {
  return useStore(widthStore, () =>
    sidebarYieldsTo(windowWidth, readWidth(), rightDockOpen, narrow),
  );
}

/** Sets the shared width from another surface's drag, clamped to the same bounds. */
export function setPanelWidth(px: number): void {
  writeWidth(Math.min(maxWidthFor(window.innerWidth), Math.max(MIN_WIDTH, Math.round(px))));
}

/** Persists the current width; call once at the end of a drag, not per frame. */
export function persistPanelWidth(): void {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(readWidth())));
  } catch {
    /* best-effort persistence (quota / private mode) */
  }
}

/** Back to the window-proportional default, clearing the stored preference. */
export function resetPanelWidth(): void {
  writeWidth(defaultWidthFor(window.innerWidth));
  try {
    localStorage.removeItem(WIDTH_STORAGE_KEY);
  } catch {
    /* best-effort */
  }
}

/**
 * The shared width plus this panel's own drag state. `resizing` and `panelRef` stay per-panel
 * (each panel has its own DOM node and its own handle); only the width crosses between them.
 */
export function usePanelWidth(): PanelWidthState {
  const width = useStore(widthStore, () => readWidth());
  const [resizing, setResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Drag-to-resize: during mousemove, computes the width from the panel's right edge and clamps
  // it within the min/max bounds; locks the cursor/selection during the drag to avoid
  // accidentally selecting page text on a fast drag.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const rect = panelRef.current?.getBoundingClientRect();
      const right = rect ? rect.right : window.innerWidth;
      writeWidth(Math.min(maxWidthFor(window.innerWidth), Math.max(MIN_WIDTH, right - e.clientX)));
    };
    // Only persist once the drag ends: mousemove fires every frame, and it's not worth writing to localStorage on every frame.
    const onUp = () => {
      setResizing(false);
      persistPanelWidth();
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing]);

  const startResize = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setResizing(true);
  }, []);

  // Clears rather than writing the default value: this way the default keeps following the
  // window's proportion going forward, instead of being frozen at the current pixel value.
  const resetWidth = useCallback(resetPanelWidth, []);

  // When the window shrinks, clamp the width back within the cap so the docked panel can't
  // crowd out the chat column. Shrinks only, never grows back, and never overwrites the stored
  // preference: enlarging the window again relies on a refresh or a double-click on the handle.
  // All three panels register this; the clamp is idempotent, so the duplicates are harmless.
  useEffect(() => {
    const onResize = () => writeWidth(Math.min(readWidth(), maxWidthFor(window.innerWidth)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { width, resizing, startResize, resetWidth, panelRef };
}
