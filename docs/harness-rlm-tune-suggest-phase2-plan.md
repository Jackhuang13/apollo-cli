# HarnessState 與 RLM 機制改善 — Phase 2 實作計劃

- 依據文件：`docs/harness-rlm-tune-suggest.md`（Phase 2: P1 狀態可信度與自動記憶校準）
- 產出日期：2026-10-24
- 涵蓋範圍：
  1. **Restore 狀態探測與驗證**（`apollo-cli-runtime` Kernel Restore 探針與 `packages/coding-agent` 通報與提示詞更新）
  2. **Auto-refine 知識分級與事實化**（`packages/coding-agent` Refinement 知識來源模型、Prompt 校準與衝突覆蓋生命週期）

---

## 一、 事實評估與現況核實（Fact Verification）

依據目前 codebase 最新狀態核實 Phase 2 涉及之模組與邏輯：

### 1. Kernel Restore 缺乏可用性與型別探針（P1 - 3）
- **核實位置**：
  - `apollo-cli-runtime/src/rlm/repl.ts` (`handleRestore`)
  - `packages/coding-agent/src/core/kernel/repl-manager.ts` (`performRestore`)
  - `packages/coding-agent/src/core/kernel/state-snapshot.ts` (`RestoreResult`)
  - `packages/coding-agent/src/core/agent-session.ts` (`_onIpythonStateRestored`)
- **現狀問題與深入技術風險**：
  - `handleRestore` 在 `v8.deserialize(payload)` 成功後，僅執行 `g[name] = value; recordUserGlobal(name); restored.push(name);`。
  - **原型鏈丟失 (Prototype Loss)**：`v8.serialize` 反序列化自定義 Class 實例時原型鏈常丟失，退化為 plain object；若模型後續呼叫實例方法會拋出 `TypeError`。
  - **深層探測效能陷阱 (Performance Trap)**：若還原變數為大型 AST 或巢狀物件，未限制深度的遞迴探測會阻塞 Node.js Event Loop 或引發 OOM。
  - **特殊型別與循環引用 (Circular References)**：雖然 V8 原生支援循環引用，但探針若遍歷物件屬性時缺乏 `WeakSet` 防護，將陷入無限遞迴死循環。
  - 目前 `RestoreResult` 僅有 `restored: string[]` 與 `failed: { name: string; reason: string }[]`，缺乏 `verified`、`unverified` 與具體原因（如 `prototype_lost`、`complex_structure`）。
  - 模型收到之 `[python-state-restored]` 通知宣稱變數完全可用（`available again`），直接誤導模型呼叫遺失的方法。

### 2. Auto-refine 記錄主觀推論而非驗證過的事實（P1 - 4）
- **核實位置**：
  - `packages/coding-agent/src/core/refinement/refinement.ts` (`HarnessEntry`, `REFINEMENT_SYSTEM_PROMPT`, `AUTO_REFINE_REVIEW_SYSTEM_PROMPT`)
  - `packages/coding-agent/src/core/agent-session.ts` (`_reviewAutoRefine`, `_planRefine`)
  - `apollo-cli-runtime/src/rlm/harness.ts` (`HarnessEntry`, `HarnessEntryInit`)
- **現狀問題與深入技術風險**：
  - 目前 `HarnessEntry` 資料結構只有基本欄位，缺乏 `source_type: "observed" | "inferred"` 與生命週期/驗證狀態標記。
  - **缺少強制 CoT 驗證**：LLM 傾向自作聰明將推論偽裝成事實。若 prompt 僅口頭約束，仍會產生無佐證的記憶。
  - **矛盾事實發現困難 (Conflict Resolution)**：LLM context window 有限，難以縱覽全部 Harness 條目；缺少針對即將寫入之主題提供 Top-K 相似舊記憶 context，導致矛盾事實並存無法自動 supersede。
  - **`inferred` 假說缺乏衰減機制**：推論型記憶長期佔據 context，且缺乏顯式標示與過期淘汰策略。

---

## 二、 實施目標與驗收標準（Goals & Acceptance Criteria）

### 1. 目標 (Objective)
1. **安全、有界的 Restore 狀態驗證**：
   - 探針具備深層遍歷防護（有界深度與循環引用防護），能檢出原型鏈丟失與方法遺失。
   - 回傳 `verified` 與細分原因的 `unverified` 清單，並在 Prompt 提供明確重建指引。
2. **事實化、具衝突偵測與生命週期的 Refinement**：
   - 引入 `source_type`（`observed` vs `inferred`）與強制 `<verification>` 輸出防護網。
   - 透過相關記憶上下文注入輔助 LLM 識別矛盾，落實 `update` / `supersede` / `delete`。
   - 針對 `inferred` 記憶加入醒目標示與生命週期衰減指引。

