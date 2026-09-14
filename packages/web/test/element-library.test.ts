/**
 * The element library's pure half: what a stored prefs blob reads back as, what a save is refused
 * for, and what a paste is called before the user names it.
 *
 * The drawer is where these run, so the branches that matter here are the ones a user can reach but
 * a screenshot cannot show: a half-written entry in the stored blob, a category at its cap, and the
 * two ways a save is refused (too many items, and the shared text cap the server also enforces).
 */
import { describe, expect, it } from "vitest";
import {
  LIBRARY_LIMITS,
  addElement,
  createCategory,
  elementsOf,
  emptyLibrary,
  libraryTextSize,
  normalizeLibrary,
  removeCategory,
  removeElement,
  suggestElementName,
} from "../src/features/workbench/element-library";
import type { ElementLibrary, ElementLibraryItem } from "../src/features/workbench/element-library";

const item = (id: string, categoryId: string, rest: Partial<ElementLibraryItem> = {}) => ({
  id,
  categoryId,
  name: `item ${id}`,
  createdAt: 1_700_000_000_000,
  paste: "<button>Sign in</button>",
  html: "<button>Sign in</button>",
  ...rest,
});

const library = (items: ElementLibraryItem[] = []): ElementLibrary => ({
  categories: [{ id: "c1", name: "buttons", createdAt: 1 }],
  items,
});

const withCategory = (): ElementLibrary => {
  const created = createCategory(emptyLibrary(), "buttons", "c1", 1);
  if (!("library" in created)) throw new Error(`createCategory refused: ${created.refusal}`);
  return created.library;
};

describe("normalizeLibrary", () => {
  it("reads nothing at all as an empty library", () => {
    expect(normalizeLibrary(undefined)).toEqual(emptyLibrary());
    expect(normalizeLibrary(null)).toEqual(emptyLibrary());
    expect(normalizeLibrary("nonsense")).toEqual(emptyLibrary());
    expect(normalizeLibrary({ categories: "no", items: 7 })).toEqual(emptyLibrary());
  });

  it("drops the entries it cannot show instead of taking the drawer down", () => {
    const stored = {
      categories: [
        { id: "c1", name: "buttons", createdAt: 1 },
        { id: "c1", name: "duplicate id", createdAt: 1 },
        { id: "c2", name: "   ", createdAt: 1 },
        "not an object",
      ],
      items: [
        item("i1", "c1"),
        // A dangling categoryId is unshowable (the server refuses to store one), so it reads as absent.
        item("i2", "c-missing"),
        { ...item("i3", "c1"), html: "" },
        item("i1", "c1", { name: "duplicate id" }),
        item("i4", "c1", { host: "vercel.com", css: ".x{}", ai: true }),
      ],
    };
    const library = normalizeLibrary(stored);
    expect(library.categories.map((category) => category.id)).toEqual(["c1"]);
    expect(library.items.map((entry) => entry.id)).toEqual(["i1", "i4"]);
    expect(library.items[1]).toMatchObject({ host: "vercel.com", css: ".x{}", ai: true });
    expect(library.items[0]).not.toHaveProperty("host");
    expect(library.items[0]).not.toHaveProperty("ai");
  });
});

describe("categories", () => {
  it("creates one, refusing a blank or duplicate name and its own cap", () => {
    const created = createCategory(emptyLibrary(), "  buttons  ", "c1", 1);
    expect("library" in created && created.category).toEqual({
      id: "c1",
      name: "buttons",
      createdAt: 1,
    });
    expect(createCategory(withCategory(), "   ", "c2", 1)).toEqual({ refusal: "empty-name" });
    expect(createCategory(withCategory(), "buttons", "c2", 1)).toEqual({
      refusal: "duplicate-name",
    });
    const full: ElementLibrary = {
      categories: Array.from({ length: LIBRARY_LIMITS.categories }, (_, i) => ({
        id: `c${i}`,
        name: `folder ${i}`,
        createdAt: 1,
      })),
      items: [],
    };
    expect(createCategory(full, "one more", "cx", 1)).toEqual({ refusal: "too-many-categories" });
  });

  it("takes its elements with it when deleted", () => {
    const before: ElementLibrary = { ...withCategory(), items: [item("i1", "c1")] };
    expect(removeCategory(before, "c1")).toEqual({ categories: [], items: [] });
  });
});

