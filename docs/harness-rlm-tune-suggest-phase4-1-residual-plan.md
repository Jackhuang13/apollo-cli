# Phase 4.1 協定與命名清理 — 實作計劃（核實修訂版）

- 依據文件：`docs/harness-rlm-tune-suggest.md`（Phase 4: P3 協定清理與測試體質健全之 4.1 協定與命名清理）
- 前序文件：`docs/harness-rlm-tune-suggest-phase4-1-plan.md`（核心範圍已實作）、`docs/harness-rlm-tune-suggest-phase4-1-acceptance-issues.md`（初驗與複驗驗收關閉）
- 產出日期：2026-10-25（修訂於 2026-10-26）
- 基線：HEAD `5be5a94`（包含 IScript REPL runtime hardening、AST strip fallback 與 compaction tombstones）
- 狀態：**已核准待實作**（使用者已裁決：核准死碼移除、維持現行環境變數命名不新增多餘變數）

---

## 0. 現況核實（計劃前提）

Phase 4.1 核心範圍**已實作並驗收**（commits `3376cb9` / `3265b20` / `5be5a94`）：

- Ready payload 已乾淨：`{event, protocol: 3, runtime: "node"|"deno", node, deno?}`（`apollo-cli-runtime/src/rlm/repl.ts:1966-1979`），虛假 `python` / 偽造 `deno` 欄位已移除；host 端僅校驗 `protocol: 3`（`packages/coding-agent/src/core/kernel/repl-manager.ts:1048-1052`）。
- `iscript` 工具 label / description / promptSnippet 已環境感知（`iscript.ts:729-741`：`iscript (Node VM)` / `iscript (Deno)`）。
- 預設進度文案已改 IScript 語彙（`iscript.ts:553-592`）。
- Deno PermissionDenied hint、`iscript-kernel.md` ready 握手章節、對應測試均已就位。

**本計劃範圍 = 文件 4.1 第 2 點之殘留**：「統一內部溝通字串，減少在 node 核心中殘留的 python/deno 混用痕跡」。所有清單均經 HEAD `5be5a94` 實測 grep 核實。

---

## 1. 範圍邊界

**目標範圍**：
1. 模型可見 prompt / compaction note / session 自訂訊息 / 錯誤字串中殘留的 "Python kernel" / "Python REPL" 誤導詞。
2. TUI / CLI 可見標籤與 tagline（如 `Started fresh Python kernel`、`--help` tagline）。
3. Refinement 與 Harness 雙端 contract 一致化（修復 `validateEdit` 寫死拒絕非 python reference 的缺陷）。
4. 內部連線標記（原子替換為 `__APOLLO_ISCRIPT_SKILL_IMPORT_ERRORS__` 並保留相容別名）。
5. 死碼移除（依使用者裁決：移除 `buildPythonBootstrapCode`、`acp-mcp.ts` 之 python 分支與對應測試）。
6. 註解清理與文件/Changelog 同步。

**非目標（明確排除）**：
- 不刪除 Python venv provisioning 路徑（`ensureKernelPython` / uv / venv，仍為 live：`postinstall.ts`、`cli/runtime-bootstrap.ts` 呼叫）。依審查判定，此處為真實 Python venv，保留語意，不進行無謂更名。
- 不改動 ready 協定 wire 格式（protocol 維持 3）。
- 不改動 session transcript 持久化 customType 值（`ipython_state`、`ipython_state_restored`、`python_skills_unavailable`），避免破壞舊歷史檔案渲染。
- 不新增 `APOLLO_KERNEL_INTERPRETER` 環境變數（維持 `APOLLO_KERNEL_DENO` 與 `PRIME_AGENT_KERNEL_PYTHON`，避免設定面擴張）。
- 不刪除 `CodePreviewLanguage` 中的 `"python"` 與 `previewPythonCode()`，因其供 `2193-rendering-review.test.ts` 與語法預覽使用。

---

## 2. 殘留清單（經 HEAD 核實）

### A. 模型可見 Prompt / 通知 / 錯誤（優先最高）

