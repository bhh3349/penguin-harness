/**
 * The deterministic half of 「添加元素」: what a DevTools paste renders as before any model sees it
 * (features/workbench/element-restore.ts, L3.2).
 *
 * The branches here are exactly the shapes a real paste arrives in — `Copy element` alone, `Copy
 * styles` alone, and the two together, which is the combination that actually renders — plus the
 * two things that must never reach the sandboxed iframe beside the app (a `<script>` and an inline
 * handler) and the one bound the server also enforces (the 20k paste cap). Every one of them is a
 * pure function, so each is a test rather than a browser session with DevTools open.
 */
import { describe, expect, it } from "vitest";
import {
  RESTORE_PASTE_MAX,
  elementDocument,
  restoreFromPaste,
} from "../src/features/workbench/element-restore";

const MARKUP = '<button class="btn">Sign in</button>';
const DECLARATIONS = "padding: 8px 16px; color: rgb(255, 255, 255);";

describe("restoreFromPaste — the three paste shapes", () => {
  it("renders a Copy element skeleton, saying it has no styles rather than that it failed", () => {
    expect(restoreFromPaste(MARKUP)).toEqual({
      html: MARKUP,
      css: "",
      host: null,
      notices: ["noStyles"],
    });
  });

  it("takes the rules out of a style block and leaves the markup bare", () => {
    const restored = restoreFromPaste(`${MARKUP}\n<style>.btn { padding: 8px 16px; }</style>`);
    expect(restored.html).toBe(MARKUP);
    expect(restored.css).toBe(".btn { padding: 8px 16px; }");
    // The markup is styled by the rule set, so "no styles" would be a lie.
    expect(restored.notices).toEqual([]);
  });

  it("attaches a declaration list to the single element it was copied from", () => {
    const restored = restoreFromPaste(`${MARKUP}\n\n${DECLARATIONS}`);
    expect(restored.html).toBe(
      '<button class="btn" style="padding: 8px 16px; color: rgb(255, 255, 255);">Sign in</button>',
    );
    expect(restored.css).toBe("");
    expect(restored.notices).toEqual(["stylesAttached"]);
  });

  it("wraps a declaration list when the paste has several roots, which name no target of their own", () => {
    const restored = restoreFromPaste("<span>a</span><span>b</span>\n\ncolor: red;");
    expect(restored.html).toBe('<div style="color: red;"><span>a</span><span>b</span></div>');
    expect(restored.notices).toEqual(["stylesWrapped"]);
  });

  it("merges into an element's own style attribute instead of writing a second one", () => {
    const restored = restoreFromPaste('<button style="color: red">x</button>\n\npadding: 8px;');
    expect(restored.html).toBe('<button style="color: red;padding: 8px;">x</button>');
    expect(restored.notices).toEqual(["stylesAttached"]);
  });

  it("escapes quotes a declaration list brings with it, so the attribute cannot end early", () => {
    const restored = restoreFromPaste('<b>x</b>\n\nfont-family: "Noto Sans";');
    expect(restored.html).toBe('<b style="font-family: &quot;Noto Sans&quot;;">x</b>');
  });

  it("keeps a declaration list off the markup when there is no markup at all", () => {
    // `Copy styles` on its own: the declarations name no selector, so nothing can be drawn from them.
    expect(restoreFromPaste(DECLARATIONS)).toEqual({
      html: "",
      css: "",
      host: null,
      notices: ["noMarkup"],
    });
    expect(restoreFromPaste(".btn { color: red; }")).toEqual({
      html: "",
      css: ".btn { color: red; }",
      host: null,
      notices: ["noMarkup"],
    });
  });
});

describe("restoreFromPaste — root counting", () => {
  it("counts a nested element as part of its parent, not as a second root", () => {
    const restored = restoreFromPaste("<div><button>a</button></div>\n\ncolor: red;");
    expect(restored.notices).toEqual(["stylesAttached"]);
    expect(restored.html).toContain('<div style="color: red;">');
  });

  it("counts a void element as a root of its own", () => {
    const restored = restoreFromPaste(
      '<img src="https://a.com/x.png"><img src="https://b.com/y.png">\n\ncolor: red;',
    );
    expect(restored.notices).toContain("stylesWrapped");
    expect(restored.html).toContain('<div style="color: red;">');
  });

  it("wraps rather than guessing when the tags do not nest", () => {
    const restored = restoreFromPaste("<div><span>a</div>\n\ncolor: red;");
    expect(restored.notices).toContain("stylesWrapped");
    expect(restored.html).toContain('<div style="color: red;">');
  });
});

