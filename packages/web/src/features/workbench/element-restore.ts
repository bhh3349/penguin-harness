/**
 * The deterministic half of 「添加元素」 (L3): a browser's DevTools paste becomes a document that
 * renders on its own — no model, no network, and no guessing beyond what the paste actually says.
 *
 * Why this exists at all: a model can polish a paste (L3.4), but the panel must not *need* one to
 * show a user what they just pasted. So a paste is turned into a standalone document here, in pure
 * functions, and the AI step is an optional refinement on top of the same shape.
 *
 * What a paste can be, and what each becomes:
 *   - `Copy element` — a markup fragment. Rendered as-is (after sanitizing); with no styles it is an
 *     unstyled skeleton, and the caller says so rather than pretending the restore failed.
 *   - `Copy styles` — Chrome copies a **declaration list** (`padding: 8px 16px; color: …`), with no
 *     selector. With one root element in the paste the declarations are attached to it as a `style`
 *     attribute; with several they go on a wrapper, because there is nothing else honest to do with
 *     a rule that names no target.
 *   - both at once (markup + `<style>` blocks, or markup + a declaration list) — split apart first;
 *     that is the combination that renders closest to what the user saw.
 *
 * Sanitizing is not optional: whatever is stored here is rendered in a sandboxed iframe next to the
 * app, so `<script>`, inline `on*` handlers, `javascript:` URLs and `<base>` (which would rewrite
 * every relative URL) are dropped. The paste itself is kept verbatim beside the render — see
 * `element-library.ts` — so nothing is lost if the restore improves later.
 */
export type RestoreNotice =
  /** The paste held no markup at all (a styles-only copy), so there is nothing to show. */
  | "noMarkup"
  /** Markup with no styles: the honest name for what will render. */
  | "noStyles"
  /** A declaration list with a single root element — attached to it. */
  | "stylesAttached"
  /** A declaration list with several root elements — attached to a wrapper instead. */
  | "stylesWrapped"
  /** `<script>` (or its friends) was in the paste and is not in the render. */
  | "scriptsDropped"
  /** Relative image/font URLs, which cannot resolve without the page they came from. */
  | "relativeUrls"
  /** The paste was longer than a library item may hold, so the tail is not here. */
  | "truncated";

export interface RestoredElement {
  /** The markup fragment as restored (sanitized, possibly with a style attribute attached). */
  html: string;
  /** Style text that came with the paste — rule sets only. Empty when there were none. */
  css: string;
  /** The host the paste looks like it came from, from an absolute URL in it. Null when it names none. */
  host: string | null;
  /** What the user has to know about this render. Empty means "nothing to warn about". */
  notices: RestoreNotice[];
}

/** The paste kept per item, and the markup rendered from it — mirrors services/element-library.ts. */
export const RESTORE_PASTE_MAX = 20_000;
export const RESTORE_HTML_MAX = 40_000;
export const RESTORE_CSS_MAX = 40_000;

/**
 * The canvas a fragment is drawn on. Without it a restored button would inherit the *app's* font
 * and margins and read as a lie; with it the fragment's own styles are the only thing in play, which
 * is what "restored" means. It is a floor, not a theme: nothing here overrides a pasted rule.
 */
