# Phase 4.1 驗收缺陷矯正計劃（CAPA Plan）

- 依據文件：[`docs/harness-rlm-tune-suggest-phase4-1-acceptance-issues.md`](./harness-rlm-tune-suggest-phase4-1-acceptance-issues.md)
- 產出日期：2026-10-25
- 目標：逐項根治驗收單核實成立之 11 項缺陷（Blocker ×2、Major ×3、Minor ×5、工作樹衛生 ×1），達成 Node VM 與 Deno 雙環境實碼測試與代碼門禁 100% 通過。

---

## 一、 缺陷分類與矯正對策總表

| 缺陷編號 | 等級 | 問題本質 | 矯正策略（實碼層） |
|---|---|---|---|
| **A4-ACC-01** | **Blocker** | `createIScriptToolDefinition` 讀取全域 env 導致 AC-24 測試依賴本機 Deno 設定而失敗 | 1. 讓工具定義支援傳入受控 `env` 選項（或預設純淨）。<br>2. 在 `prompt-gate-repl-doctrine.test.ts` 中使用 `vi.stubEnv` 確保單元測試自包含，並補齊 Deno 分支文案斷言。 |
| **A4-ACC-02** | **Blocker** | `ReplKernelManager.doStart()` 靜默忽略非 Deno 的 interpreter override，導致 8 個失敗測試因成功啟動而拋錯 | 1. 明確 `options.python` override 語意：若使用者傳入顯式直譯器（且非標準 node binary），應優先調度該 override（或尊重無效路徑失敗）。<br>2. 修正 `ipython-provisioner.test.ts` 期望的失敗模式，使其與真實 TS Runtime 調度一致。 |
| **A4-ACC-03** | **Major** | 二進位發布（Bun binary）未隨附 `apollo-cli-runtime`，安裝後 kernel 必 throw | 在 `packages/coding-agent/scripts/copy-binary-assets.mjs` 的 `binaryAssets` 加入 `apollo-cli-runtime`，並在 `validateBinaryAssets` 加入 marker 校驗。 |
| **A4-ACC-04** | **Major** | `iscript-kernel.md` 文檔 5 處記載過期 Python fallback 邏輯 | 全面改寫 5 個過期章節，反映強制 TS runtime 與 Deno/Node 雙來源的真實架構。 |
| **A4-ACC-05** | **Major** | Host 端多處 Python 文案殘留（676/680 行、448 行錯誤訊息） | 1. 676/680 改為代表環境之語彙（"Waiting for IScript kernel..." / "Restarting IScript kernel..."）。<br>2. 448 行錯誤訊息改指 TS runtime。<br>3. 更新對應測試斷言。 |
| **A4-ACC-06** | **Minor** | Node 分支文案與規格不一致（"Node" vs "Node VM"） | 統一 Label、description、promptSnippet 中的 Node 命名為 "Node VM"。 |
| **A4-ACC-07** | **Minor** | 缺少 Deno 專用執行失敗引導（`_knownFailureHint`） | 在 `repl.ts` 的 `_knownFailureHint` 補上 Deno 環境下的專屬 hint（如 Deno 權限不足或 API 誤用提示）。 |
| **A4-ACC-08** | **Minor** | 計劃文件行號與片段引用漂移 | 同步校準計劃文檔中的行號引述與 `--unstable-node-globals` 參數。 |
| **A4-ACC-09** | **Minor** | 動態 Label 與預設啟動文案缺乏測試斷言 | 在 `prompt-gate-repl-doctrine.test.ts` 與 `ipython-provisioner.test.ts` 補足雙環境 Label 與預設 IScript 啟動訊息斷言。 |
| **A4-ACC-10** | **Minor** | `isLegacyPythonOverride` 判定脆弱且兩處環境判定來源不一 | 抽出共用函式 `resolveKernelRuntime(options, env)`，統一環境判定邏輯。 |
| **A4-ACC-11** | **Hygiene**| 工作樹混入無關檔案 | 提交時嚴格指定檔案列表，排除 `docs/exa-mcp-setup-plan.md`，並將 `bash.ts` 正式列入本階段配套提交。 |

---

## 二、 詳細實作工作項目（Work Breakdown Structure）

