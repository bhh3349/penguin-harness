# The workbench's selection row is trimmed to its content

- **Date:** 2026-09-14
- **Type:** fix
- **Scope:** `web`

[中文](2026-09-14-workbench-selection-row.zh.md)

The row that carries the multi-select toggle and the picked-element chips was **41px tall for a 23px control**: it had 6.75px of vertical padding above and below, which put the lit toggle 9–10px away from the row's own top and bottom borders. That padding is now **2.25px**, the row measures **32px**, and the toggle sits **4px / 5px** from those borders. The address row above it is deliberately untouched.

## Details

- **One class**: `features/workbench/workbench-panel.tsx`, `px-3 py-1.5` → `px-3 py-0.5`. The horizontal padding (`px-3`) did not change — the complaint was the row's top and bottom, not its left.
- **Why the row was that tall.** The row centres its children (`items-center`), and its tallest child is a chip, whose text line-height makes a 27.5px content box — so the row's height was `27.5 + 2 × 6.75`. The padding was the only lever; the controls themselves were already at their compact rung.
- **Why the gap reads 4 / 5 rather than 2.25.** The 23px toggle is centred inside that 27.5px content box, so the distance to the border is `2.25 + (27.5 − 23) / 2 ≈ 4.5` — rounded up above the box and down below it.

## Verification

- New real-machine script `实测脚本/m62-选择行收紧/` (port 5194, the real desktop shell, 1920×1080, the demo page the user was looking at): **8/8**, 2 screenshots. Measured: the selection row **41px → 32px**, its vertical padding **6.75px → 2.25px**, the lit toggle **9px/10px → 4px/5px** from the row's borders while the toggle itself stays **23×23px**, the address row unchanged at **48px with 9px of padding**, three chips still on **one** row, and the row still flush against the address row above and the preview below — the trim left no gap between rows.
- `实测脚本/m61-面板宽度与按钮/` re-run in full: **18/18**, evidence refreshed — the width and button-size behaviour of the same panel is intact with the shorter row.
- typecheck / format:check / oxlint (0 warnings, 0 errors over 1245 files) / **2087 unit tests** green; `pnpm --filter @prismshadow/penguin-web build` clean.

## Limits

- **The address row was left alone** (48px, 9px of padding): the request named the selection row, and tightening the row that carries the address field is a separate judgement the user has not made yet.
- Measured only in the **zh UI**, on **Linux + Electron**, at one window size (1920×1080) with the workbench at its 384px default. At the 320px floor both rows still hold one line (m61), but the trim was not re-measured there.
- This is the second pass at this row: the previous change shrank the controls *inside* it; this one shrinks the row *around* them.