const CANVAS = [
  "html,body{margin:0;padding:16px;background:#fff;color:#111827;",
  'font:14px/1.5 system-ui,-apple-system,"Segoe UI","Noto Sans CJK SC",sans-serif}',
  "img,svg,video{max-width:100%}",
  "a{color:inherit}",
].join("");

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const SCRIPT_TAG = /<script\b[^>]*\/?>/gi;
const EVENT_ATTR = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL =
  /\s(?:href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi;
const DOC_TAGS = /<\/?(?:html|head|body)\b[^>]*>|<base\b[^>]*>/gi;
const ABSOLUTE_URL = /https?:\/\/([a-z0-9.-]+)/i;
const RELATIVE_URL =
  /(?:src|href)\s*=\s*(?:"(?!#|https?:|\/\/|data:|mailto:|tel:)[^"]*"|'(?!#|https?:|\/\/|data:|mailto:|tel:)[^']*')/i;
/** Elements with no closing tag: they cannot close a sibling, so they never affect root counting. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const TAG = /<(\/?)([a-z][a-z0-9-]*)\b[^>]*?(\/?)>/gi;

/** The standalone document for a stored item: the canvas, its styles, its markup. */
export function elementDocument(html: string, css?: string): string {
  const styles = css === undefined || css.trim() === "" ? "" : `<style>${escapeStyle(css)}</style>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CANVAS}</style>${styles}</head><body>${html}</body></html>`;
}

/** A paste is only CSS-ish when there is no markup in it at all. */
function splitPaste(text: string): { markup: string; css: string[] } {
  const css: string[] = [];
  const withoutStyles = text.replace(STYLE_BLOCK, (_whole, inner: string) => {
    css.push(inner);
    return "\n";
  });
  const first = withoutStyles.search(/<[a-z!/]/i);
  if (first < 0) return { markup: "", css: [...css, withoutStyles] };
  const lastTagEnd = withoutStyles.lastIndexOf(">");
  const markup = withoutStyles.slice(first, lastTagEnd + 1);
  // Text before the first tag or after the last one is not markup — when it is not blank it is the
  // declaration list of a `Copy styles` (the paste that pastes both gives markup and declarations).
  for (const aside of [withoutStyles.slice(0, first), withoutStyles.slice(lastTagEnd + 1)]) {
    if (aside.trim() !== "") css.push(aside);
  }
  return { markup, css };
}

/** How many top-level elements the fragment has; -1 when its tags do not nest. */
function rootCount(markup: string): number {
  let depth = 0;
  let roots = 0;
  TAG.lastIndex = 0;
  for (let match = TAG.exec(markup); match !== null; match = TAG.exec(markup)) {
    const [, closing, name, selfClosing] = match;
    const tag = (name ?? "").toLowerCase();
    if (VOID_TAGS.has(tag) || selfClosing === "/") {
      if (depth === 0) roots += 1;
      continue;
    }
    if (closing === "/") {
      depth -= 1;
      if (depth < 0) return -1;
    } else {
      if (depth === 0) roots += 1;
      depth += 1;
    }
  }
  return depth === 0 ? roots : -1;
}

function escapeStyle(css: string): string {
  // A rule set that contains `</style>` would close the block it lives in.
  return css.replace(/<\/style/gi, "<\\/style");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** The declarations of a `Copy styles`, on the element they were copied from. */
function attachDeclarations(markup: string, declarations: string): string {
  const opening = /<([a-z][a-z0-9-]*)\b([^>]*?)(\/?)>/i.exec(markup);
  if (opening === null) return markup;
  const whole = opening[0];
  const existing = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(whole);
  if (existing !== null) {
    const current = (existing[2] ?? existing[3] ?? "").trim().replace(/;+$/, "");
    const merged = current === "" ? declarations : `${current};${declarations}`;
    return markup.replace(whole, whole.replace(existing[0], ` style="${escapeAttr(merged)}"`));
  }
  const patched = whole.replace(/\/?>$/, (tail) => ` style="${escapeAttr(declarations)}"${tail}`);
  return markup.replace(whole, patched);
}

/** Drops everything in a paste that must not run beside the app; reports whether it found any. */
function sanitizeMarkup(markup: string): { markup: string; droppedScripts: boolean } {
  const droppedScripts = /<script\b/i.test(markup);
  const cleaned = markup
    .replace(SCRIPT_BLOCK, "")
    .replace(SCRIPT_TAG, "")
    .replace(EVENT_ATTR, "")
    .replace(JS_URL, "")
    .replace(DOC_TAGS, "")
    .trim();
  return { markup: cleaned, droppedScripts };
}

/** A paste becomes a standalone fragment — see the module comment for what each shape becomes. */
export function restoreFromPaste(paste: string): RestoredElement {
  const notices: RestoreNotice[] = [];
  let text = paste;
  if (text.length > RESTORE_PASTE_MAX) {
    text = text.slice(0, RESTORE_PASTE_MAX);
    notices.push("truncated");
  }

  const { markup: rawMarkup, css: cssChunks } = splitPaste(text);
  const { markup, droppedScripts } = sanitizeMarkup(rawMarkup);
  if (droppedScripts) notices.push("scriptsDropped");

  const rules = cssChunks
    .filter((chunk) => chunk.includes("{"))
    .join("\n")
    .trim();
  const declarations = cssChunks
    .filter((chunk) => !chunk.includes("{"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  let html = markup;
  // A declaration list names no selector, so where it can go depends on what it was copied with.
  if (declarations !== "" && html !== "") {
    if (rootCount(html) === 1) {
      html = attachDeclarations(html, declarations);
      notices.push("stylesAttached");
    } else {
      html = attachDeclarations(`<div>${html}</div>`, declarations);
      notices.push("stylesWrapped");
    }
  }
  if (html === "") notices.push("noMarkup");
  else if (rules === "" && declarations === "") notices.push("noStyles");
  if (html !== "" && RELATIVE_URL.test(html)) notices.push("relativeUrls");

  const host = ABSOLUTE_URL.exec(html) ?? ABSOLUTE_URL.exec(text);
  return { html, css: rules, host: host?.[1]?.toLowerCase() ?? null, notices };
}