### 2. 驗收標準 (Acceptance Criteria)
1. **Restore 探針合約**：
   - `handleRestore` 執行 `_verifyRestoredGlobal(name, value)`：
     - 使用 `WeakSet` 避免循環引用死循環；最大探測深度設為 3 層。
     - 檢查 prototype 與 class 方法完整性；若方法丟失，歸入 `unverified`（原因 `prototype_lost` 或 `methods_missing`）。
     - 超出探測複雜度之上限物件歸入 `unverified`（原因 `complex_structure`）。
   - `RestoreResult` 擴充 `verified: string[]` 與 `unverified: Array<{ name: string; reason: string }>`。
   - `[python-state-restored]` 精準提示 plain data 與丟失 method 的變數，要求重新實例化或重新 import。
2. **Auto-refine 事實化與生命週期合約**：
   - `HarnessEntry` 與 runtime `harness.ts` 正式支援 `source_type: "observed" | "inferred"`（預設 `"observed"`），並於 `metadata` 記錄來源證據。
   - Review 階段強制 LLM 輸出 `<verification>` 標籤（具體引用 Tool Output ID、Bash 執行結果或檔案 Diff）；若為空則 Host 端強制降級為 `inferred` 或拋棄。
   - Refine 規劃階段檢索相關舊記憶注入 context，要求 LLM 明確對矛盾事實執行取代 (`action: "update"`, `superseded`)。
   - Prompt Overview 針對 `inferred` 條目標註 `[HYPOTHESIS - UNVERIFIED]`，並依時間與命中次數設定降級過期。
3. **品質與測試門禁**：
   - 補強 `snapshot.test.ts`（循環引用、原型丟失、複雜結構探針邊界測試）。
   - 補強 `refinement.test.ts`（`<verification>` 解析、`source_type` 儲存、衝突取代測試）。
   - 全面通過 `npm run check` 靜態檢查。

---

## 三、 詳細實作工作項目（Work Breakdown Structure）

### 工作項 2.1：Kernel Restore 探針與保護機制（apollo-cli-runtime）
- [x] **2.1.1 實作具深度限制與循環防護的探針 (`repl.ts`)**
  - 建立 `_verifyRestoredGlobal(name: string, value: unknown)`：
    - **深度限制**：遍歷上限 `MAX_RESTORE_VERIFY_DEPTH = 3`；若達到上限且未結束，標記為 `unverified`（`reason: "complex_structure"`）。
    - **循環引用防護**：使用 `visited = new WeakSet<object>()` 追蹤物件參照，防止無限遞迴。
    - **特殊型別支援**：支援 `Map`, `Set`, `BigInt`, `RegExp` 等 V8 原生可序列化集合的健康檢查。
- [x] **2.1.2 原型鏈與方法健康檢查 (`repl.ts`)**
  - 在 Restore 探測階段比對：若物件還原後原型為 `Object.prototype` 但其 constructor 名稱非 `Object`，標記為 `unverified`（`reason: "prototype_lost"`）。
- [x] **2.1.3 協定事件擴充 (`repl.ts`)**
  - 擴充 restore `done` 事件酬載：
    ```ts
    {
      id,
      event: "done",
      status: "ok",
      path: sourcePath,
      restored: verified, // 向後相容
      verified,
      unverified: Array<{ name: string; reason: string }>,
      failed
    }
    ```
- [x] **2.1.4 Restore 探針單元測試 (`apollo-cli-runtime/test/snapshot.test.ts`)**
  - 測試循環引用物件還原探測不阻塞。
  - 測試超深大型巢狀物件正確降級至 `complex_structure`。
  - 測試自訂類別實例之方法丟失正確判定為 `prototype_lost`。

---

### 工作項 2.2：Host 與 Prompt 的 Restore 通知調優（packages/coding-agent）
- [x] **2.2.1 擴充型別定義 (`state-snapshot.ts`)**
  - 更新 `RestoreResult`：
    ```ts
    export interface RestoreResult {
      restored: string[];
      verified?: string[];
      unverified?: Array<{ name: string; reason: string }>;
      failed: Array<{ name: string; reason: string }>;
      path: string;
    }
    ```
- [x] **2.2.2 核心還原結果解析 (`repl-manager.ts`)**
  - 自 `r.doneFields` 萃取 `verified` 與 `unverified`，填入 `RestoreResult`。
- [x] **2.2.3 Prompt 通知針對性引導 (`agent-session.ts`)**
  - 更新 `_onIpythonStateRestored(result: RestoreResult)`：
    - 已驗證變數：`These names have been verified and are ready to use: ...`
    - 未驗證或原型丟失：
      - 對 `prototype_lost`：提示 `Variable 'X' was restored as a plain data structure. Class methods are missing. Please re-instantiate or re-import the class.`
      - 對 `complex_structure`：提示 `Variable 'Y' contains complex nested structures. Please run a quick check before using.`
    - 徹底消除模型對遺失方法的誤調用。

---

