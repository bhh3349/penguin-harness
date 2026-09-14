# Element library: collect elements from other sites

- **Date:** 2026-09-14
- **Type:** feat
- **Scope:** `web`, `server`

[中文](2026-09-14-element-library.zh.md)

The UI workbench gains an **element library**: a folder button at the end of the panel's address row opens a drawer that collects elements the user copied out of *other* sites with their browser's DevTools. Paste what `Copy element` / `Copy styles` gave you, see it **restored immediately** — no model in the loop — name it, and file it under a category. Entries are stored per user in `ui_prefs.elementLibrary`, so there is exactly one entrance (the panel) and no route of its own.

## Details

- **`features/workbench/element-restore.ts` (new, pure functions).** A paste becomes a standalone document: `restoreFromPaste()` splits `<style>` blocks into rules, treats a bare declaration list (what `Copy styles` copies) by attaching it to the paste's single root element — or to a wrapper when there are several roots, because a rule naming no selector has nothing else honest to bind to — and sanitizes what may never render beside the app (`<script>`, `on*`, `javascript:` URLs, `<base>`, `html|head|body`). `elementDocument()` draws the result on a canvas that fixes only background, font and margins, so a restored fragment is read against its own styles rather than the app's. Every choice the restore made is reported as a notice (`noStyles`, `stylesAttached`, `stylesWrapped`, `scriptsDropped`, `relativeUrls`, `noMarkup`, `truncated`) instead of being silent.
- **`features/workbench/element-library.ts` (new, pure functions).** The stored blob is read defensively (`normalizeLibrary` drops entries it cannot show — dangling category, duplicate id, blank fields — rather than taking the drawer down), and every write is refused with a named reason (`empty-name`, `duplicate-name`, `too-many-categories`, `no-markup`, `no-category`, `too-many-items`, `too-large`, `not-enough-room`). Deleting a category takes its elements with it; deleting an element does not touch the category.
- **`features/workbench/element-library-drawer.tsx` (new).** The drawer reads prefs **on first open, not at app start** — someone who never opens it never pays for the blob. A failed read keeps the library *unknown* (with a retry) rather than writing an empty one over everything the user ever collected. Writes are optimistic with rollback plus a toast. Renders in an `<iframe sandbox="allow-scripts">` fed by `srcdoc`, the same treatment the Workspace's own HTML preview gets.
- **`server/src/services/element-library.ts` (new) + `PUT /api/me/prefs`.** `ui_prefs` is free-form in its keys, not in its length: the library holds user-authored text, so it is validated and capped **on the write path** the way `draftShortcuts` already is — 30 categories, 100 items, 60-character names, 20k paste / 40k markup / 40k styles per item, and 1 MB for those three summed over the whole library. Items are normalized to the declared fields (an extra key cannot ride along as unbounded storage), a `categoryId` must exist in the same library, and anything invalid is a **400 `invalid_element_library` that writes nothing**.
- **`workbench-panel.tsx`.** The folder button stands after the picker — the one control in that row that says nothing about *this* page — and is offered whether or not anything is loaded. The drawer is an inset panel of the panel itself (`absolute inset-0`), so it covers the address row while it is open: closing is the drawer's own × or Esc.

## Verification

- New real-machine script `实测脚本/m65-元素库/` (port 5178, the real desktop shell on its own `--user-data-dir`, 1920×1080) **16/16**, 4 screenshots. The truth is not the model's: the script takes `outerHTML` plus the `getComputedStyle` declaration list (**475** declarations) from its own fixture page as the two pastes, and then compares the restored element against the source element: **8 computed properties identical** (`14px` / `700` / `2px` / `20px` / `uppercase` / `rgb(255, 255, 255)` / `flex` / `320px`) both in the draft preview and in the stored item re-rendered. Measured: the drawer lands at **384×951 @ x=1536**, identical to the panel root; the stored record is **12222 B** of paste and **12249 B** of markup, both byte-identical to what went in, with `host` read from the absolute URL in the paste; `<script>` / `onclick` / `javascript:` / `<base>` appear **0** times in either the sandbox or the server's copy while the original paste is kept verbatim; an over-cap markup and a dangling category are both refused with **400** and change nothing.
- New unit tests: `web/test/element-restore.test.ts` (**21**), `web/test/element-library.test.ts` (**9**), `server/test/element-library.test.ts` (**11**).
- typecheck / format:check / oxlint (0 warnings, 0 errors over 1255 files) / **2132 web unit tests** green; `pnpm --filter @prismshadow/penguin-web build` clean.

## Limits

- **The AI half is not here** (L3.4): this ships the deterministic restore, which is what the modal's "immediately, without waiting for the AI" label promises. The `ai` flag and its badge already exist for when that step is decided.
- **`Copy styles` was simulated**: the script pastes a `getComputedStyle` declaration list, which is the shape Chrome's own `Copy styles` produces, but the context menu itself was never clicked.
- **Entries cannot be sent to the conversation yet** (L3.3), and the library is stored per user (`ui_prefs`), not per project.
- Measured only in the **zh UI**, on **Linux + Electron 43.2.0**, at 1920×1080 with the panel at its 384px default; narrow panel, dark theme and the en UI were not measured.
- A drawer that covers the panel means the address row cannot be used while it is open — that is the trade this panel shape makes at 384px.
