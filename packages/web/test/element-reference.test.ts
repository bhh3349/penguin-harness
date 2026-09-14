/**
 * Element references in the transcript (features/chat/element-reference.ts): what the bubble draws
 * instead of a wall of JSON.
 *
 * Two things carry the weight here, and each has its own group below. The first is that **the
 * message is not touched**: the payload is the Agent's channel (PRD §6), so the module is only ever
 * allowed to say what to draw — the bytes it hands back as a row's `raw` have to be the bytes that
 * were sent, and the user's own sentence has to come out whole. A renderer that quietly ate them
 * would look perfect in a screenshot. The second is the recogniser's honesty: a ```json block that
 * is not ours — the user pasted one, or it is a payload from a build that does not know it — stays
 * exactly where it was, because a chip claiming to summarise it would be a lie.
 *
 * The label's wording is pinned as a literal rather than compared against the same functions that
 * compose it (`elementLabel` · `file:line`): the point of the row is what a person reads.
 */
import { describe, expect, it } from "vitest";
import {
  elementReferenceLabel,
  parseElementReferences,
} from "../src/features/chat/element-reference";
import {
  PAYLOAD_KIND,
  buildBatchPayload,
  buildPayload,
  elementLabel,
  elementReferenceText,
  payloadElementLabel,
} from "../src/features/workbench/element-payload";
import type { ElementFacts, PageFacts } from "../src/features/workbench/element-picker";

const badge: ElementFacts = {
  tagName: "span",
  id: null,
  classList: ["badge"],
  cssSelector: "div.card > span.badge",
  role: null,
  name: "Active users",
  testId: "card-title",
  attributes: { class: "badge" },
  text: "Active users",
  computed: { "font-size": "12px", color: "rgb(17, 24, 39)" },
  rect: { x: 10, y: 20, width: 40, height: 18 },
  parentChain: ["div.card", "main#content"],
};

const card: ElementFacts = {
  ...badge,
  tagName: "div",
  classList: ["card"],
  cssSelector: "main#content > div.card",
  name: null,
  testId: null,
  text: "hello",
};

const page: PageFacts = {
  url: "http://127.0.0.1:5199/",
  title: "fixture",
  viewport: { width: 512, height: 526, dpr: 1 },
};

const ROOT = "/opt/OH-WorkSpace/my-app";

/** v1, located exactly — the ordinary case: the panel found the element in the source. */
const one = buildPayload({
  target: badge,
  page,
  projectRoot: ROOT,
  source: { file: "src/components/Badge.jsx", line: 5, column: 6, confidence: "exact" },
});

/** v1 with no location at all — `{confidence: "none"}`, which has no file to name. */
const unlocated = buildPayload({ target: badge, page, projectRoot: ROOT });

/** v2: two elements of one page, written in two different files (L2.1-b). */
const batch = buildBatchPayload([
  {
    target: badge,
    page,
    projectRoot: ROOT,
    source: { file: "src/Badge.jsx", line: 5, confidence: "exact" },
  },
  {
    target: card,
    page,
    projectRoot: ROOT,
    source: { file: "src/App.jsx", line: 7, confidence: "exact" },
  },
]);

const LEAD_ONE = `选中的 UI 元素：span.badge "Active users"（页面 http://127.0.0.1:5199/）`;
const LEAD_TWO = `选中的 UI 元素：div.card "hello"（页面 http://127.0.0.1:5199/）`;

