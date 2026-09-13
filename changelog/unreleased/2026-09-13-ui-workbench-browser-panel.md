# The workbench panel is a browser now: the arrow at the right of the address bar is "select an element"

- **Date:** 2026-09-13
- **Type:** change
- **Scope:** `web`

[中文](2026-09-13-ui-workbench-browser-panel.zh.md)

The panel looks like a browser rather than a form. **The address row is the only chrome it always has**: a state dot, the address, an enter-key load button, a reload, and **the arrow at the right of the row** — press it to enter pick mode, press it again to leave, exactly as in DevTools. While a page is loaded and healthy there is **no second row** under the address; only a failure, an empty state, or a page with no readable source map costs one line. The selection row is one row too: `[multi][clear][picked elements / candidate] [add to conversation]`.

## Details

- **The status strip is gone; the state moved back to where it belongs.** The colour of the dot at the left of the address *is* the state, and the whole sentence (`Connected · url · tier`) lives in its hover text and accessible name. The old `Connected · http://… · exact tier` line spent the preview's height every second of every session to say "nothing is wrong" 99% of the time.
- **Load became the enter key.** A browser has no "load" button, it has this key. The accessible name is still `载入` / the same one the text button had, so nothing that finds it by name has to know it became a mark; the address box's own Enter still loads.
- **The pick switch moved into the address bar and defaults to off.** It is an `aria-pressed` icon button: press to enter pick mode (the page highlights, clicks are stopped), press again to hand the page back. **A panel that just opened is a plain browser** — until you press it, the page is just a page.
- **`暂离` (stand down) is gone** — `paused`, `pickMode: "paused"` and the `pause`/`resume` events went with it (`workbench-state.ts`). What standing down was for is "the page is mine again, but my picks stay", and **switching the arrow off is exactly that**: `toggle` only moves `wanted` and never touches `picked`. Two entrances doing one thing; the one that survived is the switch this feature always had.
- **In its place: `清除` (clear).** One press empties the whole batch (each chip keeps its own ×) and **does not leave pick mode** — emptying a batch is not deciding to stop picking. It sits outside the multi-select mark because it is about what is already picked, and must stay reachable once picking is switched off.
- **The payload card is gone** (field rows, the JSON fold and `data-workbench-payload` all deleted). The panel no longer lays the payload out for the user; the payload path itself is untouched — it still travels on "add to conversation" into the composer's chip and out with the message. **The cost is plain**: that card was the only place a person could read the payload *before* sending (a chip carries just the element's name and its `refId` tooltip), so the "show it to you first" gate is gone and "you pressed the button" is the only gate left — the panel's own known-limits row about the return channel now says so.
- The count in the selection row is no longer a printed number but the container's accessible name (`3 selected`); `data-workbench-count` is still there for the scripts.

## Verification

- New real-machine script `实测脚本/m60-面板形态/` (port 5194, real desktop shell): **29/29**, 9 screenshots. What it measured: after a load, "Connected" appears **0** times in the panel's text (it lives in the dot's `aria-label`); the arrow starts `aria-pressed=false` with the page reporting `{active:false}`; the preview is 650px tall before the selection row appears and 587px after; with the arrow switched off the state is `{active:false, picked:2}` with both chips still in the row; after clear it is `{active:true, multi:true, picked:0}` (still in pick mode); and the message that goes out still carries a `v1` payload whose location equals the AST truth.
- Unit tests (web package **2086/2086**, 148 files) pin the argument: `keeps the picks when the arrow is switched off — which is why 暂离 is gone`, plus `empties the batch on one 清除, and keeps the page it was picked on`.
- typecheck / format:check / oxlint (0 warnings, 0 errors) / build all green; the full web e2e suite (59 cases) compared case by case against the baseline taken before this change: **not one new failure**.

## Limits

- **No real-machine run of the English UI**: it is covered by the two dictionaries' shape/placeholder tests only.
- **There is no longer a way to preview a payload before sending.** That is the real trade-off here, recorded as D33 in the decision log; the natural place to bring it back would be the composer's chip.
- The older real-machine scripts that observed the payload card (`m26` / `m27` / `m31` / `m33` / `m34` / `m41` / `m43` / `m51` / `m53` / `m56` / `m57` / `m58`) **now point at UI that no longer exists** and must be re-based on the sent message before they are used; `m54` / `m56` / `m57` measured the card *itself*, so their observation surface has to be redefined.
