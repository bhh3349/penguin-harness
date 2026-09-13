# Multi-select in the workbench: pick several elements at once and send them as one message (the payload gains v2)

- **Date:** 2026-09-13
- **Type:** feature
- **Scope:** `web`

[中文版](2026-09-13-ui-workbench-multi-select.zh.md)

Picking an element has gained a state inside it: click several elements to build a batch, then hand the Agent
**one message** about all of them. "Three edits inside one component" and "one change crossing two files" are now
one pick and one sentence instead of one message per element. The default is still the single pick it always
was — anyone who never touches this switch sees exactly the L1 panel.

## Details

- **Multi-select is a state inside pick mode, not a second mode** (`features/workbench/workbench-state.ts`).
  The panel gains a `多选元素` / `退出多选` switch; `PickState` goes from one selection to a list of them
  (`picked: ElementFacts[]`) beside a `multi: boolean`, and `NO_PICK` and the reducer follow. **Entering the
  state changes nothing** except what the next click means: replace, or add.
- **One element is the same panel it was, byte for byte.** `currentPick(state)` reads the last entry of that
  list, and everything L1 did with "the selection" — source resolution, the payload card, §9.4's limits, the
  `已选中 …` line — still reads that one element. A batch is shown *as* a batch (a count and a row per element)
  and inspected one element at a time, so a single pick renders exactly as before.
- **What a click means is the panel's decision, not the page's** (`element-picker.ts`). The picker only reports
  that something was clicked; `reducePick` decides whether that replaces the selection or toggles one element in
  or out of it (`togglePick` — being already in the batch is what makes a click take it back out, so "click it
  again in the page to remove it" is not a second rule). The page therefore cannot paint a highlight the panel
  has already dropped.
- **The highlight went from one box to a pool of them.** The picker draws **one green box per pick** from the
  panel's list and re-places them on scroll, re-render and HMR; the blue box (the candidate under the cursor)
  follows the pointer only while **nothing is picked** or **multi-select is on** — a locked single selection
  must not keep moving. There is one source of truth between the two: the panel pushes its selectors into the
  page (`setPicked`), and the boxes are that list drawn.
- **One pick can be taken back from either end, by the same rule**: an `×` on each row in the panel, or
  clicking the same element again in the page. Both arrive as the same `unpick`.
- **Leaving multi-select lands on a single selection, keeping the last one picked** (`picked.slice(-1)`).
  Dropping the batch would throw away work and keeping the first would keep the one the user is not looking at —
  the single-selection UI has one slot, and it belongs to the element just clicked.
- **Escape is still two-step, it just clears the batch in one step**: with anything picked it empties the batch,
  with nothing picked it leaves pick mode. Clearing is not the same as quitting — someone pressing Escape means
  "I picked the wrong one", not "I am done picking".
- **A batch's identity is the set of its elements, not an element** (`batchRefId`): the chip's id is `elb-` plus
  the FNV of its members' sorted `refId`s, so picking the same set in another order is the same message (the chip
  is updated in place rather than added) and it can **never** collide with an element's own `el-…` — a batch is
  not an element.

## The payload: v2 is here, and v1 stayed

- **The shape follows the count, not the mode** (`element-payload.ts`). **One** element is the v1 payload it
  always was, unchanged — an Agent that has only ever seen one element never meets a new shape. **Several** go
  out as `schemaVersion: 2`: one `page` (a batch can only come from the document on screen) plus
  `elements: [...]`, each member carrying the element's own half of the L1 payload (`target` / `source` /
  `style`). This is the shape PRD §6 rule 4 reserved.
- **Same-file grouping is computed, not sorted**: `groupByFile` groups members by the file they were written in
  and `orderByFile` is that grouping flattened — the **same function** decides the order of the JSON's `elements`
  and the groups the message's prose names, so the two can never disagree about which edits belong together.
  Elements nothing could locate form a group of their own (`batchNoFile`) rather than being handed an invented
  file.
- **The message is still one sentence plus one fenced JSON**; the sentence just lists by file:
  `选中的 UI 元素（3 个，来自 2 个文件，同文件的排在一起）：`, then one line per file naming its elements with
  the line each resolved to.
- `page` and `projectRoot` are stated once, and the chip reads `3 个元素 / 2 个文件` — what the user wants to see
  is how far this change reaches, not three ids.

## The element that went away (every one is re-read before sending)

- **A batch is not "one bigger element", so it does not inherit the single-element rule**: every member is
  re-read before sending and **a vanishing member does not hold the whole batch back** (`batchDecision`). The
  ones that went away are dropped from the message and the rest still go out — holding back two valid edits
  because one card is gone would make the user redo them. Only a batch where **every** element is gone is held
  (the message would then carry the user's words and nothing to edit).
- **The two directions say different things, because different things happened.** Holding reuses L1's words in
  all three places (panel / chip marked `已消失` / toast `没有发送`). A partial drop marks the chip red with
  **`少 N 个`** (`ComposerReference.dropped`, deliberately not `stale`: this message *went out*) and the panel's
  line says the missing ones were dropped and the rest still went, and that re-picking them is one click in the
  page. Both are red; one says "not sent", the other says "sent with less".
- **Dropping members makes the message genuinely smaller**: the JSON in the panel, the count on the chip, the
  prose and `elements` are all rebuilt from what survived, so the JSON the user reads in the panel is the JSON
  that goes out.
- The refresh's "never show another element's location" invariant (M5.1) is unchanged: the resolutions moved from
  one slot to a **map keyed by the selection** (`ResolvedSources`, keyed by page URL + selector), so several
  members resolve at once and none can read another's file and line.

## Measured

- On a real desktop shell against real Vite HMR (`实测脚本/m59-多选/`, port 5193): **36/36**. Three elements
  across two files (`h2.card-title` / `p.card-note` in `src/App.jsx`, `span.badge` in `src/Badge.jsx`) become
  **one** message with **one** json block and `schemaVersion: 2`, and all three positions in the card and in the
  message **equal** the AST truth (which is computed from the source, never asked of the product).
- The same run measures the default single pick (`multi: false`, v1), the count / row list / green boxes staying
  in step as clicks go 1 → 2 → 3, the `×` and a second page click each removing exactly one element, and leaving
  multi-select keeping the last one. Delete **one** element and send: the message goes out, the payload drops to
  two elements, the panel says the rest still went, the chip reads `少 1 个`. Delete **both** and send: nothing
  new in the transcript, the toast says `没有发送`, the chip reads `已消失`, and the draft is still there.
- Unit tests +20 (web package 2076/2076 across 147 files), with typecheck, format:check and oxlint green and the
  web package building.

## Limits

- The partial-drop path is measured on a real page only for the `missing` reason (an element deleted outright);
  `replaced` and `page-changed` under a batch are covered by the single-element path's tests (m41 / m54).
- The red `少 N 个` chip exists only in the instant before the send resolves (a successful send clears the
  composer's references), so the acceptance script catches it with a DOM mutation observer; the panel's own line
  is the stable evidence.