### 工作項 1：環境判定統一與 A4-ACC-01 / A4-ACC-10 修復
- [ ] 在 `packages/coding-agent/src/core/tools/iscript.ts` 抽出共用 `resolveKernelRuntime(options?: IScriptToolOptions, env?: NodeJS.ProcessEnv): "deno" | "node" | "python-legacy"`。
- [ ] `createIScriptToolDefinition` 允許外部注入 `env`（預設讀取 `process.env`）。
- [ ] 統一文案命名（A4-ACC-06）：Label 顯示 `iscript (Node VM)`，description / promptSnippet 同步統一為 `Node VM`。
- [ ] 在 `test/suite/prompt-gate-repl-doctrine.test.ts` 中使用 `vi.stubEnv("APOLLO_KERNEL_DENO", undefined)` 隔離 Node 測試，並新增 Deno 分支測試（驗證 `APOLLO_KERNEL_DENO` 存在時的 label 與 promptSnippet）。

### 工作項 2：啟動調度修正與 A4-ACC-02 修復
- [ ] 檢視 `packages/coding-agent/src/core/kernel/repl-manager.ts:382-410`：
  - 若 `options.python` 被顯式指定且指向自訂腳本（如測試的 `writeFakePython()`），應尊重調度執行該 command，若執行失敗能如期拋出。
  - 對齊 `repl-manager.ts` 檔頭註解與代碼實作邏輯。
- [ ] 實跑 `test/ipython-provisioner.test.ts`，確認 21/21 測試全數通過。

### 工作項 3：打包資產補齊（A4-ACC-03）
- [ ] 修改 `packages/coding-agent/scripts/copy-binary-assets.mjs`：
  - 在 `binaryAssets` 陣列加入 `"apollo-cli-runtime"`。
  - 在 `validateBinaryAssets` 中加入 `apollo-cli-runtime/src/rlm/mod.ts` 之檔案存在檢查。

### 工作項 4：Host 端殘留文案清理（A4-ACC-05）
- [ ] 修改 `packages/coding-agent/src/core/tools/iscript.ts:676, 680`：
  - 將 `"Waiting for Python kernel..."` / `"Restarting Python kernel..."` 調整為環境感知或統一為 `"Waiting for IScript kernel..."` / `"Restarting IScript kernel..."`。
  - 同步更新 `test/ipython-provisioner.test.ts:408, 439` 中的斷言。
- [ ] 修改 `packages/coding-agent/src/core/kernel/repl-manager.ts:448` 錯誤訊息，改為提示檢查/更新 `apollo-cli-runtime`。
- [ ] 清理檔頭註解中的陳舊 Python 描述。

### 工作項 5：Deno 診斷引導與細節強化（A4-ACC-07）
- [ ] 在 `apollo-cli-runtime/src/rlm/repl.ts` 的 `_knownFailureHint` 增加對 Deno 環境下常見錯誤（例如 PermissionDenied）的診斷引導。

### 工作項 6：文檔與測試覆蓋（A4-ACC-04 / A4-ACC-08 / A4-ACC-09）
- [ ] 全面重寫 `packages/coding-agent/docs/iscript-kernel.md` 中的 5 個過期章節（移除所有過期的 Python fallback 敘述）。
- [ ] 更新 `docs/harness-rlm-tune-suggest-phase4-1-plan.md` 中的行號引述與參數。
- [ ] 補齊測試：在 `prompt-gate-repl-doctrine.test.ts` 斷言動態 Label（`Node VM` 與 `Deno`）；在 `ipython-provisioner.test.ts` 斷言預設路徑的 IScript 啟動進度文字。

---

## 三、 驗收與複核標準

1. **單元測試全綠**：
   ```bash
   cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run \
     test/ipython-provisioner.test.ts \
     test/suite/prompt-gate-repl-doctrine.test.ts \
     test/ipython-bootstrap.test.ts \
     test/suite/regressions/4428-remove-legacy-pi-mono-tools.test.ts
   ```
   * 在設置 `APOLLO_KERNEL_DENO` 與未設置之環境下，皆必須 100% PASS。
2. **Runtime 測試全綠**：
   ```bash
   node --experimental-strip-types --test apollo-cli-runtime/test/repl.test.ts
   ```
3. **品質門禁全綠**：
   ```bash
   npm run check:test-policy
   npm run check
   ```
4. **Git 工作樹合規（A4-ACC-11）**：
   * 提交僅包含 Phase 4.1 相關變更，排除未相關檔案。
