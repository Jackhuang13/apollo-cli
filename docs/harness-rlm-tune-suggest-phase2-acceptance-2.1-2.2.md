# Phase 2 驗收報告與 Issues — 工作項 2.1 / 2.2（Restore 驗證）

- 依據文件：`docs/harness-rlm-tune-suggest.md`（Phase 2: P1）、`docs/harness-rlm-tune-suggest-phase2-plan.md`
- 驗收日期：2026-10-24
- 驗收方式：唯讀（code review + 實測探針 + 唯讀等效靜態門禁）
- 驗收範圍：工作項 2.1（Kernel Restore 探針與保護機制）、2.2（Host 與 Prompt 的 Restore 通知調優）
- 驗收基線：HEAD `008181b` + 未提交變更（`apollo-cli-runtime/src/rlm/repl.ts`、`apollo-cli-runtime/test/snapshot.test.ts`、`packages/coding-agent/src/core/kernel/{state-snapshot,repl-manager}.ts`、`packages/coding-agent/src/core/agent-session.ts`）

## 一、 驗收結論

**不通過。** 2.1 存在 1 個關鍵功能缺陷（ISSUE-1，`prototype_lost` 判定為死代碼）與 1 個缺失測試（ISSUE-2）；2.2 代碼層面完成，但其核心用戶可見行為（class 方法丟失的重建指引）因 ISSUE-1 幾乎永不觸發（ISSUE-3）。

| 工作項 | 項目 | 結果 |
|---|---|---|
| 2.1 | 2.1.1 深度限制 (max=3) 與 WeakSet 循環防護探針 | ✅ 通過 |
| 2.1 | 2.1.2 原型鏈健康檢查 | ❌ **不通過（ISSUE-1）** |
| 2.1 | 2.1.3 Restore done 事件擴充 verified/unverified | ✅ 通過 |
| 2.1 | 2.1.4 Restore 探針單元測試 | ⚠️ 部分（ISSUE-2：`prototype_lost` 測試缺失） |
| 2.2 | 2.2.1 `RestoreResult` 型別擴充 | ✅ 通過 |
| 2.2 | 2.2.2 `repl-manager` 解析 verified/unverified | ✅ 通過 |
| 2.2 | 2.2.3 `[python-state-restored]` 通知文案 | ✅ 代碼完成（ISSUE-3/4 為次要） |
| 2.5 | 靜態門禁 | ✅ 通過（唯讀等效，見下） |

### 通過項證據摘要

- `_verifyRestoredGlobal`（`repl.ts`）：depth ≥ `MAX_RESTORE_VERIFY_DEPTH` (3) → `complex_structure`；`WeakSet` 防循環；每層最多 50 子節點；Map/Set 迭代檢查，Date/RegExp/ArrayBuffer/BigInt 健康判定。
- 實測 restore done payload 含完整結構：
  `{"id":"rest","event":"done","status":"ok","restored":["myWidget"],"verified":["myWidget"],"unverified":[],"failed":[]}`
- `doneFields` 為原始事件對象（無欄位白名單過濾），`verified`/`unverified` 可完整穿透至 host。
- 向後相容：`RestoreResult.verified/unverified` 為可選；舊 runtime 無欄位時 host 回退 `restored`，新 runtime 對舊 host 多餘欄位被忽略。
- `snapshot.test.ts`：3/3 通過；`tsgo --noEmit`（root 與 apollo-cli-runtime）通過；`biome check .`（唯讀、無 `--write`）通過；`check:test-policy`、`check:installer`、`check:push-guard` 通過。
  （未跑完整 `npm run check`：其含 `biome check --write` 會修改文件，與唯讀驗收衝突；各組件已逐一唯讀等效驗證。）

## 二、 Issues

### ISSUE-1（阻斷）：`prototype_lost` 判定為死代碼 — class 實例方法丟失偵測不到

- **位置**：`apollo-cli-runtime/src/rlm/repl.ts` → `_verifyRestoredGlobal()`（`proto === Object.prototype` 分支）
- **影響**：2.1.2 驗收標準與 2.2.3 的核心目標（「徹底消除模型對遺失方法的誤調用」）未達成。
- **期望**：class 實例經 snapshot → restore 後，方法丟失者應歸入 `unverified`（reason `prototype_lost`）。
- **實際**：同一變數被報告為 `verified`（可直接使用）。

**實測證據 A（v8 行為，Node v22.23.1）**：

```js
class Foo { x = 1; method() { return 42; } }
const g = v8.deserialize(v8.serialize(new Foo()));
Object.getPrototypeOf(g) === Object.prototype  // true
g.constructor?.name                            // "Object"（繼承自 Object.prototype）
typeof g.method                                // "undefined"（方法已丟失）
```

**實測證據 B（端到端 snapshot → restore）**：

```js
class Widget { label = 'w'; render() { return '<widget/>'; } }
globalThis.myWidget = new Widget();
recordUserGlobal('myWidget');
handleSnapshot({ id: 'snap', path, manifest_path });
delete globalThis.myWidget;
handleRestore({ id: 'rest', path });
// done payload: {"restored":["myWidget"],"verified":["myWidget"],"unverified":[],"failed":[]}
// typeof globalThis.myWidget.render === "undefined"   ← 方法已丟失，卻被標記 verified
```

