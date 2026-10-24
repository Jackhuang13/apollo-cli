# Harness RLM Phase 3 驗收問題改善校正報告 (二)

- **記錄日期**：2026-10-24
- **驗收單來源**：[`docs/harness-rlm-phase3-acceptance-issues.md`](./harness-rlm-phase3-acceptance-issues.md)
- **校正對象**：Phase 3 驗收退回項目（CAP-02 使用者面鏈路殘缺、CAP-04 測試辨識度不足、報告數據校正）
- **總體驗收結果**：**全數通過 (PASS)**

---

## 一、 問題校正與實作自證清單

| 項次 | 原始問題代號 | 嚴重等級 | 問題描述 | 改善校正作為與真實生產代碼落點 | 驗證結果 |
|---|---|---|---|---|---|
| **CAP-01** | A3-ACC-01 | **Blocker** | `isNegativeActive` 未在純 JSON 條目下生效，過期負向空間無法顯示 `[NEGATIVE - EXPIRED]` | 修改 [`refinement.ts`](../packages/coding-agent/src/core/refinement/refinement.ts)，當 `isNegativeActive` 為 undefined 時直接比對 `entry.negative_expires_at` 與當前時間。測試移除 mock 函式，改用純 JSON 資料格式覆蓋。 | **PASS** |
| **CAP-02** | A3-ACC-02 | **Blocker** | 使用者面 `rlm.spawn` 仍無 `expected_schema` 通道，kernel binding 靜默丟棄 | 1. 在 [`apollo-cli-runtime/src/rlm/mod.ts`](../apollo-cli-runtime/src/rlm/mod.ts) 的 `SpawnOptions` 與 `_spawnKwargs` 中正式加入 `expected_schema` / `expectedSchema` 轉發至 host kwargs；<br>2. 補強 [`apollo-cli-runtime/test/subagent.test.ts`](../apollo-cli-runtime/test/subagent.test.ts) 驗證 `spawn("task", { expected_schema })` 完整轉發至 `rlm.run` payload；<br>3. 重寫 [`packages/coding-agent/test/rlm-collect.test.ts`](../packages/coding-agent/test/rlm-collect.test.ts) e2e 測試：直接以 host request 驅動（`rlm.run` kwargs 傳入 `expected_schema` -> child 經 `rlm.complete` 提報不符 payload -> `rlm.collect` 獲取包含 `schema_mismatch: true` 之結構），落實全鏈路驗證。 | **PASS** |
| **CAP-03** | A3-ACC-03 | **Major** | 測試檔中使用 `await import` 內聯動態引入，違反 `AGENTS.md` 規則 | 修改 [`test/rlm-collect.test.ts`](../packages/coding-agent/test/rlm-collect.test.ts)，移除 `await import`，將 `validateAgainstExpectedSchema` 提升為檔案頂層靜態 import。 | **PASS** |
| **CAP-04** | A3-ACC-04 | **Major** | 排序測試不具辨識度（功能移除時依賴 id 字母序 tie-break 仍能通過），且缺少數值斷言 | 1. 導出並單元測試核心評分函式 [`computeHarnessEntryMultiplier`](../packages/coding-agent/src/core/refinement/refinement.ts)；<br>2. 重寫 [`test/refinement.test.ts`](../packages/coding-agent/test/refinement.test.ts) 排序測試，將勝出條目 ID 設為字母序置後（如 `z_novel` vs `a_older`、`z_high` vs `a_low`、`z_fresh` vs `a_14d`），若功能停用或乘數失效則 tie-breaker 必定選擇前者導致測試失敗（完全符合 Testing Policy 倒扣驗證要求）；<br>3. 補齊精準數值斷言：24h 內 1.2x vs >24h 1.0x、FrequencyBoost 對數公式數值（hit=0 為 1.0，hit=e-1 為 2.0，hit=10 為 1+ln(11)）、RecencyDecay 半衰期（7 天 0.5x，14 天 0.25x）。 | **PASS** |
| **CAP-05** | A3-ACC-05 | **Major** | 缺乏端到端 Schema 校驗整合測試，僅測純函式 | 在 [`test/rlm-collect.test.ts`](../packages/coding-agent/test/rlm-collect.test.ts) 由 host request 驅動完整流程：<br>- 父 session 接收 `rlm.run` 帶 `expected_schema`；<br>- 子 session 透過 `rlm.complete` 提報不符結構之 payload；<br>- 父端 `rlm.collect` 取得 `schema_mismatch: true`，且原始 `data` 原樣保留，父 session 不中斷。 | **PASS** |
| **CAP-06** | A3-ACC-06 | **Minor** | 未實作項目（Taboo Break、負向 3 天衰減、`include_negative`）未於計晝中全面標記延後 | 更新 [`docs/harness-rlm-tune-suggest-phase3-plan.md`](./harness-rlm-tune-suggest-phase3-plan.md)，明確將上述三者統一步調標記為 Phase 3.5+ 後續規劃項目。 | **PASS** |
| **CAP-07** | A3-ACC-07 | **Minor** | `update_entry()` 未更新 `last_accessed_at`，亦未說明 `hit_count` 之設計取捨 | 修改 [`harness.ts`](../apollo-cli-runtime/src/rlm/harness.ts)，在 `update()` 路徑補齊 `existing.last_accessed_at = nowIso()`，並附註不遞增 `hit_count` 是為避免知識修訂與檢索命中統計混淆之設計考量。 | **PASS** |
| **CAP-08** | A3-ACC-08 | **Minor** | Changelog 宣稱了未完全接通之功能 | 檢視 [`phase3-negative-space-and-subagent-contract.md`](../packages/coding-agent/.changes/phase3-negative-space-and-subagent-contract.md)，確認各項描述在 `CAP-02`（全鏈路包含 mod.ts）及 `CAP-05` 接通後完全符合生產代碼實況。 | **PASS** |
| **CAP-09** | A3-ACC-09 | **Minor** | Git 工作區存在無關已刪除檔案，可能造成污染 | 嚴格執行 `AGENTS.md` 規範，禁止 `git add -A` 或 `git add .`，僅 stage 與本次 Phase 3 相關之新增與修改檔案。 | **PASS** |