describe("restoreFromPaste — what must not reach the iframe", () => {
  it("drops scripts, inline handlers, javascript: URLs and a base tag, and says it did", () => {
    const restored = restoreFromPaste(
      '<base href="/cdn/"><div onclick="steal()">hi</div><script>alert(1)</script>' +
        '<a href="javascript:void(0)">x</a>',
    );
    expect(restored.html).toBe("<div>hi</div><a>x</a>");
    expect(restored.notices).toEqual(["scriptsDropped", "noStyles"]);
  });

  it("does not call a paste with no scripts in it dropped", () => {
    expect(restoreFromPaste("<div>hi</div>").notices).toEqual(["noStyles"]);
  });
});

describe("restoreFromPaste — URLs", () => {
  it("flags relative URLs, which cannot resolve without the page they came from", () => {
    expect(restoreFromPaste('<img src="/logo.png" alt="logo">').notices).toEqual([
      "noStyles",
      "relativeUrls",
    ]);
  });

  it("says nothing about absolute, data and fragment URLs", () => {
    const restored = restoreFromPaste(
      '<img src="https://a.com/x.png"><a href="#top">top</a>' +
        '<img src="data:image/gif;base64,R0lGOD">',
    );
    expect(restored.notices).toEqual(["noStyles"]);
  });

  it("reads the host out of an absolute URL, lowercased", () => {
    expect(restoreFromPaste('<a href="https://Example.COM/docs">Docs</a>').host).toBe(
      "example.com",
    );
    expect(restoreFromPaste("<b>x</b>").host).toBeNull();
  });

  it("falls back to the paste as a whole when the markup itself names none", () => {
    const restored = restoreFromPaste(
      "<b>x</b><style>@font-face{src:url(https://fonts.example.com/x.woff2)}</style>",
    );
    expect(restored.html).toBe("<b>x</b>");
    expect(restored.host).toBe("fonts.example.com");
  });
});

describe("restoreFromPaste — bounds", () => {
  it("cuts a paste at the cap the server also enforces, and says so", () => {
    const long = "<i>x</i>".repeat(RESTORE_PASTE_MAX / 8 + 1);
    const restored = restoreFromPaste(long);
    expect(long.length).toBeGreaterThan(RESTORE_PASTE_MAX);
    expect(restored.notices[0]).toBe("truncated");
    expect(restored.html.length).toBeLessThanOrEqual(RESTORE_PASTE_MAX);
    expect(restored.html.length).toBeGreaterThan(0);
  });

  it("leaves a paste inside the cap alone", () => {
    expect(restoreFromPaste(MARKUP).notices).not.toContain("truncated");
  });
});

describe("elementDocument", () => {
  it("draws the canvas, then the item's styles, then its markup", () => {
    const doc = elementDocument("<b>x</b>", "b { color: red; }");
    expect(doc).toContain("<b>x</b>");
    expect(doc).toContain("<style>b { color: red; }</style>");
    expect(doc.match(/<style>/g)).toHaveLength(2);
    // The canvas fixes the font and margins so a restored fragment is not read against the app's own.
    expect(doc).toContain("system-ui");
  });

  it("omits the second style block when there is no style text", () => {
    expect(elementDocument("<b>x</b>").match(/<style>/g)).toHaveLength(1);
    expect(elementDocument("<b>x</b>", "   ").match(/<style>/g)).toHaveLength(1);
  });

  it("escapes a </style> in the styles so it cannot close the block it lives in", () => {
    const doc = elementDocument("<b>x</b>", 'a::after { content: "</style><script>"; }');
    expect(doc).toContain("<\\/style");
    expect(doc.match(/<\/style>/g)).toHaveLength(2);
  });
});