**根因**：
1. 判定條件為 `Object.getPrototypeOf(obj) === Object.prototype && obj.constructor?.name !== "Object"`。但 v8 反序列化後 class 實例退化為 plain object，其 `constructor` 為**繼承自** `Object.prototype`，`name === "Object"`，條件恆不成立 → 分支不可達。
2. 根本限制：**類身份在 snapshot 時即已丟失**。二進制 frame 僅含 name + v8 payload；manifest 的 `saved` 為 `string[]`（純名稱）。restore 端僅能從反序列化值做启发式判斷，而該信息已不存在。
   注意：`handleSnapshot` 內部 `frames` 已有 `type: _classifyType(value)`（能取得 `constructor.name`，如 `"Widget"`），但未持久化。

**建議修復路徑**：
1. snapshot 端持久化類身份：在 manifest 增加 `types: Record<string, string>`（或 `saved: Array<{name, type}>`），數據來源即現有的 `_classifyType(value)`；manifest 為版本化 JSON（`version: 1`），可平滑擴充。
2. restore 端 `handleRestore` 讀取 manifest 對照：快照 `type` 為自訂 class（非 Array/Map/Set/Date/RegExp/ArrayBuffer 等 builtin）而還原後 `Object.getPrototypeOf(value) === Object.prototype` → `unverified`（reason `prototype_lost`）。
3. 保留現有启发式作為無 manifest 時的降級路徑。

### ISSUE-2（阻斷，測試）：2.1.4 聲稱完成的 `prototype_lost` 測試不存在

- **位置**：`apollo-cli-runtime/test/snapshot.test.ts`
- **事實**：全倉 grep 無任何測試引用 `prototype_lost`。現行 2.1.4 測試僅覆蓋：循環引用、`complex_structure`、builtin 型別。
- **影響**：ISSUE-1 的缺陷不會被測試攔截；計劃文件對 2.1.4 的「☑ 完成」屬過度聲稱。
- **要求**：補回歸測試 —— 自訂 class 實例（帶方法）→ `handleSnapshot` → `handleRestore` → 斷言 done payload `unverified` 含 `{ name, reason: "prototype_lost" }` 且 `verified` 不含該名稱；並斷言還原值 `typeof value.method === "undefined"`（證明測試確實覆蓋了方法丟失場景）。

### ISSUE-3（次要）：`prototype_lost` 通知分支實際永不觸發

- **位置**：`packages/coding-agent/src/core/agent-session.ts` → `_onIpythonStateRestored()`
- **事實**：文案分支（`"Class methods are missing. Please re-instantiate or re-import the class."`）代碼正確，但因 ISSUE-1，runtime 幾乎不産生 `prototype_lost` reason。
- **結論**：代碼通過，隨 ISSUE-1 修復後自然生效；建議修復後以 ISSUE-5 的測試覆蓋端到端文案。

### ISSUE-4（次要）：舊 runtime 降級路徑文案誤稱「已驗證」

- **位置**：`packages/coding-agent/src/core/agent-session.ts` → `const verified = result.verified ?? result.restored;`
- **事實**：舊 daemon（done 事件無 `verified` 欄位）時，未做探測的全量 `restored` 名稱會被宣稱為「have been verified and are ready to use」。
- **影響**：lockstep 發布（同版本發布）下新舊混跑窗口極小，風險低。
- **建議**：降級路徑改用舊文案（「are available again」）或標註「unverified」，與新路徑區分。

### ISSUE-5（次要，測試覆蓋）：`[python-state-restored]` 新文案無測試

- **事實**：無任何測試斷言 `_onIpythonStateRestored` 的三段新文案（verified 清單、`prototype_lost`、`complex_structure`）。
- **建議**：在 coding-agent 現有 suite 中補最小測試（構造 `RestoreResult` 三個代表性變體，斷言輸出行）。注意測試行數預算。

### ISSUE-6（文檔一致性）：phase2-plan 進度表過度聲稱

- **位置**：`docs/harness-rlm-tune-suggest-phase2-plan.md`
- **事實**：2.1.2、2.1.4（prototype_lost 測試）及 2.5 均標「☑ 完成」，與實測不符（2.1.2 功能缺陷、2.1.4 測試缺失）。
- **要求**：修復合入後更新進度表狀態，避免誤導後續驗收。

## 三、 修復後複驗清單（Re-acceptance Checklist）

1. 新測試（ISSUE-2）：class 實例 → snapshot → restore → done payload `unverified` 含 `prototype_lost`，`verified` 不含。
2. 重跑 ISSUE-1 的端到端探針：`myWidget` 應出現在 `unverified` 而非 `verified`。
3. `complex_structure`、循環引用、builtin 既有測試保持綠。
4. `[python-state-restored]` 文案測試（ISSUE-5）覆蓋 `prototype_lost` 分支實際觸發。
5. `npm run check` 全量通過（含 `check:test-policy`）。
6. 更新 `docs/harness-rlm-tune-suggest-phase2-plan.md` 進度表（ISSUE-6）。

## 四、 範圍外備註

- 工作項 2.3 / 2.4（`HarnessEntry.source_type`、`[HYPOTHESIS - UNVERIFIED]` 標記、`<verification>` CoT、矛盾取代）已在工作樹中（`harness.ts`、`refinement.ts`、`refinement.test.ts`），**未在本次驗收範圍內**，另行驗收。
- `packages/coding-agent/dist/prime-agent-runtime/**`（Python 舊軌道）為 gitignore 構建產物，非源碼依據；若其仍被啟動，host 端 `verified` 缺失時平滑降級（`?? restored`），無相容性風險。
- 計劃中 2.1.3 字面規格 `restored: verified // 向後相容` 與實現（`restored` = 全部還原名稱，`verified` ⊆ `restored`）不一致；實現語義更合理且對舊 host 完全向後相容，視為對計劃的合理修正，記錄在案。
