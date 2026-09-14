/**
 * The element reference a preview selection becomes, read back out of a message.
 *
 * What the panel contributes to the conversation is a line of prose naming the elements plus the
 * payload as a fenced JSON block (`workbench/element-payload.ts`'s `elementReferenceText`), and the
 * composer splices that in *in front of* whatever the user typed (`chat-input.tsx`'s
 * `withReferences`, one unit per chip). So a message with a selection in it carries its payload in
 * the middle of the bubble: kilobytes of `parentChain`, computed styles and a source snippet, sitting
 * in a bubble the user is looking at — and, being the user's own message, printed verbatim
 * (`message-item.tsx` renders `user_text` as `whitespace-pre-wrap` text, not markdown).
 *
 * **The message text does not change here, and must not.** It is the Agent's only channel (PRD §6:
 * the payload travels with the message), so this module decides only what the *transcript draws*:
 * the blocks come out of the text, the renderer draws each as one collapsed row whose expansion is
 * exactly what was sent — the prose and the JSON, byte for byte. That is the same bargain the
 * transcript already strikes for `[use_skills]` (`skills-banner.tsx`), the `/agent` handoff and a
 * scheduled trigger: collapsed in the conversation, verbatim on the Trace page.
 *
 * A ```json block that is **not** ours — the user pasted one — is left exactly where it is: a block
 * is recognised by its payload `kind`, never by its fence language.
 *
 * Order is assumed rather than guessed at: reference units come first, the user's own words last
 * (`withReferences` joins them in that order). Everything between one block and the next is that
 * block's own prose, and everything after the last one is what the user typed.
 */
import { S } from "../../lib/strings";
import {
  PAYLOAD_KIND,
  PAYLOAD_SCHEMA_VERSION_BATCH,
  groupByFile,
  payloadElementLabel,
} from "../workbench/element-payload";
import type { ElementPayload, ElementPayloadBatch } from "../workbench/element-payload";

/** Either shape a reference can carry: one element (v1) or several from one page (v2, L2.1-b). */
export type ElementReferencePayload = ElementPayload | ElementPayloadBatch;

export interface ParsedElementReference {
  /** The row's label — who this reference is about, short enough for one line. */
  label: string;
  /** Exactly what this reference wrote into the message: the panel's prose and the payload JSON. */
  raw: string;
  payload: ElementReferencePayload;
}

export interface ParsedElementReferences {
  references: ParsedElementReference[];
  /** What the user typed: everything after the last payload block. */
  body: string;
}

/**
 * The one shape `elementReferenceText` writes. Non-greedy, and it is a *recognizer* rather than a
 * parser: whatever it hands back is then required to be a JSON object carrying our `kind`.
 */
const FENCED_JSON = /```json\r?\n([\s\S]*?)\r?\n```/g;

/** The payload inside a block, or null when the block is somebody else's JSON. */
function payloadOf(body: string): ElementReferencePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as { kind?: unknown; schemaVersion?: unknown };
  if (candidate.kind !== PAYLOAD_KIND) return null;
  // The versions this build knows how to draw; a future one falls back to showing the text, which is
  // the honest failure: an unknown payload is still readable, a chip claiming to summarise it is not.
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== PAYLOAD_SCHEMA_VERSION_BATCH) {
    return null;
  }
  return parsed as ElementReferencePayload;
}

/** Where the element was written, as short as it can honestly be: `src/App.jsx:5`, or just the file. */
function whereOf(file: string | undefined, line: number | undefined): string {
  if (file === undefined) return "";
  return line === undefined ? file : `${file}:${line}`;
}

/** The label for one reference — the same facts the panel's own chip names, in the transcript's words. */
export function elementReferenceLabel(payload: ElementReferencePayload): string {
  if (payload.schemaVersion === PAYLOAD_SCHEMA_VERSION_BATCH) {
    return S.chat.elementReference(
      S.workbench.batchChip(payload.elements.length, groupByFile(payload.elements).length),
    );
  }
  const element = payloadElementLabel(payload.target, payload.style.classes);
  const where = whereOf(payload.source.file, payload.source.line);
  return S.chat.elementReference(where === "" ? element : `${element} · ${where}`);
}

/**
 * Split a message into the element references it carries and the text the user actually typed.
 * A message with no reference comes back as `{ references: [], body: text }` — trimmed either way,
 * since the composer pads the parts with blank lines and the bubble should not.
 */
export function parseElementReferences(text: string): ParsedElementReferences {
  const references: ParsedElementReference[] = [];
  // Where the still-unclaimed text starts: everything before this belongs to a reference already,
  // everything after it is either the next reference's prose or the user's own words.
  let claimed = 0;
  FENCED_JSON.lastIndex = 0;
  for (let match = FENCED_JSON.exec(text); match !== null; match = FENCED_JSON.exec(text)) {
    const payload = payloadOf(match[1] ?? "");
    if (payload === null) continue; // not ours: it stays in the text, where it was
    references.push({
      label: elementReferenceLabel(payload),
      raw: text.slice(claimed, match.index + match[0].length).trim(),
      payload,
    });
    claimed = match.index + match[0].length;
  }
  return { references, body: text.slice(claimed).trim() };
}
