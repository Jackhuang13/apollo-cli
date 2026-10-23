# IScript 待修補問題討論（依程式碼實測核實）

- 日期: 2026-10-23
- 來源: 對齊 `docs/iscript-failure-review.md` 與目前 codebase（`apollo-cli-runtime`、`packages/coding-agent`）之實測結果
- 目的: 彙總尚未修復、部分修復或存在架構隱患的具體項目，供後續開發討論與實作交付

---

## 品牌與設計共識（已知並容許）

- **TUI cell 渲染維持 `deno` 標籤**：
  `packages/coding-agent/src/core/tools/code-preview.ts` 與 `iscript-cell.ts` 中將程式碼預覽語言標註為 `deno` 屬既定品牌標識，**刻意容許保留**，不視為待修補 defect。提示詞（System Prompt）已明確定義底層 runtime 為 Node (`node:vm`)，配合 traceback 自動 recovery hint 即可引導模型。

---

## 待修補與校正項目清單

### 1. `createAllToolDefinitions()` 與文檔宣稱不一致 — 已校正(2026-10-23)

- **核實結論**: 雙名註冊為**刻意保留**的 legacy alias,非未完成清理:
  - `packages/coding-agent/src/core/tools/index.ts` L60–72: `createAllToolDefinitions()` 回傳 `{ iscript, ipython }`,兩者使用同一個 `createIScriptToolDefinition`、不同 `name`。
  - 回歸測試 `packages/coding-agent/test/suite/regressions/4428-remove-legacy-pi-mono-tools.test.ts`(L44–50)斷言 `Object.keys(...) toEqual(["iscript", "ipython"])` 且 `parseArgs` 可解析 legacy `ipython` — 雙註冊被測試鎖定。
- **處理**: 已校正 `docs/iscript-failure-review.md` 命名對照段(L10–14),明確雙名註冊為預期行為。
- **殘留決策**: 若未來要徹底汰除 `ipython`,需同步修改回傳值、相容層與 4428 測試(目前不排程)。

---

### 2. 多行 Statement 換行切分(ASI 模擬)邊界情況 — V8 實測核實 + 部分修正(2026-10-23)

以 V8(`node:vm`,含 pure node 交叉驗證)逐例核實原清單的 boundary case 後,結論與原清單有出入:

#### 2.1 行首 `(`/`[`(call / index continuation)— **維持現行切分,不改行為**

- V8 實測: `123 (4)`、`"x" (1)` **皆可通過編譯** — 對 literal 的 call 是 runtime TypeError,不是 SyntaxError。因此 V8 的 goal-directed ASI 在 `(`/`[` 前**永不插入分號**(continuation parse 恆成立)。
- 但在 statement-oriented REPL 中,「恆合併」是危險行為:獨立陳述式行(例如 `const xs = get()` 後接 `[1, 2].forEach(...)`)會被合併成 `get()[1, 2]`,語義靜默改變 — 與真實 JS 檔案裡的 ASI 坑相同。
- 現行 `_CONTINUATION_LINE_HEAD`(repl.ts L518)只接受**不可能開頭新 statement** 的 token(`.`、反引號、`?`、`,`、二元運算子、`in`、`instanceof`),保守切分是刻意設計。**決定: 不加入 `(`/`[`**;以上 V8 證據作為設計依據記錄於此。

#### 2.2 行首 `/`(除法 vs regex)— **已修正除法跨行;regex 行維持切分**

- V8 實測: `foo()\n/bar/.test(s)` 在 V8 **本身就是 SyntaxError**(V8 嘗試 division continuation `foo() / bar / .test(s)` 而失敗,不回溯)。現行 splitter 切成兩條可執行 statement 的行為**優於 V8**,維持不變。
- 真正的缺陷是**除法跨行** `a\n/ b`: V8 合併成 `a / b`,舊 splitter 卻切成兩句(第二句 `/ b` 單獨執行期報錯)。
- **修正(本次)**: 新增 `_nextLineIsDivisionContinuation()`(repl.ts L569)— 下一行首個 significant token 為 `/` 且**後接空白**時視為 division continuation 合併(regex literal 不可能以空白開頭,故該形態必為除法);裸 `/x` 維持切分。邊界測試已加入 `apollo-cli-runtime/test/repl.test.ts`(多行 chain 回歸測試,12/12 綠)。

#### 2.3 (新) regex literal lexing gap — **open,待排程**

頂層 scanner 與完整性快檢都不認 regex literal,兩處已驗證後果:
1. `_isSyntacticallyCompleteStatement`(L506)行尾 operator 快檢把結尾 `/`(regex 的閉合記號)當成 division 運算子 → 以 regex 結尾的 statement 被誤判不完整、吞入下一行 → `const re = /x/\n/y/.test("y")` 整格 SyntaxError(live kernel 已驗證)。
2. (已排除) 曾懷疑頂層 scanner 會把 regex body 內的 `//` 誤讀成行註解 — 核實後不成立:合法 regex body 不可能含相鄰 `//`(第一個未 escape 的 `/` 即結束 regex),body 以 `*` 開頭(`/*`)在 V8 本身也是 syntax error,故 scanner 的 comment lexing 與合法 regex 不衝突。
唯一真實 gap 即上述 #1(結尾 `/` 快檢誤判),修法:在快檢(或 scanner)對結尾 `/` 依前一個 significant token 判定 regex/Division,變更範圍含快檢 + scanner,建議獨立排程。

- **參照更正**: `_nextLineContinuesExpression` 參數名為 `from`(舊稿誤寫 `i`);切分主函為 `_splitTopLevelStatements`(L351);項 1 的註冊函行號為 L60–72(舊稿誤寫 60–71)。
