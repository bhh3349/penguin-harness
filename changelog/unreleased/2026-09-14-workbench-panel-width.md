# The workbench panel opens at half the column's width, and its buttons are one rung smaller

- **Date:** 2026-09-14
- **Type:** change
- **Scope:** `web`

[中文](2026-09-14-workbench-panel-width.zh.md)

The dock column now opens at **20% of the window while the workbench is the tab showing** — on a 1920px window, 384px where it stood 768px — and the workbench panel's own chrome (load, reload, select-an-element, multi-select, clear, add-to-conversation) is drawn in a **23px box with a 12px glyph**, one rung below the app's other icon buttons, which are untouched. Every other tenant of that column — the subagent transcript, the file tree, a terminal — keeps the 40% it was chosen for.

## Details

- **The default is now per panel** (`defaultWidthFor(windowWidth, kind)` in `features/chat/use-panel-width.ts`; the one entry that names its own ratio is `workbench: 0.2`). The 40% was chosen for the reading surfaces: the subagent transcript ("a third of the window renders it as a narrow column of wrapped tool output") and the file tree, which falls back to its single-column drill-down below 480px — halving those would have been a layout change nobody asked for.
- **Only the default is per panel; the preference stays one value.** The width is deliberately shared by everything in the dock so switching tabs does not jump the column, and that is intact: the moment the user drags the divider, `penguin.panelWidth` holds that one width and every panel opens at it (`seedPanelWidth` does nothing while a stored width exists). Switching tabs with nothing dragged sizes the column to the incoming panel's own default; after a drag the tab strip behaves like the one column it is.
- **Two new rungs in the design system, used by this panel only**: `Button size="iconSm"` (`p-1` — 4.5px a side at this app's 18px base, so a 23px box with its border where `icon` is 29px) and `ICON_SIZE.compactButton` (12, where `iconButton` is 15). The six call sites in `workbench-panel.tsx` moved to them; nothing else in the app did.
- **Why the buttons moved with the width:** the column's floor is 320px, and this panel's chrome has to keep an address, four controls and a row of chips on one line at that width. The 29px box left the address box too little room; 22px does not.

## Verification

- New real-machine script `实测脚本/m61-面板宽度与按钮/` (port 5195, the real desktop shell, 1920×1080 window): **18/18**, 6 screenshots. Measured, not computed: the workbench column is **384px** at a 1920px window (20% of it); with the old default stored it is **768px** — the same ruler, twice the width; **switching that dock to its Files tab puts the column back at 768px** and switching back to the workbench returns 384px; the six buttons are **23px boxes with 12px glyphs** where `icon` is 29/15; the app's neighbouring icon button (the dock toggle) is unchanged at **33px**; the address row and the selection row are each still **one line** at 384px and at the 320px floor; the preview keeps **812px** of height; and the compact buttons still pick an element (count 1) and clear it (count 0).
- `test/panel-width.test.ts`: the 40% cases stay, plus the workbench's 20% ones (`1920 → 384`, `1280 → 320` under the floor) and two tenants that must not have moved. typecheck / format:check / oxlint (0 warnings, 0 errors) / **2087 unit tests** green.
- `e2e/dock.spec.mjs` (the spec that owns the panel-width behaviour): **11 passed / 1 failed**, the failure being the pre-existing stale `getByText("根目录")` assertion at `:275` that is red on the baseline too. The width cases — the default under 720, the drag past the old cap, the sidebar yielding — all pass.

## Limits

- **The one stored preference has no per-panel memory**: a user who has ever dragged the divider gets that width for every tab, the workbench included. Making the drag itself per panel would reopen the "switching tabs jumps the column" decision, which is why it is not here.
- **The measured numbers are the desktop shell's, at one window size.** A different window scales the default (it is a ratio) but the 320px floor takes over below a ~1600px window for the workbench.
- **`usePanelWidth()` — the old per-panel drag hook, and with it the window-shrink clamp — has had no callers since the dock took over the drag.** The clamp ("when the window shrinks, pull the width back within the cap") therefore does not run any more, so a column dragged wide on a big window stays wide in a smaller one and can squeeze the chat below its floor. Found while measuring this change; **not fixed here** — it is a separate defect in the dock refactor, and it wants its own decision.