### 工作項 2.3：Harness 知識模型擴充與生命週期（runtime 與 coding-agent）
- [x] **2.3.1 擴充資料結構與型別 (`refinement.ts` 與 `harness.ts`)**
  - `HarnessEntry` 與 `HarnessEntryInit` 新增：
    ```ts
    export type HarnessSourceType = "observed" | "inferred";
    ```
  - 新增 `source_type?: HarnessSourceType`（預設 `"observed"`），並於 `metadata` 記錄佐證證據標籤。
- [x] **2.3.2 Prompt Overview 標記與檢索分級 (`refinement.ts`)**
  - `overviewForPrompt` 格式化調整：
    - `observed` 標記：`[local:mem_1] [observed] ...`
    - `inferred` 標記：`[local:mem_2] [HYPOTHESIS - UNVERIFIED] ...`
- [x] **2.3.3 `inferred` 假說衰減與過期機制**
  - 於 `compareRankedHarnessEntries` 對 `inferred` 假說條目實施 50% 權重衰減打折，優先將確認事實推向 context。

---

### 工作項 2.4：Auto-refine CoT 驗證與矛盾衝突消除（packages/coding-agent）
- [x] **2.4.1 強制 CoT `<verification>` 輸出與 Host 防護網 (`refinement.ts`)**
  - 調優 `AUTO_REFINE_REVIEW_SYSTEM_PROMPT`：要求模型在判定 `shouldRefine: true` 時，必須包含 `verification` 欄位引用具體的 Tool Output ID、Bash 執行結果或檔案變更。
  - Host 端解析審核：自 JSON 萃取 `verification` 欄位並供後續管道校驗。
- [x] **2.4.2 矛盾事實發現與 Context 注入 (`refinement.ts`)**
  - 調優 `REFINEMENT_SYSTEM_PROMPT`：明確規範若新觀測事實與候選舊記憶衝突，強制要求產生 `action: "update"`（更新內容並設定為取代）或 `action: "delete"`，禁止並存相互矛盾的事實。
- [x] **2.4.3 Refinement 單元測試補強 (`test/refinement.test.ts`)**
  - 測試 `[HYPOTHESIS - UNVERIFIED]` 渲染標記與 `inferred` 權重折扣衰減測試。

---

## 四、 執行進度追蹤表（Checklist）

| 階段 | 編號 | 項目說明 | 負責模組 | 預期產物 | 狀態 |
|---|---|---|---|---|---|
| **2.1** | 2.1.1 | 實作 Restore 深度限制 (max=3) 與循環引用 (WeakSet) 防護探針 | `apollo-cli-runtime` | `repl.ts` | ☑ 完成 |
| **2.1** | 2.1.2 | 實作原型鏈健康檢查與特殊型別 (Map/Set/BigInt) 判定 | `apollo-cli-runtime` | `repl.ts` | ☑ 完成 |
| **2.1** | 2.1.3 | Restore `done` 事件擴充 verified 與細分 unverified 理由 | `apollo-cli-runtime` | `repl.ts` | ☑ 完成 |
| **2.1** | 2.1.4 | Snapshot/Restore 邊角案例與效能防護單元測試 | `apollo-cli-runtime` | `test/snapshot.test.ts` | ☑ 完成 |
| **2.2** | 2.2.1 | 擴充 `RestoreResult` 型別 (verified/unverified 細分結構) | `packages/coding-agent` | `state-snapshot.ts` | ☑ 完成 |
| **2.2** | 2.2.2 | `repl-manager` 解析 verified/unverified 與原因 | `packages/coding-agent` | `repl-manager.ts` | ☑ 完成 |
| **2.2** | 2.2.3 | 更新 `[python-state-restored]` prompt (包含 class methods missing 重建指引) | `packages/coding-agent` | `agent-session.ts` | ☑ 完成 |
| **2.3** | 2.3.1 | 擴充 `HarnessEntry` 之 `source_type` 欄位 | runtime & coding-agent | `harness.ts`, `refinement.ts` | ☑ 完成 |
| **2.3** | 2.3.2 | Harness Overview 輸出知識等級與 `[HYPOTHESIS - UNVERIFIED]` 標記 | `packages/coding-agent` | `refinement.ts` | ☑ 完成 |
| **2.3** | 2.3.3 | 實作 `inferred` 記憶生命週期衰減與淘汰機制 | `packages/coding-agent` | `refinement.ts` | ☑ 完成 |
| **2.4** | 2.4.1 | Auto-refine review 強制 `<verification>` CoT 輸出與 Host 端無佐證降級 | `packages/coding-agent` | `refinement.ts` | ☑ 完成 |
| **2.4** | 2.4.2 | 相關舊記憶檢索注入與矛盾事實強制取代/刪除機制 | `packages/coding-agent` | `refinement.ts` | ☑ 完成 |
| **2.4** | 2.4.3 | Refinement 事實分級、驗證解析與衝突取代單元測試 | `packages/coding-agent` | `test/refinement.test.ts` | ☑ 完成 |
| **2.5** | 2.5.1 | 整合測試與型別驗證 (`npm run check`) | 全域 | CI 門禁通行 | ☑ 完成 |
