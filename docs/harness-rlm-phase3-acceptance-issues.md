# Phase 3 驗收 Issues — HarnessState 負向空間與子 Agent 強類型契約

- 驗收依據：[`docs/harness-rlm-tune-suggest-phase3-plan.md`](./harness-rlm-tune-suggest-phase3-plan.md)
- 驗收日期：2026-10-24
- 被驗收對象：`HEAD 7453e9f` 之上的未提交工作樹變更（`git status` 所列 Phase 3 相關檔案）
- 驗收方式：靜態比對驗收標準、運行門禁（`npm run check`、`npm run check:test-policy`）、運行相關測試檔、對關鍵路徑做獨立重現
- **總結論：不通過**（Blocker ×2、規則違規 ×1、測試缺口 ×2、計劃偏離 ×3、工作樹衛生 ×1）

---

## A. Blocker（必須修正後才可通過驗收）

### A3-ACC-01 過期負向記憶在 prompt digest 永遠渲染為 [NEGATIVE - AVOID]

- **對應驗收標準**：二.2-1（「若負向記憶已逾期，自動降級或標註 `[NEGATIVE - EXPIRED]`」）、工作項 3.1.3
- **位置**：`packages/coding-agent/src/core/refinement/refinement.ts`
  - `formatHarnessStateForPrompt`（約 796-801 行）：`typeof entry.isNegativeActive === "function" ? entry.isNegativeActive() : Boolean(entry.negative)`
  - `loadHarnessState`（約 349-399 行）：從 `harness_state.json` 讀出**純 JSON 物件**，不可能攜帶函式
- **根因**：`isNegativeActive()` 只存在於 `apollo-cli-runtime` 的 `HarnessEntry` **類別**上（其 `overview()` 路徑判定正確）。coding-agent 側 prompt digest 的條目一律來自 `loadHarnessState` 的 JSON 解析結果，`isNegativeActive` 恆為 `undefined`，fallback 恆為 `Boolean(entry.negative)` → 負向條目**永遠**顯示 `[NEGATIVE - AVOID]`，`[NEGATIVE - EXPIRED]` 在生產路徑不可達。
- **重現**（已執行證實）：以 `negative_expires_at = 2020-01-01` 的負向條目寫入 `harness_state.json`，經 `loadHarnessState` → `formatHarnessStateForPrompt` 輸出：
  `- [global:old_neg] [NEGATIVE - AVOID] Old avoid ...`（應為 `[NEGATIVE - EXPIRED]`）
- **測試為何沒抓到**：`test/refinement.test.ts` 新增測試手動掛 `isNegativeActive = () => false` 才得到 EXPIRED tag，繞過了生產形態。
- **建議修正**：
  1. `formatHarnessStateForPrompt` 在 `isNegativeActive` 缺失時，改由 `negative_expires_at` 欄位推斷（`Date.parse(negative_expires_at) < Date.now()` → 過期；未指定 expires → 視為 active）；或
  2. `loadHarnessState` 組裝條目時附上以該欄位實作的 `isNegativeActive`。
  3. 測試改用**純 JSON 形態**的過期負向條目（不手動掛函式），確保覆蓋生產路徑。

### A3-ACC-02 `expected_schema` 未接通：schema 校驗為死路徑

- **對應驗收標準**：二.2-2（「`rlm.spawn` 支援宣告 `expected_schema`；Host Collector 在子 agent `rlm.complete()` 時進行非破壞性 Schema 校驗」）、工作項 3.2.1 / 3.2.3
- **位置**：
  - `packages/coding-agent/src/core/agent-session.ts`
    - `RlmChildRun.expectedSchema?`（約 1075 行）：宣告後**全倉無任何 assignment**（grep 證實）
    - host handler 註冊處（約 11029 行）：`createRlmCompleteHostHandler((resultPayload) => {...})` **未傳第二參數** `expectedSchema`
    - `runRlmChild`（約 12680 行）：spawn kwargs 白名單僅 `name/model/thinking`，其餘直接 throw `Unsupported rlm.spawn kwargs` → `expected_schema` 連傳入通道都沒有
  - `packages/coding-agent/src/core/rlm-runtime.ts`：`createRlmCompleteHostHandler(handler, expectedSchema?)`（約 527 行）的校驗分支（543-548 行）在生產上永不執行
