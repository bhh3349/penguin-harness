# The element payload collapses to one row in the transcript

- **Date:** 2026-09-14
- **Type:** feat
- **Scope:** `web`

[中文](2026-09-14-element-reference-row.zh.md)

Picking an element in the workbench writes a line of prose and a fenced JSON payload into the message, and the message is what the Agent reads. The transcript then printed that message — being the user's own — verbatim, so a bubble held kilobytes of `parentChain`, computed styles and a source snippet, with the sentence the user actually typed somewhere after it. The payload now draws as **one collapsed row per reference** — `Element reference: span.badge "Active users" · src/App.jsx:5` — which expands onto exactly the bytes that were sent. **The message text itself is untouched**, character for character.

## Details

- **The message is the Agent's channel** (PRD §6), so nothing here filters, rewrites or re-generates it: `features/chat/element-reference.ts` only decides *what the transcript draws*, and `message-item.tsx` renders the references as rows ahead of the body. Expanding a row shows `raw` — the panel's prose plus the payload JSON, byte for byte, the same bargain the transcript already strikes for `[use_skills]`, the `/agent` handoff and a scheduled trigger.
- **A block is recognised by its payload `kind`, never by its fence language.** A ```json block the user pasted stays exactly where it was; so does a payload whose `schemaVersion` this build cannot draw — an unknown payload is still readable as text, while a chip claiming to summarise it would be a lie.
- **The row wears the chip's name.** A payload keeps its classes in `style.classes` and its id in `attributes.id`, so naming an element from the payload alone needed one new function (`element-payload.ts`'s `payloadElementLabel`) — which delegates the wording to the existing `elementLabel`, so the transcript and the panel's composer chip cannot drift into two names for one element. `describeTarget` and `elementLabel` now declare the fields they actually read (`Pick<ElementFacts, …>`) rather than the whole fact set.
- **The same reduction covers input history and the outline** (`user-message-body.ts` is the renderer-free copy of that parse chain), so recalling the message with ↑ gives back the sentence the user typed.
- **Default collapsed, and it opens** — the same shape as the existing protocol banners, with one difference: a payload is something the user is owed a look at, which is what is left of D30's "the payload is shown before it goes" now that the panel no longer renders a payload card (D33).
- **Known trade-off:** the copy button on the message copies the user's text with the protocol block stripped (as it already does for `[use_skills]` and the handoff notices). The full text stays on the Trace page, and the expanded row is selectable.

## Verification

- New real-machine script `实测脚本/m63-载荷收成一行/` (port 5179, the real desktop shell, 1920×1080, the m59 fixture, positions against the AST truth table): **11/11**, 3 screenshots. The transcript draws one row (`aria-expanded="false"`, 33px) whose visible text holds no ```` ```json ````, no `"schemaVersion"` and no `"refId"` while the typed sentence is intact; the row's name equals the composer chip's name plus ` · src/App.jsx:7`; opening it shows a `<pre>` **character-identical** to the reference's own slice of the sent message; closing it goes back to one row; ↑ recall returns the typed sentence alone.
- **The other side of the boundary, measured from outside the UI**: `GET /api/sessions/:id/messages` still returns the message with `kind`, `schemaVersion`, `source.file`, `confidence: "exact"` and the same `target.refId` the composer chip carried.
- A v2 batch (two elements, one file) is still **one** row: `2 elements / 1 file`, no JSON in the bubble.
- New unit tests `packages/web/test/element-reference.test.ts` (**15**): the bytes handed back are the bytes sent; someone else's ```json block, an unparseable one and an unknown `schemaVersion` all stay in the text; two references keep their order and their own prose; the recogniser is repeatable; and `payloadElementLabel` says what `elementLabel` says for the same element.
- typecheck / format:check / oxlint (0 warnings, 0 errors over 1248 files) / **2102 unit tests** green; `pnpm --filter @prismshadow/penguin-web build` clean.

## Limits

- **What the Agent receives did not change at all** — this is a rendering change, and the test that matters most is the one above that reads the message back off the server.
- Only the zh UI was measured, on Linux + Electron, at one window size (1920×1080). In a narrow transcript the row's label ellipsizes (the full text is its tooltip).
- The row names an element from what the payload carries: an element whose `id` is not in the payload's `attributes` is named without the `#id` (the picker always records it, so this is a reader's limit, not a picker's).
