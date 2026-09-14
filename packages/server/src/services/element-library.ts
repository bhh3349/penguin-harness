/**
 * Bounds on the UI workbench's element library (`ui_prefs.elementLibrary`).
 *
 * The library holds **text the user collected from other sites**: a paste from a browser's
 * DevTools (`Copy element` / `Copy styles`) and the self-contained markup the panel renders out of
 * it. Like `draftShortcuts` (services/draft-shortcuts.ts) it therefore lives in `ui_prefs`, whose
 * `PUT /api/me/prefs` shallow-merges whatever it is handed into one TEXT column — so the caps are
 * enforced **on the write path**, not only in the drawer that normally produces the value: a client
 * that never goes through that drawer still cannot store more than this.
 *
 * The numbers, and why each one:
 *   - 30 categories / 100 items: this is a collection a person curates by hand, and every entry
 *     rides in the prefs blob that `GET /api/me/prefs` hands out on every app start (the Web App
 *     reads it once per browser session). 100 is well past what anyone scrolls through; past that
 *     the page is a table, not a prefs key (see the design doc's storage B).
 *   - 20k paste / 40k html / 40k css per item, and **1 MB of those three summed over the whole
 *     library**: one DevTools paste of a card is a few KB, and the sum is the bound that actually
 *     keeps the blob small — a hundred items each sitting at their per-item cap would be 10 MB.
 *   - 60-character names, 64-character ids, 255-character host: display bounds, not content ones.
 *
 * Normalizing (rather than passing the value through) is part of the bound, the same way it is for
 * `draftShortcuts`: the stored objects hold exactly the declared fields, so an extra key cannot ride
 * along as unbounded free storage inside a value that otherwise looks capped. Anything invalid is a
 * 400 that writes nothing, because the key is replaced whole.
 */
import { HttpError } from "../http/errors.js";
import type { ElementLibrary, ElementLibraryCategory, ElementLibraryItem } from "../api/types.js";

export const ELEMENT_LIBRARY_MAX_CATEGORIES = 30;
export const ELEMENT_LIBRARY_MAX_ITEMS = 100;
export const ELEMENT_LIBRARY_NAME_MAX = 60;
export const ELEMENT_LIBRARY_ID_MAX = 64;
export const ELEMENT_LIBRARY_HOST_MAX = 255;
export const ELEMENT_LIBRARY_PASTE_MAX = 20_000;
export const ELEMENT_LIBRARY_HTML_MAX = 40_000;
export const ELEMENT_LIBRARY_CSS_MAX = 40_000;
/** The three text fields of every item, summed over the whole library. */
export const ELEMENT_LIBRARY_TEXT_TOTAL_MAX = 1_000_000;

function invalid(message: string): HttpError {
  return new HttpError(400, "invalid_element_library", message);
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/** A required, non-blank, length-capped string; returns it trimmed. */
function requiredText(value: unknown, what: string, maxLen: number): string {
  if (typeof value !== "string") throw invalid(`${what} must be a string.`);
  const trimmed = value.trim();
  if (trimmed === "") throw invalid(`${what} must not be empty.`);
  if (trimmed.length > maxLen) throw invalid(`${what} must be at most ${maxLen} characters.`);
  return trimmed;
}

/** A required epoch-ms stamp. Negative or non-finite values are not a time. */
function requireStamp(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalid(`${what} must be a non-negative number (epoch ms).`);
  }
  return Math.floor(value);
}

/**
 * Validates an incoming `elementLibrary` value and returns the normalized library to store.
 *
 * Referential integrity is checked here rather than left to the reader: an item naming a category
 * that is not in the same payload would be an entry no filter can ever show, so it is a 400 (the
 * drawer writes both arrays together on every change).
 */