- **影響**：`validateAgainstExpectedSchema` 為死碼；`schema_mismatch` 在生產上恆為 false（child binding 亦不會自設該 flag）；「非破壞性校驗、保留 raw data」的契約行為實際上不存在。
- **建議修正**：
  1. `runRlmChild` kwargs 白名單加入 `expected_schema`（JSON 記錄型別校驗後存入 `RlmChildRun.expectedSchema`）；`RlmRunRequest`/spawn 介面同步暴露該欄位。
  2. 註冊 `rlm.complete` host handler 時傳入該 child run 的 `expectedSchema`。
  3. 補端到端測試（見 A3-ACC-05）。
  4. 同步修正 changelog 字樣（見 A3-ACC-08）。

### A3-ACC-03 內聯 dynamic import 違反 AGENTS.md 規則

- **位置**：`packages/coding-agent/test/rlm-collect.test.ts:281` — `const { validateAgainstExpectedSchema } = await import("../src/core/rlm-runtime.js");`
- **規則**：AGENTS.md「NEVER use inline imports」。該檔案第 17 行已 top-level import 同一模組（`createRlmCollectHostHandler`），直接擴充即可，無任何動態 import 的理由。
- **建議修正**：將 `validateAgainstExpectedSchema` 併入第 17 行的 top-level import。

---

## B. 測試缺口（Major）

### A3-ACC-04 排序數學（Novelty Bonus / FrequencyBoost / RecencyDecay）零測試覆蓋

- **對應驗收標準**：二.2-1 排序算法驗證、工作項 3.1.5（「Novelty Bonus 排序加權與時間衰減」）
- **現況**：`compareRankedHarnessEntries` 已實作與規格一致的公式（1.2x/24h、`0.5^(age/7d)`、`1+ln(1+hit_count)`、inferred 0.5），但 `test/refinement.test.ts` 只有負向 tag 渲染測試；三個乘數的行為**完全沒有測試**。
- **建議測試**（放進既有 `harness digest relevance ranking` suite，勿開新檔）：
  - 同相關度下，24h 內新條目排在更舊條目前（1.2x 生效）；>24h 無加權
  - `hit_count` 差異依 `1+ln(1+h)` 影響排序
  - `last_accessed_at` 7 天前的條目衰減至 0.5x、14 天至 0.25x
  - `inferred` 條目整體 0.5x（既有 inferred 測試可併入對照）

### A3-ACC-05 缺少 schema mismatch 端到端容錯測試

- **對應驗收標準**：二.2-2（「若結構與預期不符，設置 `schema_mismatch: true`，但保留原始 `data`，絕不中斷父 session」）、工作項 3.2.6
- **現況**：`rlm-collect.test.ts` 新增測試只直接呼叫純函式 `validateAgainstExpectedSchema`，未覆蓋 spawn → child `rlm.complete`（data 不符）→ 父端 `collect` 取得 `result.schema_mismatch === true` 且 `data` 原樣保留的完整路徑；「未顯式提報的 fallback 合成」也只在既有 collect 測試中隱式覆蓋（無 `data`/schema 斷言）。
- **建議**：複用 `rlm-collect.test.ts` 既有 faux provider session 基礎設施，補一條 spawn（宣告 schema）→ child 以不符結構提報 → collect 斷言 mismatch 與 raw data 保留的測試。（依賴 A3-ACC-02 接通後才可斷言。）

---

## C. 計劃偏離（Minor：實作或明確標記延後）

### A3-ACC-06 計劃列出但完全未實作之機制

- 「打破禁忌 (Break Taboo)」降級注入：常規搜索無果時注入過期負向記憶（二.1-1、七）— 全倉無對應代碼
- `include_negative` 過濾：`harness.search`/query 的負向過濾參數（三.1 圖）— 未實作
- 負向記憶 3 天快速半衰期：`compareRankedHarnessEntries` 一律 7 天半衰期，未對 `negative` 條目特殊處理（三.1）
- **處理方式**：實作，或在計劃文件與 changelog 中明確標記為 Phase 3.5+ 延後項，避免「已完成」勾選造成誤導。

### A3-ACC-07 `update_entry` 未更新存取統計