---

## 二、 執行「掛住問題」與測試數據勘誤

- **現象分析**：
  先前在終端執行 `npm test -- test/harness.test.ts` 出現延遲，係因 `apollo-cli-runtime/package.json` 的 test 腳本為 `"node --experimental-strip-types --test test/*.test.ts"`。npm 將參數附加在 glob 之後，導致 node 一次執行了 `apollo-cli-runtime/test/` 下全部 **8 個測試檔案**（合計 **47 個測試用例**）。
- **數據勘誤校正**：
  - 單檔 [`apollo-cli-runtime/test/harness.test.ts`](../apollo-cli-runtime/test/harness.test.ts) 之測試結果為 **3 / 3 PASS**（耗時約 210ms）。
  - `apollo-cli-runtime/test/` 全量 8 個測試檔案（bash, harness, mcp, repl, skill, snapshot, subagent, tools）之測試結果為 **47 / 47 PASS**（耗時約 3.5 秒），證實完全無死鎖或行程掛住情況。

---

## 三、 品質門禁與驗證數據

### 1. 測試套件執行結果
- `packages/coding-agent/test/refinement.test.ts`: **92 / 92 PASS**（含具備 Testing Policy 倒扣辨識度之 Novelty、Frequency、Recency 數值斷言）
- `packages/coding-agent/test/rlm-collect.test.ts`: **10 / 10 PASS**（含 `rlm.run` 到 `rlm.complete` / `rlm.collect` 之端到端非破壞性 schema mismatch 驗證）
- `apollo-cli-runtime/test/subagent.test.ts`: **6 / 6 PASS**（含 `spawn` 轉發 `expected_schema` host request 驗證）
- `apollo-cli-runtime/test/harness.test.ts`: **3 / 3 PASS**（全模組 8 檔 47 / 47 PASS）

### 2. 靜態型別與專案規範檢查 (`npm run check`)
- `biome check`: **923 files checked, 0 errors, 0 warnings**
- `check:test-policy`: **Passed against HEAD^**
- `tsgo --noEmit`: **Passed**（全專案含 `packages/coding-agent` 與 `apollo-cli-runtime` 無任何型別報錯）
- `check:installer`, `check:push-guard`, `check:browser-smoke`: **全部 PASS**