export function validateElementLibrary(value: unknown): ElementLibrary {
  const root = requireObject(value, "elementLibrary");
  const rawCategories = root.categories;
  const rawItems = root.items;
  if (!Array.isArray(rawCategories)) throw invalid("elementLibrary.categories must be an array.");
  if (!Array.isArray(rawItems)) throw invalid("elementLibrary.items must be an array.");
  if (rawCategories.length > ELEMENT_LIBRARY_MAX_CATEGORIES) {
    throw invalid(
      `elementLibrary.categories must hold at most ${ELEMENT_LIBRARY_MAX_CATEGORIES} categories.`,
    );
  }
  if (rawItems.length > ELEMENT_LIBRARY_MAX_ITEMS) {
    throw invalid(`elementLibrary.items must hold at most ${ELEMENT_LIBRARY_MAX_ITEMS} items.`);
  }

  const categoryIds = new Set<string>();
  const categories: ElementLibraryCategory[] = rawCategories.map((entry, index) => {
    const raw = requireObject(entry, `elementLibrary.categories[${index}]`);
    const id = requiredText(
      raw.id,
      `elementLibrary.categories[${index}].id`,
      ELEMENT_LIBRARY_ID_MAX,
    );
    if (categoryIds.has(id)) {
      throw invalid(`elementLibrary.categories[${index}].id duplicates an earlier id.`);
    }
    categoryIds.add(id);
    return {
      id,
      name: requiredText(
        raw.name,
        `elementLibrary.categories[${index}].name`,
        ELEMENT_LIBRARY_NAME_MAX,
      ),
      createdAt: requireStamp(raw.createdAt, `elementLibrary.categories[${index}].createdAt`),
    };
  });

  const itemIds = new Set<string>();
  let textTotal = 0;
  const items: ElementLibraryItem[] = rawItems.map((entry, index) => {
    const where = `elementLibrary.items[${index}]`;
    const raw = requireObject(entry, where);
    const id = requiredText(raw.id, `${where}.id`, ELEMENT_LIBRARY_ID_MAX);
    if (itemIds.has(id)) throw invalid(`${where}.id duplicates an earlier id.`);
    itemIds.add(id);
    const categoryId = requiredText(raw.categoryId, `${where}.categoryId`, ELEMENT_LIBRARY_ID_MAX);
    if (!categoryIds.has(categoryId)) {
      throw invalid(`${where}.categoryId names a category that is not in this library.`);
    }
    const paste = requiredText(raw.paste, `${where}.paste`, ELEMENT_LIBRARY_PASTE_MAX);
    const html = requiredText(raw.html, `${where}.html`, ELEMENT_LIBRARY_HTML_MAX);
    const css =
      raw.css === undefined ? "" : textOrEmpty(raw.css, `${where}.css`, ELEMENT_LIBRARY_CSS_MAX);
    textTotal += paste.length + html.length + css.length;
    if (textTotal > ELEMENT_LIBRARY_TEXT_TOTAL_MAX) {
      throw invalid(
        `elementLibrary holds more than ${ELEMENT_LIBRARY_TEXT_TOTAL_MAX} characters of pasted and rendered text.`,
      );
    }
    return {
      id,
      categoryId,
      name: requiredText(raw.name, `${where}.name`, ELEMENT_LIBRARY_NAME_MAX),
      createdAt: requireStamp(raw.createdAt, `${where}.createdAt`),
      ...(raw.host === undefined
        ? {}
        : { host: textOrEmpty(raw.host, `${where}.host`, ELEMENT_LIBRARY_HOST_MAX) }),
      paste,
      html,
      ...(css === "" ? {} : { css }),
      ...(raw.ai === true ? { ai: true } : {}),
    };
  });

  return { categories, items };
}

/** An optional, length-capped string that may legitimately be empty (trimmed either way). */
function textOrEmpty(value: unknown, what: string, maxLen: number): string {
  if (typeof value !== "string") throw invalid(`${what} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLen) throw invalid(`${what} must be at most ${maxLen} characters.`);
  return trimmed;
}