- **對應**：工作項 3.1.2（「在 `get_entry()`、`search()`、`update_entry()` 中更新 `hit_count` 與 `last_accessed_at`」）
- **現況**：僅 `get()` 與 `search()` 呼叫 `recordAccess()`；update 路徑未計入（`apollo-cli-runtime/src/rlm/harness.ts`）。
- **處理方式**：update 時更新 `last_accessed_at`（hit_count 是否計入需設計取捨，建議至少在 update 時刷新 last_accessed_at）。

### A3-ACC-08 Changelog fragment 過量宣稱

- **位置**：`packages/coding-agent/.changes/phase3-negative-space-and-subagent-contract.md`
- **問題**：「Implemented typed subagent result contract with non-blocking JSON schema validation and fallback synthesis in rlm.collect」— schema validation 目前未接通（A3-ACC-02），該句對使用者而言屬未生效功能。
- **建議**：改寫為與實際生效行為一致；A3-ACC-02 修復接通後再恢復該表述。

---

## D. 工作樹衛生

### A3-ACC-09 工作樹混有 8 個與 Phase 3 無關的文件刪除

- `git status` 顯示下列刪除不在 Phase 3 計劃範圍內：
  `docs/harness-rlm-gap-review.md`、`docs/harness-rlm-tune-suggest-phase1-p0-1.2-todolist.md`、`docs/harness-rlm-tune-suggest-phase1-todo.md`、`docs/iscript-failure-review.md`、`docs/iscript-migration-review.md`、`docs/iscript-unresolved-issues-discussion.md`、`docs/rlm-alignment-plan.md`、`docs/rlm-core-test-plan.md`、`docs/textual-removal-plan.md`
- **處理方式**：提交前確認刪除是否為其他 session/agent 的有意產出；依 AGENTS.md Git 規則只 `git add` Phase 3 相關檔案，禁止 `git add -A`。

---

## 已通過項目（供複核對照）

| 項目 | 結果 |
|---|---|
| `npm run check`（biome + tsgo×2 + test-policy + installer + push-guard + browser-smoke） | ✅ 全綠 |
| `npm run check:test-policy` | ✅ 通過 |
| 3.1.1 `HarnessEntry`/`HarnessEntryInit` 擴充四欄位、反序列化預設（`negative:false`、`hit_count:0`） | ✅ |
| 3.1.2 `isNegativeActive()`/`recordAccess()`、`get()`/`search()` 統計與持久化 | ✅（update 路徑見 A3-ACC-07） |
| 3.1.3 runtime `overview()` 的 `[NEGATIVE - AVOID]`/`[NEGATIVE - EXPIRED]` 渲染 | ✅（coding-agent digest 路徑見 A3-ACC-01） |
| 3.1.4 排序公式與規格一致 | ✅（測試見 A3-ACC-04） |
| 3.2.1 `RlmStructuredResult` 型別（status 為計劃集合的超集，+cancelled） | ✅（expected_schema 部分見 A3-ACC-02） |
| 3.2.2 `validateAgainstExpectedSchema` 純函式行為 | ✅（接線見 A3-ACC-02） |
| 3.2.3/3.2.5 `rlm.complete` host handler 與 REPL 端 binding（`mod.ts`） | ✅ 管路存在 |
| 3.2.4 `collectRlmSubagents` 結構化提取 + settled fallback 合成 | ✅（in-flight 子體無 `result`；timed_out/orphaned 未合成） |
| 3.4.1 Spike 文件（node:vm / isolated-vm / worker_threads 比較與建議） | ✅ |
| 測試：runtime `harness.test.ts` 3/3（node:test）；coding-agent `refinement.test.ts` 89 + `rlm-collect.test.ts` 9 全過 | ✅ |

## 修復後複驗命令

```bash
# 門禁
npm run check
npm run check:test-policy

# 測試（注意：vitest 路徑須相對執行目錄解析，bash 需先 cd 到套件根）
cd apollo-cli-runtime && node --experimental-strip-types --test test/harness.test.ts
cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/refinement.test.ts test/rlm-collect.test.ts
```

## 通過條件

1. A3-ACC-01、A3-ACC-02、A3-ACC-03 修復並各附覆蓋生產形態的測試
2. A3-ACC-04、A3-ACC-05 測試補齊
3. A3-ACC-06/07/08 實作或明確標記延後/改寫
4. A3-ACC-09 提交範圍確認
5. 複驗命令全綠