describe("elements", () => {
  it("files one, keeping the optional host and dropping an empty one", () => {
    const result = addElement(
      withCategory(),
      {
        categoryId: "c1",
        name: " Sign in ",
        paste: "<button>Sign in</button>",
        html: "<button>Sign in</button>",
        host: "vercel.com",
      },
      "i1",
      7,
    );
    expect("item" in result && result.item).toMatchObject({
      name: "Sign in",
      host: "vercel.com",
      createdAt: 7,
    });
    expect("item" in result && result.item).not.toHaveProperty("css");

    const noHost = addElement(
      withCategory(),
      { categoryId: "c1", name: "x", paste: "<b>x</b>", html: "<b>x</b>", host: "" },
      "i2",
      7,
    );
    expect("item" in noHost && noHost.item).not.toHaveProperty("host");
  });

  it("refuses what it cannot store, each for its own reason", () => {
    const draft = { categoryId: "c1", name: "x", paste: "<b>x</b>", html: "<b>x</b>" };
    expect(addElement(withCategory(), { ...draft, name: "  " }, "i1", 1)).toEqual({
      refusal: "empty-name",
    });
    expect(addElement(withCategory(), { ...draft, html: "  " }, "i1", 1)).toEqual({
      refusal: "no-markup",
    });
    expect(addElement(withCategory(), { ...draft, categoryId: "c9" }, "i1", 1)).toEqual({
      refusal: "no-category",
    });
    expect(
      addElement(
        library(Array.from({ length: LIBRARY_LIMITS.items }, (_, i) => item(`i${i}`, "c1"))),
        draft,
        "in",
        1,
      ),
    ).toEqual({ refusal: "too-many-items" });
    expect(
      addElement(withCategory(), { ...draft, html: "x".repeat(LIBRARY_LIMITS.html + 1) }, "i1", 1),
    ).toEqual({
      refusal: "too-large",
    });

    // The shared cap is a sum, so a library of items each inside its own cap is still refused.
    const heavy = Array.from({ length: 25 }, (_, i) =>
      item(`i${i}`, "c1", { paste: "p", html: "h".repeat(LIBRARY_LIMITS.html) }),
    );
    expect(addElement(library(heavy), draft, "i-new", 1)).toEqual({ refusal: "not-enough-room" });
    expect(libraryTextSize(library(heavy))).toBeGreaterThan(
      LIBRARY_LIMITS.text - LIBRARY_LIMITS.html,
    );
  });

  it("filters by category, counting the whole library for the 全部 chip", () => {
    const two = { ...library([item("i1", "c1"), item("i2", "c1")]) };
    expect(elementsOf(two, "c1")).toHaveLength(2);
    expect(elementsOf(two, null)).toHaveLength(2);
    expect(elementsOf(two, "c-other")).toHaveLength(0);
    expect(removeElement(two, "i1").items.map((entry) => entry.id)).toEqual(["i2"]);
  });
});

describe("suggestElementName", () => {
  it("names a paste after the element it starts with", () => {
    expect(suggestElementName('<button class="btn-primary large">Sign in</button>', null)).toBe(
      "button.btn-primary",
    );
    expect(suggestElementName("<h1>Hello</h1>", null)).toBe("h1");
    expect(suggestElementName("<div><h1>Hello</h1></div>", "vercel.com")).toBe("div");
  });

  it("falls back to the host, and to nothing at all when the paste says neither", () => {
    expect(suggestElementName("", "vercel.com")).toBe("vercel.com");
    expect(suggestElementName("", null)).toBe("");
  });
});
