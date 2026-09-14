/**
 * The UI workbench's element library (L3): a person's own collection of elements they saw on
 * **other** sites — DevTools → copy → paste → the panel renders it (element-restore.ts) → kept under
 * a category of their own naming.
 *
 * Two things this module is *not*: it is not the payload chain (`element-payload.ts` — that one is
 * about the element in the preview, and it travels to an Agent as a message), and it is not the
 * drawer (the component owns the pixels and the network). Everything here is a pure decision made
 * from values, so the branches the drawer apologizes for are branches a test can reach.
 *
 * Where it is stored: `ui_prefs.elementLibrary` — free-form user JSON, per user, read once per
 * browser session, replaced whole on every write (the same shape `draftShortcuts` uses for another
 * hand-curated personal collection). The caps below are the client's copy of the numbers the server
 * enforces on the way in (services/element-library.ts): the drawer has to say *why* a save is
 * refused before the request is made, and the server cannot be the only place that knows the sum
 * rule. Growing past them is the design doc's storage B (a table of its own), not a bigger blob.
 */
import type {
  ElementLibrary,
  ElementLibraryCategory,
  ElementLibraryItem,
} from "@prismshadow/penguin-server/api";

export type { ElementLibrary, ElementLibraryCategory, ElementLibraryItem };

/**
 * Mirrors services/element-library.ts (the server's numbers are the authority; these are for the
 * counters and the refusals the drawer shows before a request that would 400).
 */
export const LIBRARY_LIMITS = {
  categories: 30,
  items: 100,
  name: 60,
  paste: 20_000,
  html: 40_000,
  css: 40_000,
  /** The three text fields of every item, summed over the whole library. */
  text: 1_000_000,
} as const;

export function emptyLibrary(): ElementLibrary {
  return { categories: [], items: [] };
}

/** Client-generated ids: `elc-` for a category, `eli-` for an item (`draftShortcuts`' convention). */
export function newLibraryId(prefix: "elc" | "eli"): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * What the stored prefs say, defensively — this runs on a blob the user's own machine wrote, so a
 * malformed entry has to read as "that one is not there" rather than taking the drawer down with it.
 * An item whose category is missing is dropped for the same reason the server refuses to store one:
 * no filter could ever show it.
 */
export function normalizeLibrary(raw: unknown): ElementLibrary {
  if (!isRecord(raw)) return emptyLibrary();
  const categories: ElementLibraryCategory[] = [];
  const seenCategory = new Set<string>();
  for (const entry of Array.isArray(raw.categories) ? raw.categories : []) {
    if (!isRecord(entry)) continue;
    const id = text(entry.id);
    const name = text(entry.name);
    if (id === null || name === null || seenCategory.has(id)) continue;
    seenCategory.add(id);
    categories.push({
      id,
      name,
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
    });
  }
  const items: ElementLibraryItem[] = [];
  const seenItem = new Set<string>();
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    if (!isRecord(entry)) continue;
    const id = text(entry.id);
    const categoryId = text(entry.categoryId);
    const name = text(entry.name);
    const paste = text(entry.paste);
    const html = text(entry.html);
    if (id === null || categoryId === null || name === null || paste === null || html === null) {
      continue;
    }
    if (seenItem.has(id) || !seenCategory.has(categoryId)) continue;
    seenItem.add(id);
    items.push({
      id,
      categoryId,
      name,
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
      ...(text(entry.host) === null ? {} : { host: entry.host as string }),
      paste,
      html,
      ...(text(entry.css) === null ? {} : { css: entry.css as string }),
      ...(entry.ai === true ? { ai: true } : {}),
    });
  }
  return { categories, items };
}

/** The stored text of one item — what the sum cap is a cap on. */
function itemTextSize(item: Pick<ElementLibraryItem, "paste" | "html" | "css">): number {
  return item.paste.length + item.html.length + (item.css?.length ?? 0);
}

/** Every item's text, summed: the number the shared cap counts. */
export function libraryTextSize(library: ElementLibrary): number {
  return library.items.reduce((total, item) => total + itemTextSize(item), 0);
}

export function elementsOf(
  library: ElementLibrary,
  categoryId: string | null,
): ElementLibraryItem[] {
  return categoryId === null
    ? library.items
    : library.items.filter((item) => item.categoryId === categoryId);
}

