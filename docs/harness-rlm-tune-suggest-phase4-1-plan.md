# HarnessState 與 RLM 機制改善 — Phase 4.1 協定、命名清理與環境優化實作計劃（核實修訂版）

- 依據文件：[`docs/harness-rlm-tune-suggest.md`](file:///home/ck/apollo-cli/docs/harness-rlm-tune-suggest.md)（Phase 4: P3 協定清理與測試體質健全之 4.1 協定與命名清理）
- 最新修訂日期：2026-10-25
- 涵蓋範圍：
  1. **概念邊界釐清**：確立 **Deno / Node VM 為底層執行環境（Runtime Environment）**，而 **`iscript` 為交互調度工具（REPL Tool）**；`rlm`、`bash`、`harness` 為函式庫模組，杜絕概念混淆。
  2. **Kernel `ready` 事件虛假欄位徹底根除**（移除毫無關聯且誤導的 `python` 與偽造 `deno` 欄位）。
  3. **明確執行環境識別與雙來源優化**：依據真實全域環境引入 `runtime: "node" | "deno"`，針對 Deno / Node VM 差異化優化握手與引導。
  4. **Host 端與工具標題動態環境感知**：`iscript` 工具標題（Label / Prompt）動態跟隨環境（`iscript (Node VM)` / `iscript (Deno)`），消除歷史 Python 殘留字串。
  5. **全代碼庫無 Python Kernel 之事實確認與邊界防護**。

---

## 一、 架構本質與核心事實核實（Architecture & Fact Verification）

針對專案最新代碼實作進行深入查驗，確立以下核心原則與事實：

### 1. 「環境（Runtime Environment）」vs「工具（Tool）」vs「模組（Module）」之嚴格界定
* **執行環境（Runtime Environment）**：**Deno** 與 **Node VM**
  * 它們是 Kernel Process 啟動與執行的底層 JavaScript/TypeScript 引擎。
  * 啟動調度位於 [`packages/coding-agent/src/core/kernel/repl-manager.ts:404-410`](file:///home/ck/apollo-cli/packages/coding-agent/src/core/kernel/repl-manager.ts#L404-L410)，依環境設定分派為：
    * Deno：`deno run -A --unstable-kv <mod.ts>`
    * Node VM：`node --experimental-strip-types <mod.ts>`
* **REPL 調度工具（Tool）**：**`iscript`**
  * 它是提供給 Agent / LLM 呼叫的交互式程式碼執行工具（位於 [`packages/coding-agent/src/core/tools/iscript.ts`](file:///home/ck/apollo-cli/packages/coding-agent/src/core/tools/iscript.ts)）。
  * 它負責狀態維持、生命週期管理、AST 語法分析與進程監控，**不是**在腳本內被使用者 import 的模組。
* **被含入之核心模組（Libraries / Modules）**：**`rlm`、`bash`、`harness`、`mcp`**
  * 提供給使用者或 Agent 在腳本內調用的函式與型別，由 [`apollo-cli-runtime/src/rlm/mod.ts`](file:///home/ck/apollo-cli/apollo-cli-runtime/src/rlm/mod.ts) 暴露。

### 2. Apollo CLI 當前架構「根本無 Python Kernel」
* **核實位置**：[`packages/coding-agent/src/core/kernel/repl-manager.ts:392-395`](file:///home/ck/apollo-cli/packages/coding-agent/src/core/kernel/repl-manager.ts#L392-L395)
  * Apollo CLI 強制解析 `apollo-cli-runtime/src/rlm/mod.ts`，不存在任何啟動 Python 解釋器的 fallback。
  * 代碼中現存的 `"Starting Python kernel..."`、`"Restoring Python state..."`、型別 `KernelPythonSkill` 均為 Prime Agent Fork 歷史殘留，必須清理。

### 3. `ready` 握手事件現存之虛假欄位缺陷（已修復於 `repl.ts:1654-1669`）
* **修復前缺陷**：
  ```typescript
  const denoObj = (globalThis as unknown as { Deno?: { version?: { deno?: string } } }).Deno;
  const denoVersion = typeof denoObj === "object" && denoObj?.version?.deno ? denoObj.version.deno : process.versions.node;

  _sendProto({
      event: "ready",
      protocol: PROTOCOL_VERSION,
      deno: denoVersion,
      node: process.versions.node,
      python: denoVersion,  // 嚴重錯誤：在 Node 環境下填入的是 process.versions.node！
  });
  ```
  在標準 Node 環境下將 Node 版本號偽造成 `deno` 與 `python` 發出，造成語意嚴重污染。
* **啟動參數**：Deno 啟動已加上 `--unstable-kv --unstable-node-globals`，確保 Node 全域環境相容。

---

## 二、 對 `packages/coding-agent` 的衝擊評估

| 評估維度 | 對 `packages/coding-agent` 的影響 | 結論說明 |
|---|---|---|
| **核心執行握手** | **無破壞（完全相容）** | `repl-manager.ts:445-450` 僅校驗 `protocol: 3`，握手安全相容 |
| **環境感知能力** | **正面增強** | Host 端可透過 `ready.runtime` 取得精準底層環境（`node` 或 `deno`） |
| **工具標籤呈現** | **體驗優化** | `iscript` 工具標題可動態更新為 `iscript (Node VM)` 或 `iscript (Deno)`，模型與使用者皆清晰感知 |
| **單元與回歸測試** | **安全（零破壞）** | 既有 subprocess 測試保持相容，針對遺留文案斷言進行平滑支援 |

---

## 三、 實施目標與驗收標準（Goals & Acceptance Criteria）

### 1. 實施目標 (Objective)
1. **Deno / Node VM 環境層分離與優化**：
   - 握手協定明確發送 `runtime: "node" | "deno"`。
   - 僅在真實存在 `globalThis.Deno` 時發送 `deno` 版本；Node 環境下僅包含 `node` 版本。
   - 徹底移除虛假的 `python` 欄位。
   - 強化失敗引導機制（Hint）：在 Node VM 環境下誤調用 `Deno.*` 或在 Deno 環境下誤調用專用 API 時，給予精確對應提示。
2. **`iscript` 工具標題與描述動態跟隨環境**：
   - 工具本體名稱維持 `iscript`。
   - 動態 Label 與 PromptSnippet 跟隨握手確認的執行環境：
     - Node VM: `iscript (Node VM)` — `persistent TypeScript/JavaScript (Node VM) REPL`
     - Deno: `iscript (Deno)` — `persistent TypeScript/JavaScript (Deno) REPL`
3. **消除 Host 端歷史 Python 命名與文案混淆**：
   - 將 Host 端的進度提示統一為代表當前環境之字串。

### 2. 驗收標準 (Acceptance Criteria)
- [x] **AC-4.1.1（真實無偽的 Ready 協定）**：
  - Node 環境下 payload 僅含：`event: "ready"`, `protocol: 3`, `runtime: "node"`, `node: process.versions.node`。
  - 嚴格斷言：`ready.python === undefined` 且 `ready.deno === undefined`。
  - Deno 環境下 payload 包含：`runtime: "deno"` 與真實 `deno` 版本。
- [x] **AC-4.1.2（工具標題動態環境感知）**：
  - `iscript` 工具實例的 Label / Display Title 能根據解析環境顯示 `iscript (Node VM)` 或 `iscript (Deno)`。
- [x] **AC-4.1.3（進度提示真實化）**：
  - 啟動與狀態恢復進度訊息不再出現 `"Starting Python kernel..."`，全面改為 IScript / 當前環境資訊。
- [x] **AC-4.1.4（測試與代碼政策合規）**：
  - `apollo-cli-runtime/test/repl.test.ts` 驗證乾淨的握手欄位結構。
  - 通過 `npm run check` 與 `npm run check:test-policy`。

---

## 四、 詳細實作工作項目（Work Breakdown Structure）

### 工作項 4.1.1：`repl.ts` 環境握手與引導優化 (`apollo-cli-runtime/src/rlm/repl.ts`)
- [x] **精準握手 Payload 構建**：
  ```typescript
  const denoObj = (globalThis as unknown as { Deno?: { version?: { deno?: string } } }).Deno;
  const isDeno = typeof denoObj === "object" && denoObj !== null && typeof denoObj.version?.deno === "string";
  const denoVersion = isDeno ? denoObj.version?.deno : undefined;

  const readyPayload: Record<string, unknown> = {
      event: "ready",
      protocol: PROTOCOL_VERSION,
      runtime: isDeno ? "deno" : "node",
      node: process.versions.node,
  };

  if (denoVersion) {
      readyPayload.deno = denoVersion;
  }

  _sendProto(readyPayload);
  ```
- [x] **環境診斷提示（Hint）強化**：
  確保 `_knownFailureHint` 能精準區分 Node VM 與 Deno 環境之 API 引導。

### 工作項 4.1.2：`iscript` 工具動態標題與進度文案更新 (`packages/coding-agent/src/core/tools/iscript.ts`)
- [x] **動態工具標題支援**：
  - `createIScriptToolDefinition` 允許依據 provisioner / runtime 所判定的環境（`node` 或 `deno`），動態產生對應 Label 與 promptSnippet：
    - `label`: `options?.label ?? (runtime === "deno" ? "iscript (Deno)" : "iscript (Node VM)")`
- [x] **清理啟動進度文案**：
  - 將 `"Starting Python kernel..."` 調整為代表實際環境的 `"Starting IScript kernel..."`。
  - 保留對歷史測試傳入特定 option 時的相容防護。

### 工作項 4.1.3：文件更新 (`packages/coding-agent/docs/iscript-kernel.md`)
- [x] 明確記載：
  - **架構定義**：Deno / Node VM 為底層執行環境，`iscript` 為 REPL 交互工具。
  - **握手規範**：`ready` 事件中 `runtime` 欄位的定義，並記錄廢除 `python` 偽造欄位之沿革。

### 工作項 4.1.4：單元測試強化 (`apollo-cli-runtime/test/repl.test.ts`)
- [x] 更新握手事件單元測試：
  ```typescript
  test("repl emits clean ready event with accurate runtime and no fake python fields", async () => {
      const repl = new ReplTestDriver();
      try {
          const ready = await repl.nextEvent();
          assert.equal(ready.event, "ready");
          assert.equal(ready.protocol, 3);
          assert.equal(ready.runtime, "node");
          assert.equal(typeof ready.node, "string");
          assert.equal(ready.python, undefined);
          assert.equal(ready.deno, undefined);
      } finally {
          repl.close();
      }
  });
  ```

---

## 五、 Changelog Fragment

- 檔案位置：`packages/coding-agent/.changes/phase4-1-protocol-and-naming-cleanup.md`
  ```markdown
  - Refined IScript kernel environment architecture: distinguished Deno and Node VM runtime environments from the iscript REPL tool, enabled dynamic tool labeling based on active environment, eliminated legacy python fields from ready handshake, and updated kernel startup messaging.
  ```
