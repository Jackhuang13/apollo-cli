# Textual 層移除計劃

- 日期: 2026-07-21(取代 2026-07-21 的抽離計劃 docs/textual-extraction-plan.md)
- 狀態: 待執行(TODO 見文末)
- 目標: **完全移除** `packages/tui/src/textual/` 框架層及其所有使用與引用(不遷移、不抽離為獨立 package)。
- 理由: textual 加入原意是置換經典 TUI、在 console 下呈現 GUI 式介面;但「console 上呈現真 GUI」與終端機(字元格矩陣)本質相違——圖片僅能靠 kitty/iterm2 協議能力門控、GUI 元件只能是文字級擬真,而 textual 層連圖片支援都是零。現行互動模式 100% 走經典 TUI,textual 在 repo 內零使用,保留僅增加 ~5,100 行維護面與 ~60 個多餘公共 API 符號。

## 一、現狀事實(已驗證)

| 項 | 值 |
|---|---|
| 規模 | 14 檔、約 5,123 行(src/textual/**)+ 測試 1 檔 445 行 |
| 外部 npm 依賴 | 零 |
| repo 內消費者 | **僅** `packages/tui/test/textual.test.ts`(Pilot-driven) |
| coding-agent 使用 | 零(全部為經典 TUI API) |
| 核心 → textual 反向相依 | 無(tui.ts、components/* 均不 import textual) |
| 接合點 | `packages/tui/src/index.ts:124` 的 `export * from "./textual/index.js"` |
| 文件引用 | coding-agent/docs/textual-tui.md、docs.json:123、index.md:55、architecture.md:93 |
| 孤兒藍圖 | `src/modes/interactive/theme/apollo.tcss`(以 textual 為目標的 planned layout,repo 內無 loader) |

### 死代碼分析(移除後無附帶死代碼)

textual 從 pi-tui 核心 import 的符號,**全部仍被經典 TUI 或 coding-agent 使用**,移除 textual 後不需連帶刪任何核心代碼:

| 符號 | textual 外使用者 |
|---|---|
| decodePrintableKey (keys.ts) | components/editor.ts(2 處)、test/keys.test.ts |
| sliceByColumn (utils.ts) | tui.ts、components/input.ts、fullscreen.ts、test/wrap-ansi.test.ts |
| stripAnsi (utils.ts) | tui.ts、components/markdown.ts、fullscreen.ts、utils.ts 內部、多個測試 |
| InputOptions (components/input.ts) | Input 類別自身(constructors param) |
| Input (components/input.ts) | coding-agent tree-selector.ts、menu-panel.ts |
| Editor / Loader / Markdown / TUI / Container / keys 等 | coding-agent 大量使用(經典 API) |

測試基礎設施: textual 用自身 pilot.ts 的 VirtualTerminal;不依賴 tui 的 `test/virtual-terminal.ts`(經典 TUI 測試專用,9 個測試檔共用,保留)。

## 二、移除影響

1. **coding-agent:零改動。** 所有 import 均為經典 TUI API。
2. **pi-tui 公共 API(breaking)。** ~60 個 textual 符號(App、Screen、Widget、Textual* widgets、CSS parser、Pilot 等)離開 package 根;依 repo 版本規則屬 **minor**(API breaking),lockstep 下全 package 同步 bump。
3. **extension 生態。** `bundled-modules.ts` 同捆整個 pi-tui;移除後 extension 無法再取得 textual class。repo 內 extension 範例(questionnaire)只用經典 `Editor`,不受影響。
4. **無新依賴、無 build 順序變動。** 只縮小 pi-tui,不改 workspace/build script/tsconfig。
5. **測試面縮減。** tui 的 vitest include 從 [wrap-ansi, textual] 收為 [wrap-ansi];check:test-policy 少掃一個檔案,無新增風險。

## 三、TODO 清單

### Phase 0 — 決策(需使用者確認)
- [ ] D1: 移除範圍 = 完全刪除(源碼 + 測試 + 文件 + 藍圖),不留 archive、不抽離(預設)
- [ ] D2: `src/modes/interactive/theme/apollo.tcss` 刪除(預設;AGENTS.md 要求刪功能性代碼先確認)

### Phase 1 — 刪除 textual 本體
- [ ] `git rm -r packages/tui/src/textual`(14 檔,~5,123 行)
- [ ] `git rm packages/tui/test/textual.test.ts`(445 行)
- [ ] (依 D2) `git rm packages/coding-agent/src/modes/interactive/theme/apollo.tcss`

### Phase 2 — 接線與配置
- [ ] `packages/tui/src/index.ts`: 刪 `export * from "./textual/index.js"`(1 行)
- [ ] `packages/tui/vitest.config.ts`: include 改為僅 `test/wrap-ansi.test.ts`

### Phase 3 — 文件
- [ ] `git rm packages/coding-agent/docs/textual-tui.md`
- [ ] `packages/coding-agent/docs/docs.json`: 移除 :123 的 textual-tui.md 條目
- [ ] `packages/coding-agent/docs/index.md`: 移除 :55 的 textual 條目
- [ ] `packages/coding-agent/docs/architecture.md`: :93 段落刪除 textual 描述(保留經典 TUI 敘述)

### Phase 4 — Changelog 與驗證
- [ ] `packages/tui/.changes/<slug>.md`: `Removed the Textual-style framework layer (App/Screen/Widget/CSS/Pilot) from the package root. It had no in-repo consumers; the classic differential-rendering TUI remains the only rendering engine.`(breaking → minor)
- [ ] `npm run check` 全綠(biome / check:test-policy / tsgo / installer / push-guard / browser-smoke)
- [ ] `npm run test`(workspaces): pi-tui 剩餘測試綠;coding-agent 套件綠
- [ ] `npm run build`(build 順序不變)
- [ ] 殘留檢查: `grep -rni textual packages --include="*.ts" --include="*.json" --include="*.md" -l | grep -v node_modules` → 僅剩 CHANGELOG 歷史與本文檔
- [ ] 依 AGENTS.md Git Rules 以具名 `git add <paths>` 分 commit;commit 訊息註明 breaking change

## 四、風險與備註

- **唯一實質風險 = 公共 API breaking**(~60 符號離開 pi-tui 根)。repo 內零消費者;外部面以 changelog + minor bump 緩解。
- **無附帶死代碼**: 核心符號全部仍有使用者,不需連帶刪除(已逐項驗證)。
- 回滾: 純刪除 + 少量配置行,`git revert` 可完整回退。
- 若日後要重啟「文字級 GUI 元件」路線,經典 TUI 的 Component/Overlay/CSS-less 盒模型已涵蓋 TextualInput/OptionList 等功能(以 Editor/SelectList/Input 為基底),textual 層無不可替代資產。