export type LibraryRefusal =
  | "empty-name"
  | "duplicate-name"
  | "too-many-categories"
  | "too-many-items"
  | "no-category"
  | "no-markup"
  | "too-large"
  | "not-enough-room";

/** A category is a name and an id; the id comes in so the caller can name it in the same turn. */
export function createCategory(
  library: ElementLibrary,
  rawName: string,
  id: string,
  now: number,
): { library: ElementLibrary; category: ElementLibraryCategory } | { refusal: LibraryRefusal } {
  const name = rawName.trim().slice(0, LIBRARY_LIMITS.name);
  if (name === "") return { refusal: "empty-name" };
  // Two folders with one name would make the category chips a guessing game, so a second one is
  // refused rather than hidden behind an id nobody sees.
  if (library.categories.some((category) => category.name === name)) {
    return { refusal: "duplicate-name" };
  }
  if (library.categories.length >= LIBRARY_LIMITS.categories) {
    return { refusal: "too-many-categories" };
  }
  const category: ElementLibraryCategory = { id, name, createdAt: now };
  return { library: { ...library, categories: [...library.categories, category] }, category };
}

/**
 * Deleting a category takes its elements with it — the drawer confirms with the count in the
 * sentence, because an item that outlived its folder would be an entry nothing can show (the same
 * reason the server refuses to store a dangling `categoryId`).
 */
export function removeCategory(library: ElementLibrary, categoryId: string): ElementLibrary {
  return {
    categories: library.categories.filter((category) => category.id !== categoryId),
    items: library.items.filter((item) => item.categoryId !== categoryId),
  };
}

export interface ElementDraft {
  categoryId: string;
  name: string;
  paste: string;
  html: string;
  css?: string;
  host?: string;
  ai?: boolean;
}

/** Files a restored element into the library, or says which cap refused it. */
export function addElement(
  library: ElementLibrary,
  draft: ElementDraft,
  id: string,
  now: number,
): { library: ElementLibrary; item: ElementLibraryItem } | { refusal: LibraryRefusal } {
  const name = draft.name.trim().slice(0, LIBRARY_LIMITS.name);
  if (name === "") return { refusal: "empty-name" };
  if (draft.html.trim() === "") return { refusal: "no-markup" };
  if (!library.categories.some((category) => category.id === draft.categoryId)) {
    return { refusal: "no-category" };
  }
  if (library.items.length >= LIBRARY_LIMITS.items) return { refusal: "too-many-items" };
  if (
    draft.paste.length > LIBRARY_LIMITS.paste ||
    draft.html.length > LIBRARY_LIMITS.html ||
    (draft.css?.length ?? 0) > LIBRARY_LIMITS.css
  ) {
    return { refusal: "too-large" };
  }
  const item: ElementLibraryItem = {
    id,
    categoryId: draft.categoryId,
    name,
    createdAt: now,
    ...(draft.host === undefined || draft.host === "" ? {} : { host: draft.host }),
    paste: draft.paste,
    html: draft.html,
    ...(draft.css === undefined || draft.css === "" ? {} : { css: draft.css }),
    ...(draft.ai === true ? { ai: true } : {}),
  };
  if (libraryTextSize(library) + itemTextSize(item) > LIBRARY_LIMITS.text) {
    return { refusal: "not-enough-room" };
  }
  return { library: { ...library, items: [...library.items, item] }, item };
}

export function removeElement(library: ElementLibrary, itemId: string): ElementLibrary {
  return { ...library, items: library.items.filter((item) => item.id !== itemId) };
}

/** What to call a paste before the user names it: the element it starts with, plus its first class. */
export function suggestElementName(html: string, host: string | null): string {
  const opening = /<([a-z][a-z0-9-]*)\b([^>]*)>/i.exec(html);
  const tag = opening === null ? null : (opening[1] ?? "").toLowerCase();
  const classList =
    opening === null ? "" : (/\bclass\s*=\s*"([^"]*)"/i.exec(opening[2] ?? "")?.[1] ?? "");
  const firstClass = classList.trim().split(/\s+/)[0] ?? "";
  const label = tag === null ? "" : firstClass === "" ? tag : `${tag}.${firstClass}`;
  if (label !== "") return label.slice(0, LIBRARY_LIMITS.name);
  return (host ?? "").slice(0, LIBRARY_LIMITS.name);
}