describe("parseElementReferences", () => {
  it("hands the message's own bytes back unchanged, and the user's sentence with them", () => {
    const sent = `${elementReferenceText(LEAD_ONE, one)}\n\n把卡片调窄一点`;
    const parsed = parseElementReferences(sent);

    expect(parsed.references).toHaveLength(1);
    // Byte for byte: the prose the panel wrote, then the payload exactly as it went out. This is the
    // assertion that says "we draw it differently, we do not send it differently".
    expect(parsed.references[0]?.raw).toBe(elementReferenceText(LEAD_ONE, one));
    expect(parsed.references[0]?.raw).toContain('"kind": "penguin.ui-element-ref"');
    expect(parsed.references[0]?.raw).toContain('"schemaVersion": 1');
    expect(parsed.references[0]?.raw).toContain("src/components/Badge.jsx");
    expect(parsed.references[0]?.payload).toEqual(one);
    expect(parsed.body).toBe("把卡片调窄一点");
  });

  it("names the row with the element and where it is written — what the panel's chip says", () => {
    const parsed = parseElementReferences(elementReferenceText(LEAD_ONE, one));
    expect(parsed.references[0]?.label).toBe(
      '元素引用：span.badge "Active users" · src/components/Badge.jsx:5',
    );
  });

  it("names it by the element alone when nothing located it — no empty ` · `", () => {
    expect(elementReferenceLabel(unlocated)).toBe('元素引用：span.badge "Active users"');
  });

  it("names a batch by how many elements and how many files, one row for the lot", () => {
    const parsed = parseElementReferences(elementReferenceText(LEAD_ONE, batch));
    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0]?.label).toBe("元素引用：2 个元素 / 2 个文件");
  });

  it("leaves a message with no reference alone, trimmed", () => {
    const parsed = parseElementReferences(" 看看这个页面 \n\n");
    expect(parsed.references).toEqual([]);
    expect(parsed.body).toBe("看看这个页面");
  });

  it("returns an empty body when the message is nothing but the reference", () => {
    const parsed = parseElementReferences(`${elementReferenceText(LEAD_ONE, one)}\n\n`);
    expect(parsed.references).toHaveLength(1);
    expect(parsed.body).toBe("");
  });

  it("leaves a ```json block that is not ours exactly where the user put it", () => {
    const pasted = '```json\n{"kind":"something-else","schemaVersion":1}\n```';
    const parsed = parseElementReferences(`看这个：\n\n${pasted}`);
    expect(parsed.references).toEqual([]);
    expect(parsed.body).toBe(`看这个：\n\n${pasted}`);
  });

  it("takes ours out and leaves the user's own JSON behind it", () => {
    const pasted = '```json\n{"hello":"world"}\n```';
    const parsed = parseElementReferences(
      `${elementReferenceText(LEAD_ONE, one)}\n\n改成这样\n\n${pasted}`,
    );
    expect(parsed.references).toHaveLength(1);
    expect(parsed.body).toBe(`改成这样\n\n${pasted}`);
  });

  it("leaves a block of ours that this build cannot draw — an unknown schemaVersion", () => {
    const future = elementReferenceText(LEAD_ONE, one).replace(
      '"schemaVersion": 1',
      '"schemaVersion": 3',
    );
    const parsed = parseElementReferences(future);
    expect(parsed.references).toEqual([]);
    expect(parsed.body).toBe(future.trim());
  });

  it("leaves a block of ours that does not parse — a truncated payload still reads as text", () => {
    const broken = `选中的 UI 元素：span.badge\n\n\`\`\`json\n{"kind":"${PAYLOAD_KIND}",\n\`\`\``;
    const parsed = parseElementReferences(broken);
    expect(parsed.references).toEqual([]);
    expect(parsed.body).toBe(broken.trim());
  });

  it("keeps two references in the order they were sent, each with its own prose", () => {
    const sent = [
      elementReferenceText(LEAD_ONE, one),
      elementReferenceText(LEAD_TWO, unlocated),
      "两个都改一下",
    ].join("\n\n");
    const parsed = parseElementReferences(sent);

    expect(parsed.references.map((reference) => reference.label)).toEqual([
      '元素引用：span.badge "Active users" · src/components/Badge.jsx:5',
      '元素引用：span.badge "Active users"',
    ]);
    // Each row's prose is its own: the first row must not swallow the second's lead line.
    expect(parsed.references[1]?.raw.startsWith(LEAD_TWO)).toBe(true);
    expect(parsed.references[1]?.raw).not.toContain(LEAD_ONE);
    expect(parsed.body).toBe("两个都改一下");
  });

  it("answers the same question the same way twice — the recogniser's regex is not stateful", () => {
    const sent = `${elementReferenceText(LEAD_ONE, one)}\n\n${elementReferenceText(LEAD_TWO, batch)}`;
    const first = parseElementReferences(sent);
    const second = parseElementReferences(sent);
    expect(second).toEqual(first);
    expect(second.references).toHaveLength(2);
  });
});

/**
 * The row wears the chip's name: the transcript reads the payload back, the panel named the element
 * from the picker's facts, and a user comparing the two must not see two different names.
 */
describe("payloadElementLabel", () => {
  it("says what the picker's facts say — same element, same words", () => {
    expect(payloadElementLabel(one.target, one.style.classes)).toBe(elementLabel(badge));
    expect(payloadElementLabel(one.target, one.style.classes)).toBe('span.badge "Active users"');
  });

  it("finds the id where the payload keeps it, and still cuts the class list at two", () => {
    const identified: ElementFacts = {
      ...badge,
      id: "save",
      classList: ["btn", "primary", "lg"],
      // `attributes` is where the picker records the id (`element-picker.ts`'s `facts`), so that is
      // where a reader holding only the payload has to look for it.
      attributes: { class: "btn primary lg", id: "save" },
    };
    const built = buildPayload({ target: identified, page, projectRoot: ROOT });
    expect(payloadElementLabel(built.target, built.style.classes)).toBe(elementLabel(identified));
    expect(payloadElementLabel(built.target, built.style.classes)).toBe(
      'span#save.btn.primary "Active users"',
    );
  });

  it("names an element with no name and no text by its description alone", () => {
    const silent: ElementFacts = { ...badge, name: null, text: "" };
    const built = buildPayload({ target: silent, page, projectRoot: ROOT });
    expect(payloadElementLabel(built.target, built.style.classes)).toBe("span.badge");
  });
});
