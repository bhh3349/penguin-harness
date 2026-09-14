# 元素库：把别的网站上的元素收进来

- **日期：** 2026-09-14
- **类型：** feat
- **范围：** `web`、`server`

[English](2026-09-14-element-library.md)

UI 设计工作台多了一个**元素库**：面板地址行末尾的文件夹按钮打开一个抽屉，专门收用户用浏览器开发者工具从**别的网站**复制下来的元素。把 `Copy element` / `Copy styles` 给你的东西贴进来，**立刻**看到它被还原出来（这一路不问模型），起个名字，归到一个分类下。条目按人存在 `ui_prefs.elementLibrary` 里，因此入口只有一个（面板），也没有自己的路由。

## 细节

- **`features/workbench/element-restore.ts`（新，纯函数）。** 一份粘贴变成一个自包含文档：`restoreFromPaste()` 把 `<style>` 块拆成规则集，把裸声明串（`Copy styles` 复制的就是它）挂到粘贴里**唯一的根元素**上 —— 多根时套一层容器，因为一串不指名选择器的规则没有别的诚实去处 —— 并清掉绝不能挨着应用渲染的东西（`<script>`、`on*`、`javascript:` URL、`<base>`、`html|head|body`）。`elementDocument()` 把结果画在一块只定底色/字体/边距的画布上，于是还原出来的片段是按它自己的样式读的，而不是按应用的。还原做过的每一个判断都变成一条提示（`noStyles`、`stylesAttached`、`stylesWrapped`、`scriptsDropped`、`relativeUrls`、`noMarkup`、`truncated`），不静默。
- **`features/workbench/element-library.ts`（新，纯函数）。** 存下来的那份是**防御式**读的（`normalizeLibrary` 丢掉画不出来的条目 —— 悬空分类、重复 id、空字段 —— 而不是把抽屉带崩），每一次写都被以具名理由拒绝（`empty-name`、`duplicate-name`、`too-many-categories`、`no-markup`、`no-category`、`too-many-items`、`too-large`、`not-enough-room`）。删分类会连它的元素一起删；删元素不碰分类。
- **`features/workbench/element-library-drawer.tsx`（新）。** 抽屉**首次打开才读** prefs，不在应用启动时读 —— 从不打开它的人不为这份 blob 付代价。读失败时保持"未知"（带重试），**不会**用一个空库覆盖掉用户攒下的一切。写入是乐观的，带回滚与 toast。渲染在 `<iframe sandbox="allow-scripts">` + `srcdoc` 里，与 Workspace 自己的 HTML 预览同一套处置。
- **`server/src/services/element-library.ts`（新）+ `PUT /api/me/prefs`。** `ui_prefs` 自由的是 key、不是长度：元素库装的是用户写的文本，所以它和 `draftShortcuts` 一样**在写入路径上**校验与截断 —— 30 个分类、100 个条目、60 字名字、单条 20k 粘贴 / 40k 标记 / 40k 样式，以及这三项**全库合计 1MB**。条目被归一化成声明的字段（多出来的 key 不能当免费存储），`categoryId` 必须存在于同一个库里，任何不合法都是 **400 `invalid_element_library`，什么都不写**。
- **`workbench-panel.tsx`。** 文件夹按钮站在选择箭头之后 —— 那一行里唯一一个与**这个**页面无关的控件 —— 无论有没有载入页面都提供。抽屉是面板自身的内部面（`absolute inset-0`），所以开着的时候它盖住地址行：收起是抽屉自己的 × 或 Esc。

## 验证

- 新真机脚本 `实测脚本/m65-元素库/`（端口 5178，真桌面壳、自己的 `--user-data-dir`，1920×1080）**16/16**、4 张截图。真值不来自模型：脚本从自己的夹具页面取 `outerHTML` 与 `getComputedStyle` 的声明列表（**475 条**）当那两份粘贴，然后把还原出来的元素与源页面那个元素逐字比：**8 项计算样式完全相同**（`14px` / `700` / `2px` / `20px` / `uppercase` / `rgb(255, 255, 255)` / `flex` / `320px`），草稿预览一次、存档再渲染一次。量到：抽屉落在 **384×951 @ x=1536**，与面板根一致；存档是 **12222 B** 粘贴 + **12249 B** 标记，与贴进去的逐字相同，`host` 取自粘贴里的绝对 URL；`<script>` / `onclick` / `javascript:` / `<base>` 在沙箱与**服务端那份**里各出现 **0** 次，而粘贴原文一字不动地留着；超上限的标记与悬空分类都被 **400** 挡下，且什么都不改。
- 新单测：`web/test/element-restore.test.ts`（**21**）、`web/test/element-library.test.ts`（**9**）、`server/test/element-library.test.ts`（**11**）。
- typecheck / format:check / oxlint（0 错 0 警，1255 文件）/ web 单测 **2132 条**全绿；`pnpm --filter @prismshadow/penguin-web build` 干净。

## 边界

- **AI 那半不在这里**（L3.4）：这次交付的是确定性还原，也正是弹窗里那句「立刻给你，不等 AI」的承诺。`ai` 标记与它的徽章已经留好，等那一步定了再填。
- **`Copy styles` 是模拟的**：脚本贴的是 `getComputedStyle` 的声明列表，与 Chrome 自己的 `Copy styles` 形态一致，但没有真的点过那个右键菜单。
- **条目还不能送进对话**（L3.3）；元素库按**人**存（`ui_prefs`），不是按项目。
- 只在 **zh 界面、Linux + Electron 43.2.0、1920×1080、面板默认 384px** 下量过；窄面板、暗色主题、en 界面没量。
- 抽屉盖住面板，意味着它开着的时候地址行用不了 —— 那是这个面板形态在 384px 下的取舍。