| # | 位置 | 現況 | 處置方式 |
|---|---|---|---|
| A1 | `system-prompt.ts:178` | 「pre-imported **Python** `mcp` object in the **Python REPL** … installed **Python** skills」 | 改為 `pre-imported mcp object in the IScript REPL ... installed IScript skills` |
| A2 | `compaction/compaction.ts:468` | `KERNEL_PERSIST_SUMMARY_NOTE`：「the **Python** kernel keeps running … every **Python** variable…」 | 改為 `the IScript kernel keeps running — every variable, import, and helper...` |
| A3 | `agent-session.ts:8645-8647` | `[python-state]` 通知：「Your **Python kernel** persisted through compaction…」 | 標記改為 `[kernel-state]`；文字改為 `Your IScript kernel persisted...`（保留 customType） |
| A4 | `agent-session.ts:8670` | `[python-state-restored]` 標記 | 標記改為 `[kernel-state-restored]`（保留 customType `ipython_state_restored`） |
| A5 | `agent-session.ts:8740-8749` | `[python-skills-unavailable]` 內文：「installed **Python** skill modules … **Python** kernel」 | 標記改為 `[kernel-skills-unavailable]`；文字改為 `...into the IScript kernel`；保留 uv pip / venv 指引 |
| A6 | `agent-messages.ts:548` | 「Restart the **Python kernel** to load the current skills…」 | 改為 `Restart the IScript kernel...` |
| A7 | `kernel/shared.ts:17` | busy 錯誤：「The **Python kernel** is still running the previously interrupted cell…」 | 改為 `The IScript kernel is still running...` |
| A8 | `refinement/refinement.ts:147,152,187,764-767` | 精煉 prompt：「**Python REPL** kernel」×4、`{"type":"python"}` | 改為 `IScript REPL`，推薦 `{"type":"iscript"}` |
| A9 | `cli/command-registry.ts:331` | CLI 首屏 tagline：「AI coding assistant with a **Python REPL** tool」 | 改為 `AI coding assistant with an IScript REPL tool` |
| A10 | `tools/iscript.ts:193` | `iscriptSchema` description 寫死 `persistent IScript (Node) REPL` | 改為環境中立之 `persistent IScript REPL` |

### B. TUI / 使用者可見

| # | 位置 | 現況 | 處置方式 |
|---|---|---|---|
| B1 | `injected-prompt-message.ts:146` | 「Started fresh **Python kernel**」/「Restored **Python kernel** state」 | 改為 `Started fresh IScript kernel` / `Restored IScript kernel state` |
| B2 | 同檔 `150-155` | 「**Python** skills unavailable」標籤（含長度計算） | 改為 `IScript skills unavailable`，同步更新長度數字 |
| B3 | `modes/interactive/components/iscript-cell.ts:401` | `preview.language === "deno" \|\| preview.language === "python" ? "deno"` | 簡化多餘判斷（保留 `code-preview.ts` 的型別定義） |

### C. Refinement 與 Harness 雙端契約（關鍵修正）

- **C1 (`refinement.ts:1130-1145`)**：`validateEdit()` 原先寫死 `if (reference.type !== "python") return ...`。**修正**：擴充接受 `"iscript" | "python" | "typescript" | "deno"`，錯誤訊息改為 `skill reference.type must be 'iscript' or 'python'`（與 runtime `harness.ts:392` 一致）。
- **C2 (`harness.ts:388,393,436,1265`)**：錯誤文案與 overview 的 call contract 改以 IScript 優先；接受值維持不變。

### D. 內部識別元與連線標記

- **D1 (`iscript.ts:69-80,136`)**：連線標記由 `__PRIME_AGENT_PYTHON_SKILL_IMPORT_ERRORS__` 改為 `__APOLLO_ISCRIPT_SKILL_IMPORT_ERRORS__`。以 `ISCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER` 為正規常數，舊常數保留為別名。
- **D2 (`skills.ts:53-61,222-233`)**：反轉 `IScriptSkillRuntimeInfo` / `getIScriptSkillRuntimeInfo` 為正規宣告，`Python*` 保留為 alias。
- **D3 (`shared.ts` / `repl-manager.ts` / `iscript.ts`)**：`options.python` 與 `pythonSkills` 保留以相容測試 mock。

### E. 死碼移除（已核准）

- **E1 (`iscript.ts:151-188`)**：移除永不可達的 `buildPythonBootstrapCode`。
- **E2 (`acp-mcp.ts:9,32-54`)**：移除 `Interpreter` 之 `"python"` 分支及 print 邏輯。
- **E3 (`repl-manager.ts:301-315`)**：`_interpreter` 收窄為 `"script"`，移除 `buildPythonBootstrapCode` 分派臂。
- **E4 (`test/acp-mcp.test.ts:216-229`)**：同步刪除已移除 python 分支之單元測試（落實 Deleting code deletes its tests）。

### F. 註解清理

- 清理遺留之 Python 敘述：`repl.ts:184`、`goals.ts:46`、`agent-session.ts:526,538,3982,4931,11517`、`messages.ts:350`、`kernel/shared.ts:27-28`、`iscript.ts:65,347`、`modes/acp/acp-events.ts:22`。

---

## 3. 相容性分類（依 AGENTS.md 紀律）

| 變更 | 分類 | 處置 |
|---|---|---|
| Wire Ready payload | 已完成，維持不變 | host 僅校驗 `protocol: 3` |
| 連線標記 rename | backward-compatible | 同 commit 原子更新模板與 parser，保留 alias |
| customType 值 | **持久化於 session 檔** | **維持不變**（`ipython_state`、`ipython_state_restored`、`python_skills_unavailable`） |
| bracket 語法（`[kernel-state]` 等） | 模型可見文字 | 邏輯以 customType 辨別而非 regex，改名安全 |
| Refinement `reference.type` 接受值 | durable harness format | 雙端均支援 `"iscript"` 與 `"python"`，prompt 推薦 `"iscript"` |
| 環境變數 | 使用者可見 | 維持 `APOLLO_KERNEL_DENO` 與 `PRIME_AGENT_KERNEL_PYTHON` |

