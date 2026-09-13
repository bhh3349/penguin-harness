/**
 * The shared side-panel width's bounds (src/features/chat/use-panel-width.ts) and the rule that
 * decides when the pinned sidebar has to give its room up to a panel.
 *
 * These are pure functions on purpose: the drag itself is a DOM gesture (e2e/dock.spec.mjs), but
 * "how far may the panel go" and "does the sidebar still fit" are arithmetic, and getting them
 * wrong is exactly what made the divider feel like a fixed width.
 */
import { describe, expect, it } from "vitest";
import {
  CHAT_MIN_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_VISIBLE_WIDTH,
  SIDEBAR_WIDTH,
  defaultWidthFor,
  fitsWithSidebar,
  maxWidthFor,
  sidebarYieldsTo,
} from "../src/features/chat/use-panel-width";

describe("maxWidthFor", () => {
  it("scales with the window instead of stopping at a constant cap", () => {
    // 1280 - rail(48) - chat floor(420). The old rule ("half the window, never past 720")
    // stopped at 640 here and at 720 on anything wide — hence the fixed-width feel.
    expect(maxWidthFor(1280)).toBe(812);
    expect(maxWidthFor(1920)).toBe(1452);
    expect(maxWidthFor(1920)).toBeGreaterThan(720);
  });

  it("never lets the panel squeeze the chat column past its floor", () => {
    // 600 - 48 - 420 = 132, under the panel's own minimum: the floor wins.
    expect(maxWidthFor(600)).toBe(320);
    expect(maxWidthFor(1280)).toBe(1280 - SIDEBAR_RAIL_WIDTH - CHAT_MIN_WIDTH);
  });
});

describe("defaultWidthFor", () => {
  it("is the window's 40%, clamped into the same bounds", () => {
    expect(defaultWidthFor(1280)).toBe(512);
    expect(defaultWidthFor(1920)).toBe(768);
    expect(defaultWidthFor(600)).toBe(320);
  });

  it("is half of that for the workbench, which is a browser and not a reading surface (D34)", () => {
    // The one tenant that names its own ratio; everything else (the transcript, the file tree,
    // a terminal) keeps the 40% it was chosen for.
    expect(defaultWidthFor(1920, "workbench")).toBe(384);
    expect(defaultWidthFor(1280, "workbench")).toBe(320); // 256, under the floor
    expect(defaultWidthFor(1920, "workspace")).toBe(768);
    expect(defaultWidthFor(1920, "agents")).toBe(768);
  });
});

describe("fitsWithSidebar", () => {
  it("needs the sidebar, the chat floor and the panel to fit — exactly at the boundary", () => {
    expect(fitsWithSidebar(1280, 1280 - SIDEBAR_WIDTH - CHAT_MIN_WIDTH)).toBe(true);
    expect(fitsWithSidebar(1280, 1280 - SIDEBAR_WIDTH - CHAT_MIN_WIDTH + 1)).toBe(false);
  });

  it("does not ask for room the sidebar would not take", () => {
    // Below `md` the sidebar is not rendered at all, so no panel can crowd it out.
    expect(fitsWithSidebar(SIDEBAR_VISIBLE_WIDTH - 1, 9999)).toBe(true);
  });

  it("stops fitting before the panel reaches its cap — the cap is the rail's, not the sidebar's", () => {
    expect(fitsWithSidebar(1280, maxWidthFor(1280))).toBe(false);
  });
});

describe("sidebarYieldsTo", () => {
  it("yields only to a panel docked on the right edge", () => {
    // A bottom dock costs height; nothing about it takes the sidebar's width.
    expect(sidebarYieldsTo(1280, 812, false, false)).toBe(false);
    expect(sidebarYieldsTo(1280, 812, true, false)).toBe(true);
  });

  it("does not yield below `lg`, where the docks merge into the bottom surface", () => {
    // 900px: `isNarrow()`, so the open right dock renders as the merged bottom view.
    expect(sidebarYieldsTo(900, 812, true, true)).toBe(false);
  });

  it("comes back as soon as the panel gives the width back", () => {
    expect(sidebarYieldsTo(1280, 573, true, false)).toBe(true);
    expect(sidebarYieldsTo(1280, 572, true, false)).toBe(false);
  });
});
