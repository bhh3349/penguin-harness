/**
 * The UI workbench's element library, stored under `ui_prefs.elementLibrary`.
 *
 * Its value is text the user collected from other sites (a DevTools paste plus the markup rendered
 * out of it), so like `draftShortcuts` it is bounded on the way in. The cases below go through the
 * real route rather than the validator alone, because the two claims that matter are about the
 * route: a rejected write stores **nothing**, and an accepted one does not disturb the other
 * writers merging into the same object.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";
import {
  ELEMENT_LIBRARY_HTML_MAX,
  ELEMENT_LIBRARY_MAX_CATEGORIES,
  ELEMENT_LIBRARY_MAX_ITEMS,
  ELEMENT_LIBRARY_NAME_MAX,
  ELEMENT_LIBRARY_PASTE_MAX,
  ELEMENT_LIBRARY_TEXT_TOTAL_MAX,
} from "../src/services/element-library.js";
import type { ElementLibrary, ElementLibraryItem } from "../src/api/types.js";

const category = (id: string, name = `folder ${id}`) => ({
  id,
  name,
  createdAt: 1_700_000_000_000,
});

const item = (id: string, categoryId = "c1", rest: Partial<ElementLibraryItem> = {}) => ({
  id,
  categoryId,
  name: `item ${id}`,
  createdAt: 1_700_000_000_000,
  paste: '<button class="primary">Sign in</button>',
  html: '<button class="primary">Sign in</button>',
  ...rest,
});

const library = (items: unknown[] = [item("i1")]): ElementLibrary =>
  ({ categories: [category("c1")], items }) as ElementLibrary;

describe("ui_prefs elementLibrary", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;

  beforeEach(async () => {
    t = await createTestApp();
    const { cookie } = await provisionUser(t.app, "ivy");
    api = apiClient(t.app, cookie);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  const read = async (): Promise<ElementLibrary | undefined> => {
    const body = (await (await api.get("/api/me/prefs")).json()) as {
      prefs: { elementLibrary?: ElementLibrary };
    };
    return body.prefs.elementLibrary;
  };

  it("stores a library per user and reads it back whole", async () => {
    const stored = library();
    const res = await api.put("/api/me/prefs", { elementLibrary: stored });
    expect(res.status).toBe(200);
    expect(await read()).toEqual(stored);

    // Another user's library is their own.
    const other = apiClient(t.app, (await provisionUser(t.app, "jack")).cookie);
    const theirs = (await (await other.get("/api/me/prefs")).json()) as { prefs: object };
    expect(theirs.prefs).toEqual({});
  });

  it("replaces the whole library on write while leaving other preferences alone", async () => {
    await api.put("/api/me/prefs", { lastProjectId: "default_project" });
    await api.put("/api/me/prefs", { elementLibrary: library([item("i1"), item("i2")]) });
    await api.put("/api/me/prefs", { elementLibrary: library([item("i2")]) });
    const body = (await (await api.get("/api/me/prefs")).json()) as {
      prefs: { lastProjectId?: string; elementLibrary?: ElementLibrary };
    };
    expect(body.prefs.elementLibrary?.items.map((entry) => entry.id)).toEqual(["i2"]);
    expect(body.prefs.lastProjectId).toBe("default_project");
  });

  it("normalizes what it stores: trimmed text, no extra keys riding along", async () => {
    // Passing the entry through would let an unbounded field sit inside a value that otherwise
    // looks capped — the paste here is the field a client could inflate.
    const res = await api.put("/api/me/prefs", {
      elementLibrary: {
        categories: [{ id: " c1 ", name: "  buttons  ", createdAt: 5, note: "x".repeat(5000) }],
        items: [
          {
            ...item(" i1 ", " c1 "),
            name: "  Gradient button  ",
            note: "x".repeat(5000),
            ai: false,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(await read()).toEqual({
      categories: [{ id: "c1", name: "buttons", createdAt: 5 }],
      items: [
        {
          id: "i1",
          categoryId: "c1",
          name: "Gradient button",
          createdAt: 1_700_000_000_000,
          paste: '<button class="primary">Sign in</button>',
          html: '<button class="primary">Sign in</button>',
        },
      ],
    });
  });

  it("keeps the optional host and the ai flag when they are there, and drops them when they are not", async () => {
    await api.put("/api/me/prefs", {
      elementLibrary: library([
        item("i1", "c1", { host: " vercel.com ", ai: true, css: ".primary { color: red }" }),
        item("i2"),
      ]),
    });
    const stored = await read();
    expect(stored?.items[0]).toMatchObject({
      host: "vercel.com",
      ai: true,
      css: ".primary { color: red }",
    });
    expect(stored?.items[1]).not.toHaveProperty("host");
    expect(stored?.items[1]).not.toHaveProperty("ai");
    expect(stored?.items[1]).not.toHaveProperty("css");
  });

  it("refuses an item whose category is not in the same library, and stores nothing", async () => {
    // Such an item could never be shown by any filter — it is a write a reader cannot honor.
    await api.put("/api/me/prefs", { elementLibrary: library() });
    const res = await api.put("/api/me/prefs", {
      elementLibrary: { categories: [category("c1")], items: [item("i1", "c-other")] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_element_library",
    );
    expect((await read())?.items.map((entry) => entry.id)).toEqual(["i1"]);
  });

  it("refuses more items or categories than the cap", async () => {
    const tooManyItems = Array.from({ length: ELEMENT_LIBRARY_MAX_ITEMS + 1 }, (_, i) =>
      item(`i${i}`),
    );
    expect((await api.put("/api/me/prefs", { elementLibrary: library(tooManyItems) })).status).toBe(
      400,
    );
    const atCap = tooManyItems.slice(0, ELEMENT_LIBRARY_MAX_ITEMS);
    expect((await api.put("/api/me/prefs", { elementLibrary: library(atCap) })).status).toBe(200);

    const tooManyCategories = Array.from({ length: ELEMENT_LIBRARY_MAX_CATEGORIES + 1 }, (_, i) =>
      category(`c${i}`),
    );
    expect(
      (
        await api.put("/api/me/prefs", {
          elementLibrary: { categories: tooManyCategories, items: [] },
        })
      ).status,
    ).toBe(400);
  });

  it("refuses an over-long name, paste or html", async () => {
    const long = async (field: "name" | "paste" | "html", max: number) => {
      const over = { ...item("i1"), [field]: "x".repeat(max + 1) };
      expect(
        (await api.put("/api/me/prefs", { elementLibrary: library([over]) })).status,
        `${field} over the cap`,
      ).toBe(400);
      const at = { ...item("i1"), [field]: "x".repeat(max) };
      expect((await api.put("/api/me/prefs", { elementLibrary: library([at]) })).status).toBe(200);
    };
    await long("name", ELEMENT_LIBRARY_NAME_MAX);
    await long("paste", ELEMENT_LIBRARY_PASTE_MAX);
    await long("html", ELEMENT_LIBRARY_HTML_MAX);
  });

  it("refuses a library whose stored text adds up past the shared cap", async () => {
    // Per-item caps alone would still allow a hundred items sitting at them; this is the sum.
    // Every item here is inside its own cap (40k of html) — 26 of them cross the shared one.
    const heavy = Array.from({ length: ELEMENT_LIBRARY_MAX_ITEMS / 3 }, (_, i) =>
      item(`i${i}`, "c1", { paste: "p".repeat(100), html: "h".repeat(ELEMENT_LIBRARY_HTML_MAX) }),
    );
    const res = await api.put("/api/me/prefs", { elementLibrary: library(heavy) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      String(ELEMENT_LIBRARY_TEXT_TOTAL_MAX),
    );
  });

  it("refuses a malformed entry", async () => {
    const bad: unknown[] = [
      { categories: "not an array", items: [] },
      { categories: [], items: "not an array" },
      { categories: [{ name: "no id", createdAt: 1 }], items: [] },
      { categories: [{ id: "c1", name: "   ", createdAt: 1 }], items: [] },
      { categories: [{ id: "c1", name: "ok", createdAt: -1 }], items: [] },
      { categories: [{ id: "c1", name: "ok", createdAt: "yesterday" }], items: [] },
      { categories: [category("c1")], items: [{ ...item("i1"), paste: "  " }] },
      { categories: [category("c1")], items: [{ ...item("i1"), html: "" }] },
      { categories: [category("c1")], items: [{ ...item("i1"), createdAt: null }] },
    ];
    for (const entry of bad) {
      const res = await api.put("/api/me/prefs", { elementLibrary: entry });
      expect(res.status, JSON.stringify(entry)).toBe(400);
    }
    expect(await read()).toBeUndefined();
  });

  it("refuses duplicate category ids and duplicate item ids", async () => {
    const dupCategory = await api.put("/api/me/prefs", {
      elementLibrary: { categories: [category("c1"), category("c1")], items: [] },
    });
    expect(dupCategory.status).toBe(400);
    const dupItem = await api.put("/api/me/prefs", {
      elementLibrary: library([item("i1"), item("i1")]),
    });
    expect(dupItem.status).toBe(400);
  });

  it("accepts a library with a category but no items — which is how a category starts", async () => {
    expect(
      (
        await api.put("/api/me/prefs", {
          elementLibrary: { categories: [category("c1")], items: [] },
        })
      ).status,
    ).toBe(200);
    expect(await read()).toEqual({ categories: [category("c1")], items: [] });
  });
});
