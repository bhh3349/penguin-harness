# 载荷在对话里收成一行

- **Date:** 2026-09-14
- **Type:** feat
- **Scope:** `web`

[English](2026-09-14-element-reference-row.md)

在工作台里拾取一个元素，会把一句散文加一整块 fenced JSON 载荷写进消息，而消息就是 Agent 读的东西。transcript 又把这条消息当作「用户自己发的」逐字打印 —— 于是气泡里躺着十几 KB 的 `parentChain`、计算样式和源码片段，用户真正打的那句话在它后面。现在每个载荷块在对话里画成**一行收起的「元素引用」**——`元素引用：span.badge "Active users" · src/App.jsx:5`——点开就是发出去的那份原文。**消息本身一个字没动。**

## 细节

- **消息是 Agent 唯一的通道**（PRD §6），所以这里没有任何过滤、改写或重造：`features/chat/element-reference.ts` 只决定**画什么**，`message-item.tsx` 把这些引用画成正文之前的一行行。点开一行看到的是 `raw` —— 面板写的那句散文加载荷 JSON，逐字，和 transcript 对 `[use_skills]`、`/agent` 交接、定时触发早就采取的是同一个口径。
- **认块靠载荷自己的 `kind`，不靠围栏语言。** 用户自己粘的 ```json 块原地不动；这个 build 画不出来的 `schemaVersion` 也原地不动 —— 看不懂的载荷还能当文本读，而一个声称"我概括了它"的 chip 是在说谎。
- **这一行戴的就是 chip 的名字。** 载荷把类名放在 `style.classes`、把 id 放在 `attributes.id`，要从载荷本身给元素起名就需要一个新函数（`element-payload.ts` 的 `payloadElementLabel`）—— 文案仍旧交给既有的 `elementLabel`，所以 transcript 与面板输入框里的 chip 不可能漂成同一个元素的两种名字。`describeTarget` 与 `elementLabel` 也顺手改成只声明它们真正读的字段（`Pick<ElementFacts, …>`），而不是整个事实集。
- **输入历史与会话大纲走同一条收敛**（`user-message-body.ts` 是那条解析链的无渲染副本），所以按 ↑ 召回的是用户打的那句话本身。
- **默认收起、但点得开** —— 和既有那几个协议横幅同形，只差一点：载荷是用户有权看一眼的东西，而这也是 D30 那句"发送前能瞄一眼"在面板不再画载荷卡（D33）之后剩下的部分。
- **已知取舍：** 消息的复制按钮复制的是去掉协议块的用户文本（对 `[use_skills]` 与交接通知本来就是这样）。完整原文仍在 Trace 页，展开的这一行也可以选中复制。

## 实测

- 新真机脚本 `实测脚本/m63-载荷收成一行/`（端口 5179，真桌面壳，1920×1080，m59 的 fixture，位置一律与 AST 真值比）：**11/11**，3 张截图。transcript 画出的是**一行**（`aria-expanded="false"`、33px），它的可见文字里没有 ```` ```json ````、没有 `"schemaVersion"`、没有 `"refId"`，而用户打的那句话原样在；这一行的名字 = 面板 chip 的名字 + ` · src/App.jsx:7`；点开出现的 `<pre>` 与"这条消息里属于引用的那一段"**逐字相同**；再点收回到一行；↑ 召回的是那句话本身。
- **这条边界的另一半从 UI 之外量**：`GET /api/sessions/:id/messages` 读回的那条消息里，`kind`、`schemaVersion`、`source.file`、`confidence: "exact"` 都在，`target.refId` 与发送前 chip 上的是同一个。
- v2 批量（两个元素、同一个文件）同样只有**一行**：`2 个元素 / 1 个文件`，气泡里同样没有 JSON。
- 新单测 `packages/web/test/element-reference.test.ts`（**15** 条）：交回去的字节就是发出去的字节；别人的 ```json 块、解析不了的块、不认识的 `schemaVersion` 都留在文本里；两个引用保持各自顺序与各自的散文；识别器可重复；`payloadElementLabel` 与 `elementLabel` 对同一个元素说出同一句话。
- typecheck / format:check / oxlint（1248 个文件 0 错 0 警）/ web 单测 **2102/2102** 全绿；`pnpm --filter @prismshadow/penguin-web build` 干净。

## 边界

- **Agent 收到的东西完全没有变** —— 这是渲染层的改动，最要紧的那条判据就是上面"从服务端把消息读回来"的那一条。
- 只在 **zh 界面**、**Linux + Electron**、一个窗口尺寸（1920×1080）下量过。对话栏窄的时候这一行的标签会省略号截断（完整文案在它的 tooltip 里）。
- 这一行的名字来自载荷携带的东西：`id` 不在载荷 `attributes` 里的元素，名字里就没有 `#id`（picker 总会记下来，所以这是读方的边界，不是 picker 的）。