---

## 4. 實施步驟（S1～S6）

### S1：模型可見 Prompt、通知與錯誤清理（A1～A10 + C1～C2）
1. 更新 `system-prompt.ts`、`compaction.ts`、`agent-messages.ts`、`kernel/shared.ts`、`iscript.ts`。
2. 更新 `agent-session.ts`（bracket 標籤與提示文字）。
3. 更新 `refinement.ts` prompt 與 `validateEdit()` 驗證邏輯；同步更新 runtime `harness.ts`。
4. 同步更新直接相關測試：
   - `test/agent-session-services.test.ts`
   - `test/refinement.test.ts`
   - `test/suite/agent-session-queue.test.ts`
   - `test/suite/regressions/kernel-python-skills-unavailable.test.ts`
   - `test/repl-kernel-abort.test.ts`
   - `apollo-cli-runtime/test/harness.test.ts`

### S2：TUI 與 CLI 可見文字（B1～B3 + A9）
1. 更新 `injected-prompt-message.ts`（標題與長度計算）。
2. 更新 `command-registry.ts` tagline。
3. 同步更新 `test/compiled-artifact.test.ts`（斷言更新為 `IScript REPL`）。
4. 簡化 `iscript-cell.ts:401` 判斷（保留 `code-preview.ts` 定義供 `2193` 測試使用）。

### S3：連線標記與識別元清理（D1～D3）
1. 更新 `iscript.ts` 連線標記並保留 alias。
2. 更新 `test/ipython-bootstrap.test.ts` 斷言。
3. 反轉 `skills.ts` 內 `IScriptSkillRuntimeInfo` 宣告。

### S4：死碼移除（E1～E4）
1. 刪除 `iscript.ts` 的 `buildPythonBootstrapCode`。
2. 刪除 `acp-mcp.ts` 的 `"python"` 分派分支。
3. 收窄 `repl-manager.ts` 的 `_interpreter`。
4. 刪除 `test/acp-mcp.test.ts` 針對 python 分支的測試斷言。

### S5：註解、文件與 Changelog（F1 + 文件）
1. 逐條清理註解（如 `repl.ts`、`goals.ts`、`agent-session.ts` 等）。
2. 更新 `packages/coding-agent/docs/iscript-kernel.md`。
3. 建立 Changelog fragment：`packages/coding-agent/.changes/phase4-1-naming-residuals.md`。

### S6：驗證與門禁
1. 執行 `npm run check`（包含 biome、check:test-policy、tsgo 等）。
2. 執行受影響測試檔（雙環境：有 / 無 `APOLLO_KERNEL_DENO`）。

---

## 5. 測試驗證清單

依 AGENTS.md 規則，於 package root 執行指定測試：
```bash
# Runtime 端
cd apollo-cli-runtime && node --experimental-strip-types --test test/repl.test.ts test/harness.test.ts

# Host 端（分別於有/無 APOLLO_KERNEL_DENO 執行）
cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run \
  test/agent-session-services.test.ts \
  test/refinement.test.ts \
  test/ipython-bootstrap.test.ts \
  test/ipython-provisioner.test.ts \
  test/repl-kernel-abort.test.ts \
  test/acp-mcp.test.ts \
  test/compiled-artifact.test.ts \
  test/suite/agent-session-queue.test.ts \
  test/suite/regressions/kernel-python-skills-unavailable.test.ts \
  test/suite/regressions/2193-rendering-review.test.ts
```

- **Grep 門禁**：
  `grep -rniE 'python kernel|python repl|python variable' packages/coding-agent/src apollo-cli-runtime/src` 僅剩 `bootstrap.ts` 真實 venv provisioning 描述；`[python-` bracket 應為 0。
- **測試行數預算**：測試修改嚴格遵守 1:1 替換；S4 刪除程式碼同時刪除對應測試行，保證測試淨增行數 ≤ 0。

---

## 6. 驗收標準

- **AC-1**：模型可見 prompt、通知、錯誤與 CLI tagline 零 "Python kernel / Python REPL" 誤導詞。
- **AC-2**：Refinement 提案支援 `{"type":"iscript"}` 且能通過 `validateEdit` 檢驗與 apply。
- **AC-3**：舊 session 檔（含 `ipython_state_restored` 等 customType）解析與顯示完全正常。
- **AC-4**：指定測試清單在雙環境下 100% 通過。
- **AC-5**：`npm run check` 全綠，Changelog fragment 依規範就位。
