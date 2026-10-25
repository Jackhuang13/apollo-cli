# IScript REPL 改善計劃 (IScript REPL Improvement Plan)

- 關聯文件：[docs/iscript-repl-open-questions.md](file:///home/ck/apollo-cli/docs/iscript-repl-open-questions.md)
- 日期：2026-10-25
- 狀態：Ready for Implementation
- 目標：解決模型在 cell 內無法自我觀察的 runtime 機制盲點，強化 Node/Deno 雙 runtime 相容性與診斷、明文化 Revival/Compaction 契約、提供 Kernel 重啟熔斷與技能內省能力，並消除雙 runtime 下的 TypeScript 語法支援落差。

---

## 改善工作分期與優先序 (Phasing & Priority)

| 階段 | 編號 | 主題 | 涉及模組 | 優先度 |
|---|---|---|---|---|
| **Phase 1: 診斷、語法與防禦** | IMP-01 (對應 OQ-02) | Node/Deno 錯誤提示增強與 Runtime 標註 | `apollo-cli-runtime/src/rlm/repl.ts` | P1 |
| | IMP-06 (對應附錄 1) | 雙 Runtime 一致的 TypeScript 型別剝離（OXC AST fallback） | `apollo-cli-runtime/src/rlm/repl.ts` | P1 |
| | IMP-02 (對應 OQ-03) | Kernel Boot 崩潰重試預算、熔斷與半開恢復機制 | `packages/coding-agent/src/core/kernel/repl-manager.ts` | P1 |
| **Phase 2: 內省與狀態契約** | IMP-03 (對應 OQ-04) | Cell 模組載入順序規範、撞名語意與專屬技能內省 API | `apollo-cli-runtime/src/rlm/repl.ts`, `mod.ts`, `iscript.ts` | P2 |
| | IMP-04 (對應 OQ-01) | Revival 快照邊界規範、Manifest `skipped` 串接與結構化通知 | `apollo-cli-runtime/src/rlm/repl.ts`, `state-snapshot.ts`, `agent-session.ts`, docs | P2 |
| | IMP-05 (對應 OQ-05) | Compaction 變量剪裁通知與可恢復式 Tombstone 機制 | `apollo-cli-runtime/src/rlm/repl.ts`, `agent-session.ts` | P2 |

---

## 詳細實施計劃 (Detailed Action Items)

### 1. IMP-01: Node/Deno 雙 Runtime 差異診斷與提示增強 (對應 OQ-02)

#### 1.1 目標
在執行失敗與崩潰時，主動告知當前 Kernel 執行時環境（Node 還是 Deno）以及已知的 Runtime 特殊差異，避免模型盲目猜測與反覆重試。

#### 1.2 具體改動
1. **擴充 `_knownFailureHint`**（[apollo-cli-runtime/src/rlm/repl.ts](file:///home/ck/apollo-cli/apollo-cli-runtime/src/rlm/repl.ts#L808)）：
   - 捕捉 `ReferenceError: Buffer is not defined`：提示「目前運行於 Deno；請引入 `node:buffer` 或使用 `Uint8Array`」。
   - 捕捉 `TypeError: timer.unref is not a function`：提示「目前運行於 Deno；Timer 物件不帶 `.unref()`，請透過 `Deno.unrefTimer`」。
   - 捕捉 `node:child_process/promises` 或 `.promises is undefined`：提示「Deno 尚未完整支援 `node:child_process/promises`，建議使用 `node:util` 的 `promisify`、callback 或 `Deno.Command`」。
2. **Traceback 標註 Runtime**：
   - 在 `_formatTraceback` 中，統一將目前環境資訊附加於結尾或提示行（例如：`[Kernel Runtime: deno 2.1.9]` 或 `[Kernel Runtime: node 22.x]`）。
3. **CI 冒煙測試矩陣**：
   - 於 `apollo-cli-runtime/test/` 增加雙 runtime 測試項，覆蓋上述易碎 API。

---

### 2. IMP-02: Kernel Boot 重試預算、熔斷與半開恢復機制 (對應 OQ-03)

#### 2.1 目標
避免 Kernel 進入連續崩潰迴圈（例如二進位遺失 ENOENT、bootstrap 語法崩潰），防止浪費模型 turn 預算與 token；同時保留環境修復後的自動／手動恢復途徑。

#### 2.2 具體改動
1. **重啟計數與熔斷狀態**（[packages/coding-agent/src/core/kernel/repl-manager.ts](file:///home/ck/apollo-cli/packages/coding-agent/src/core/kernel/repl-manager.ts)）：
   - 在 `ReplManager` 內增加 `consecutiveBootFailures: number`、`lastBootFailureTime: number` 與 `lastBootError: string`。
   - 設定上限 `MAX_CONSECUTIVE_BOOT_FAILURES = 3` 與冷卻時間 `BOOT_CIRCUIT_COOLDOWN_MS = 30_000`（30 秒）。
   - 當連續啟動失敗達 3 次且未逾冷卻時間：
     - 進入熔斷狀態，拒絕立即重啟子行程。
     - 直接拋出結構化錯誤：`KernelBootCircuitBrokenError: Kernel failed to boot 3 consecutive times (Phase: <phase>). Last error: <stderr_tail>. Auto-restart is paused for 30s; fix the environment or binary before retrying.`
2. **失敗階段細分**：
   - 明確標記失敗階段：`[Phase: Process Spawn]`（如 ENOENT）、`[Phase: Ready Handshake]`（如 watchdog/boot crash）、`[Phase: Re-bootstrap]`。
3. **半開（Half-Open）與重置機制**：
   - **成功即歸零**：只要任一次 `waitForReady` 與 bootstrap 成功完成，`consecutiveBootFailures` 立即重置為 `0`。
   - **冷卻後半開探測**：距離 `lastBootFailureTime` 超過 `30s` 後，下一次工具呼叫允許放行 1 次重啟嘗試（Half-Open）；若成功則解除熔斷，若失敗則重新計時冷卻。
   - **顯式重置**：呼叫 `replManager.restart()` 時無條件重置計數器與熔斷狀態。

---

### 3. IMP-03: Cell 模組載入順序規範、撞名語意與專屬技能內省 API (對應 OQ-04)

#### 3.1 目標
嚴格區分「Apollo Skills（代理人技能）」與「一般環境套件（node_modules / ESM）」，釐清 `__apollo_import__` 作為萬用 Module Loader 的解析層次與變數撞名規則，並提供包含可用狀態的「技能內省」管道。

#### 3.2 具體改動
1. **模組載入解析優先順序規範與文件化**（[apollo-cli-runtime/src/rlm/repl.ts](file:///home/ck/apollo-cli/apollo-cli-runtime/src/rlm/repl.ts#L1565)）：
   - `__apollo_import__` 本質為 Cell 的通案 Import 路由器（因 VM 禁止原生靜態 import，所有 import 語法皆由 AST 改寫為此呼叫）。
   - 解析分層規範（明確劃分技能與一般依賴）：
     - **第一層（代理人技能 Apollo Skills）**：已註冊於 `skillImportMap` 的技能（來源為 `$APOLLO_SKILLS_DIR` 與 `packages/coding-agent/skills`）。優先級最高，避免同名 skill 被本地 `node_modules` 遮蔽。
     - **第二層（本機 CommonJS / Node 模組）**：非技能時，走 `require()` 解析本地 `node_modules` 與 `node:*` 內建模組。
     - **第三層（ESM 模組 Fallback）**：動態 `import()` 解析，支援 ESM 模組載入。
2. **Bare Global Skill 與 Cell 頂層變量撞名語意**：
   - Bootstrap 階段會將技能預掛載至 `globalThis[skillName]`（Bare Global）。
   - 若模型在 Cell 內宣告同名頂層變數（如 `const edit = 123`），Cell 內局部與後續 `globalThis.edit` 允許被使用者變數覆蓋（但該變數被列入 `_userGlobals`）。
   - **救回機制**：即使 Bare Global 被使用者同名變數覆蓋，顯式執行 `import edit from "edit"` 或 `await __apollo_import__("edit")` 恆從 `skillImportMap` 讀取原始技能模組並重新綁定。
3. **提供專屬技能內省 API（含健康狀態，嚴格排除一般套件）**：
   - 在 `rlm` 全域物件注入 `rlm.list_skills()`。
   - **範圍限制**：僅回傳真正註冊的 Apollo Skills，**絕對不混入** `node_modules` 或通用 npm 套件。
   - **狀態整合**：結合 Bootstrap 階段（[iscript.ts](file:///home/ck/apollo-cli/packages/coding-agent/src/core/tools/iscript.ts#L108)）記錄的載入結果，回傳結構化陣列：
     ```ts
     Array<{
       name: string;
       path: string;
       status: "available" | "unavailable";
       error?: string; // 若 status === "unavailable"，提供具體載入失敗原因
     }>
     ```

---

### 4. IMP-04: Revival 快照邊界明文化、Manifest 串接與結構化通知 (對應 OQ-01)

#### 4.1 目標
打通 Snapshot 階段 `kernel-state.json` (manifest) 與 Restore 階段的資訊斷層，讓模型在 turn 初始清楚知道哪些變量成功復原、哪些變量在快照時被略過（skipped）或反序列化失敗，以及具體原因。

#### 4.2 具體改動
1. **修補 `handleRestore` 的 Manifest 讀取斷層**（[apollo-cli-runtime/src/rlm/repl.ts](file:///home/ck/apollo-cli/apollo-cli-runtime/src/rlm/repl.ts#L1343)）：
   - 目前 `handleRestore` 僅從 `kernel-state.json` 讀取 `manifestJson.types`，忽略了快照階段記錄的 `manifestJson.skipped`（如 `unserializable_type`、`exceeds_max_variable_bytes`、`exceeds_max_bytes`）與 `manifestJson.pruned`。
   - 改動：`handleRestore` 一併提取 `skipped` 與 `pruned` 陣列並放入協定回傳與 `RestoreResult`（[state-snapshot.ts](file:///home/ck/apollo-cli/packages/coding-agent/src/core/kernel/state-snapshot.ts#L33)）。
2. **增強 `[python-state-restored]` 通知訊息**（[packages/coding-agent/src/core/agent-session.ts](file:///home/ck/apollo-cli/packages/coding-agent/src/core/agent-session.ts#L8669)）：
   - 區分三類狀態呈現給模型：
     - `Restored & Verified`: 完整可用之變數。
     - `Restored with caveats`: 如 Class 實例原型遺失（`prototype_lost`）或深層結構（`complex_structure`），提示模型需重新綁定方法或實例化。
     - `Not Restored (Skipped / Failed)`: 合併快照階段 `skipped` 與恢復階段 `failed` 的變數，並附帶原因說明（例如：`fnName (unserializable_type: function)`, `bigBuf (exceeds_max_variable_bytes: >16 MiB)`）。
3. **補全文檔**（[packages/coding-agent/docs/iscript-kernel.md](file:///home/ck/apollo-cli/packages/coding-agent/docs/iscript-kernel.md)）：
   - 明列規格：單變量上限 16 MiB (`DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES`)、快照總上限 256 MiB (`DEFAULT_SNAPSHOT_MAX_BYTES`)。
   - 明列不可序列化清單：Function、Symbol、Promise、弱引用（WeakMap/WeakSet）、外部 Handle/Socket/Stream。

---

### 5. IMP-05: Compaction 變量剪裁通知與可恢復式 Tombstone 機制 (對應 OQ-05)

#### 5.1 目標
消除模型對「從未定義變量」與「被 compaction 剪除變量」的混淆，同時確保模型可隨時重新賦值覆寫該變量而不會觸發唯讀屬性錯誤。

#### 5.2 具體改動
1. **可恢復式 Tombstone 佔位（Getter + Setter）**（[apollo-cli-runtime/src/rlm/repl.ts](file:///home/ck/apollo-cli/apollo-cli-runtime/src/rlm/repl.ts#L1113)）：
   - 維護內部表 `_prunedGlobals = new Map<string, { size_bytes: number; reason: string }>()`。
   - 當 `pruneOversized` 觸發（單變量 >16 MiB 或總量 >256 MiB）時，從 `_userGlobals` 移除該名稱，並透過 `_installPrunedTombstone(name, info)` 在 `globalThis` 定義存取器：
     ```ts
     function _installPrunedTombstone(name: string, info: { size_bytes: number; reason: string }): void {
       _prunedGlobals.set(name, info);
       Object.defineProperty(globalThis, name, {
         configurable: true,
         enumerable: false, // 避免干擾 Object.keys(globalThis)
         get() {
           const mb = (info.size_bytes / (1024 * 1024)).toFixed(1);
           throw new ReferenceError(
             `Variable '${name}' was removed during compaction (${info.reason}: ${mb} MiB > 16 MiB limit). Re-create or reload it if needed.`,
           );
         },
         set(newValue: unknown) {
           // 模型重新賦值時，自動解除 Tombstone 並恢復為正常全域變數
           _prunedGlobals.delete(name);
           Object.defineProperty(globalThis, name, {
             value: newValue,
             writable: true,
             enumerable: true,
             configurable: true,
           });
           recordUserGlobal(name);
         },
       });
     }
     ```
2. **防範內部遍歷誤觸 Getter**：
   - 在 `handleListNames`、`handleSnapshot` 與 `_detectNewGlobalsAfterCell` 中，凡名稱存在於 `_prunedGlobals` 者一律跳過，不讀取 `g[name]`，避免觸發 Tombstone getter 導致協議崩潰。
   - 在 `handleRestore` 讀取 `manifest.pruned` 時，同步為被剪裁變數掛上 Tombstone，確保跨重啟後仍具備相同的因果錯誤提示。

---

### 6. IMP-06: 雙 Runtime 一致的 TypeScript 型別剝離 (對應 OQ-02 / 附錄 1)

#### 6.1 根因分析
目前 [`_stripTypeScript`](file:///home/ck/apollo-cli/apollo-cli-runtime/src/rlm/repl.ts#L332-L341) 依賴 `node:module.stripTypeScriptTypes(code, { mode: "strip" })`。此 API 在 Node 22.6+ 存在，但在 **Deno 2.1.9 的 `node:module` 相容層為 `undefined`**，導致 `_stripTypeScript` 在 Deno 下退化為 no-op，任何 TS 語法（如 `x as string`、參數型別 `: number`、`interface`）進入 `node:vm` 皆直接拋出 `SyntaxError`。

#### 6.2 具體改動（零外部依賴，基於內建 OXC WASM AST）
1. **實作基於 `@oxc-parser/wasm` 的輕量型別剝離 Fallback**（[apollo-cli-runtime/src/rlm/repl.ts](file:///home/ck/apollo-cli/apollo-cli-runtime/src/rlm/repl.ts#L332)）：
   - `repl.ts` 已內建載入 `./vendor/parser.js` (`@oxc-parser/wasm`)。
   - 當 `typeof moduleBuiltin.stripTypeScriptTypes !== "function"`（如 Deno 環境）或呼叫失敗時，使用 `parseSync(code, { sourceFilename: "cell.ts" })` 解析 AST。
   - 遍歷 AST 收集所有純型別語法區間並以同長度空白字元（保留換行符 `\n` 以維持精確行號與欄位偏移）替換：
     - 型別宣告語句：`TSInterfaceDeclaration`、`TSTypeAliasDeclaration`、`TSEnumDeclaration`（若為純 type）、`ImportDeclaration`（當 `importKind === "type"`）及個別 `ImportSpecifier`（當 `importKind === "type"`）。
     - 運算式型別標註：`TSAsExpression` / `TSSatisfiesExpression`（保留左側 `expression.start .. expression.end`，將 `expression.end .. node.end` 的 `as Type` 替換為空白）、`TSNonNullExpression`（移除末尾 `!`）、`TSTypeAssertion`。
     - 變數／函式／類別標註：`TSTypeAnnotation`、`TSTypeParameterDeclaration`、`TSTypeParameterInstantiation`、類別 `implements`、屬性 `definite`/`accessibility`/`readonly` 修飾符。
2. **不支援之 TS 執行期語法提示**：
   - 若遇到需要程式碼生成的語法（如 runtime `enum`、parameter properties `constructor(public x: number)`），在 `_knownFailureHint` 提供明確提示。

---

## 驗收標準 (Acceptance Criteria)

1. **雙 Runtime TS 語法驗收 (IMP-06)**：在 Node 與 Deno kernel 下執行含 `const x: number = ("42" as unknown as number)`、`interface Foo { a: string }`、`type Bar = number` 的 cell 皆能正常剝離型別並成功執行，且報錯行號不偏移。
2. **診斷驗收 (IMP-01)**：在 Deno runtime 觸發缺少 `Buffer`、`timer.unref` 或 `child_process/promises` 時，traceback 必須包含相應提示與 `[Kernel Runtime: deno ...]` 標註。
3. **重試熔斷與恢復驗收 (IMP-02)**：模擬 Kernel 崩潰情境，連續 3 次崩潰後立即熔斷並回傳含失敗階段的錯誤；驗證呼叫 `restart()` 或逾 30 秒冷卻後可正常恢復。
4. **內省與撞名驗收 (IMP-03)**：在 cell 中呼叫 `rlm.list_skills()` 僅回傳註冊的 Apollo Skills 及 `available`/`unavailable` 狀態（不含 `node_modules`）；頂層宣告同名變數後，仍可透過 `import` 載入原 skill。
5. **Revival 完整性驗收 (IMP-04)**：包含 function 與 >16 MiB 變數的會話在重啟恢復後，`[python-state-restored]` 訊息明確列出被 skipped 的變數名稱與原因。
6. **Tombstone 讀取與重賦值驗收 (IMP-05)**：宣告超過 16 MiB 之變數並觸發 compaction 剪裁後：(a) 讀取該變數拋出含大小與 compaction 原因的 `ReferenceError`；(b) `handleListNames` 不崩潰；(c) 重新對該變數賦值（如 `bigVar = 1`）可正常覆寫並恢復使用。
