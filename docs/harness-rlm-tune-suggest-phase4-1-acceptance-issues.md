# Phase 4.1 驗收 Issues — IScript 協定清理、執行環境識別與命名清理

- 驗收依據：[`docs/harness-rlm-tune-suggest-phase4-1-plan.md`](./harness-rlm-tune-suggest-phase4-1-plan.md)（2026-10-25 核實修訂版）
- 驗收日期：2026-10-25
- 被驗收對象：`HEAD b19e1dc` 之上的未提交工作樹變更（`git status` 所列 Phase 4.1 相關檔案：`repl.ts`、`bash.ts`、`repl.test.ts`、`iscript.ts`、`repl-manager.ts`、`iscript-kernel.md`、changelog fragment、計劃文件）
- 驗收方式：靜態比對驗收標準與 diff、運行門禁（`npm run check`）、運行相關測試檔、Node / Deno 雙端獨立重現 ready 握手
- **總結論（2026-10-25 複驗）：附帶條件通過** — 功能性 Blocker ×2 與 Major ×3 全部關閉，門禁與測試雙環境全綠；剩餘 5 項（文件殘段 ×2、註解/引用殘留 ×2、測試缺口 ×1）與提交範圍確認須於 commit 前清結（見「複驗記錄」）

---

---

## 複驗記錄（2026-10-25）

依據 CAPA（`docs/harness-rlm-tune-suggest-phase4-1-capa-plan.md`）交付之修補重新驗收。

### 複驗結果（逐條對照）

| 缺陷編號 | 初驗 | 複驗 | 證據 |
|---|---|---|---|
| A4-ACC-01 | Blocker | ✅ 關閉 | `createIScriptToolDefinition` 新增可注入 `env`（`iscript.ts`），測試改傳 `{ env: {} }` 並新增 Deno 分支用例；**有/無** `APOLLO_KERNEL_DENO` 雙環境均 23/23 |
| A4-ACC-02 | Blocker | ✅ 關閉（註解殘留轉 A4-ACC-05） | doStart 新增 `options.python` 顯式 override 分岔（`repl-manager.ts:407-410`）：override 作為 spawnCmd、TS runtime 路徑為參數 → 假 interpreter 如期失敗；`ipython-provisioner.test.ts` 21/21 |
| A4-ACC-03 | Major | ✅ 關閉 | `copy-binary-assets.mjs`：`binaryAssets`、`copyBinaryAssets()`、`validateBinaryAssets`（marker `apollo-cli-runtime/src/rlm/mod.ts`）三處均已補 |
| A4-ACC-04 | Major | ⚠️ 部分（4/5 節） | Current state、Execution path、P1 bootstrap（移除）、P2 字串清單已改寫；**殘留**：「Distribution reality」（125-130 行）仍稱「僅打包 prime-agent-runtime、installed releases always run the Python kernel、source checkout 才可用」——與 A4-ACC-03 修復及 Python 廢除雙重矛盾；4428「test is stale」註記（204-205 行）仍失實（實測 5/5）；234-236 行「until the Python fallback is retired」/「Fix the stale 4428」兩步過期 |
| A4-ACC-05 | Major | ✅ 關閉（使用者可見層面） | "Waiting/Restarting ${kernelName} kernel..." 環境感知、448 協定錯誤訊息、bootstrap 錯誤訊息均改 IScript 語彙，測試同步；**殘留（純註解，轉 A4-ACC-05R）**：`repl-manager.ts:2` 檔頭、377-381 行（仍稱「selects the Python branch」，與新 override 分岔矛盾）、535 行 "(repl.py _setup_fds)"、`iscript.ts:581-582` "otherwise the Python fallback"、419 行 PYTHONUTF8 |
| A4-ACC-06 | Minor | ✅ 關閉 | label / description / promptSnippet 三處 Node 分支統一 "Node VM" |
| A4-ACC-07 | Minor | ✅ 關閉 | `repl.ts` `_knownFailureHint` 新增 Deno PermissionDenied / "Requires .* permission" 診斷提示 |
| A4-ACC-08 | Minor | ⚠️ 部分 | 1647-1656 → 1654-1669 ✓、deno 片段補 `--unstable-node-globals` ✓；**殘留**：計劃二衝擊表仍引「repl-manager.ts:948 僅校驗 protocol: 3」，實際校驗在 445-450 |
| A4-ACC-09 | Minor | ⚠️ 部分 | prompt-gate 已補 label 雙環境斷言（Node VM / Deno）；**殘留**：default-path "Starting IScript kernel..." / "Restoring/Preparing IScript..." 仍無斷言（`ipython-provisioner.test.ts` 僅更新 Waiting/Restarting 兩處） |
| A4-ACC-10 | Minor | ✅ 關閉 | 共用 `resolveKernelRuntime(options, env)` 抽出（`iscript.ts:699-717`），label / 進度 / 錯誤文案三處共用；legacy 判定改 `endsWith("node")` 不再子串匹配 |
| A4-ACC-11 | Hygiene | ⏳ 待提交驗證 | CAPA 已聲明：`bash.ts` 列入本階段配套、`exa-mcp-setup-plan.md` 排除；尚未 commit，commit 時按 AGENTS.md 顯式檔案清單核對 |

### 複驗過程新增發現（A4-ACC-12 / 13 / 14）

- **A4-ACC-12**（Phase 4.1 相關）：`test/kernel-bootstrap-windows.test.ts:189-206` "launches the canonical piped CPython REPL directly with UTF-8" 斷言 override 派生參數為 `["-m", "rlm.repl"]`（舊 Python 語意）——新 doStart override 分岔改派生 TS runtime 路徑，該測試在**無** Deno 環境下亦必紅（初驗複驗命令未含此檔而遺漏）。
- **A4-ACC-13**（HEAD 既有）：同檔 4 個 ensureKernelPython 用例環境依賴——`bootstrap.ts:978` 以 `APOLLO_KERNEL_DENO ?? PRIME_AGENT_KERNEL_PYTHON` 取 override，開發機設定 Deno 變數時 `spawn[0]` 為 deno 二進位，斷言全紅（21/22 → 16/22）。
- **A4-ACC-14**（Phase 4.1 相關）：`bootstrap.ts` `runtimeCandidateDirs("script")` 缺 repo-root source candidate（python kind 有 5 層 ```..``` 對應項，script kind 止於 4 層）——乾淨 source checkout（無 dist build，含 CI）在 package-root cwd 下 TS runtime 完全不可解析，doStart 必拋 "Could not resolve apollo-cli-runtime"；本機僅因存在過期 `dist/apollo-cli-runtime`（10-20 build）而誤綠。
- 清理已修復：A4-ACC-12 測試改斷言新 override 語意（派生 `mod.ts` 路徑，PYTHONUTF8 隨死碼移除）；A4-ACC-13 於 `beforeEach` 清除 `APOLLO_KERNEL_DENO` 恢復測試自含；A4-ACC-14 補 5 層 ```..``` repo-root candidate（安裝佈局下該路徑不存在，無影響），並移除本機過期 `dist/apollo-cli-runtime` 副本。
- A4-ACC-14 連帶修正 `test/suite/kernel-host-request-round-trip.test.ts:443` "rejects startup when apollo-cli-runtime cannot be resolved"：repo-root candidate 在 checkout 恆在，該測試改以 `vi.mocked(tsRuntimeCandidateDirs).mockImplementationOnce` 隔離 candidate 來源（doStart 經導出函式呼叫，為可 mock seam）。

### 清理完成狀態（2026-10-25）

5 項剩餘清結 + 3 項新增修復皆已完成並實測：

| 項 | 處置 | 實測 |
|---|---|---|
| A4-ACC-04R | iscript-kernel.md「Distribution reality」改寫（npm/binary 皆含 apollo-cli-runtime，Python kernel 退役）；刪除 4428 過期 bullet、stale steps 7-8 | 目視 |
| A4-ACC-05R | repl-manager.ts:2/377-381/535、iscript.ts:581-582 註解清結；PYTHONUTF8 死碼自 doStart childEnv 移除；state-snapshot.ts 檔頭 dill 敘述同步修正（v8 serialize，.dill 為 legacy 路徑名） | 目視 + grep 無殘留 |
| A4-ACC-08R | 計劃檔 948 → 445-450 | 目視 |
| A4-ACC-09R | ipython-provisioner.test.ts 新增 default-path "Starting IScript kernel..." 斷言 | 22/22 |
| A4-ACC-11 | 已於 commit 3376cb9 顯式檔案清單落定（含 bash.ts / CAPA / 驗收文件；排除 exa-mcp-setup-plan） | 已 commit+push |
| A4-ACC-12/13 | 見上 | windows 21/21（有/無 Deno env） |
| A4-ACC-14 | 見上 | provisioner 22/22、round-trip 19/19（有/無 Deno env） |

### 複驗門禁實測（2026-10-25）

| 項目 | 結果 |
|---|---|
| `npm run check`（biome + check:test-policy + tsgo×2 + installer + push-guard + browser-smoke） | ✅ exit 0 |
| runtime Node：`apollo-cli-runtime/test/repl.test.ts` | ✅ 16/16 |
| runtime Deno 實測首幀 | ✅ `{"event":"ready","protocol":3,"runtime":"deno","node":"20.11.1","deno":"2.1.9"}`（無 python 欄位） |
| host 四檔（**有** `APOLLO_KERNEL_DENO`）：provisioner / prompt-gate / bootstrap / 4428 | ✅ 60/60（21 + 23 + 11 + 5） |
| host 四檔（**無** `APOLLO_KERNEL_DENO`） | ✅ 60/60 |

### 剩餘清結項（commit 前）

1. **A4-ACC-04R**：`iscript-kernel.md`「Distribution reality」整節改寫（現為：npm 與 binary 皆隨附 `apollo-cli-runtime`、Python kernel 已廢除）；刪改 204-205 行 4428「stale」註記與 234-236 行兩條過期步驟。
2. **A4-ACC-05R**：清理 5 處註解殘留（`repl-manager.ts:2`、377-381、535；`iscript.ts:581-582`）與 419 行 PYTHONUTF8（或明文標記保留原因）。
3. **A4-ACC-08R**：計劃二衝擊表 948 → 445-450。
4. **A4-ACC-09R**：`ipython-provisioner.test.ts` 補一條 default-path 啟動進度訊息斷言（併入既有檔）。
5. **A4-ACC-11**：commit 顯式檔案清單（含 `bash.ts`、CAPA 文件與本驗收文件；排除 `exa-mcp-setup-plan.md`）。

**複驗結論：附帶條件通過** — 功能性缺陷（Blocker ×2、Major ×3）與 Minor 之 6 項已驗證關閉，CAPA 複核標準 1-3（雙環境測試、runtime 測試、品質門禁）全數達成；上表 5 項剩餘清結項（皆為文件/註解/單一測試用例層面，不影響運行行為）清結後本階段可收口。

## A. Blocker（必須修正後才可通過驗收）

### A4-ACC-01 動態工具文案讀取環境變數，使 AC-24 測試變得環境依賴（Deno 環境下必紅）

- **對應驗收標準**：工作項 4.1.2（動態 Label / description / promptSnippet）、計劃二衝擊表（「單元與回歸測試：安全（零破壞）」）
- **位置**：
  - `packages/coding-agent/src/core/tools/iscript.ts:707-720`：`options?.python ?? process.env.APOLLO_KERNEL_DENO` 進入 `createIScriptToolDefinition` 輸出（description / promptSnippet 依 env 切換 Deno 文案）
  - `packages/coding-agent/test/suite/prompt-gate-repl-doctrine.test.ts:86-88`：斷言 `tool.description` + `tool.promptSnippet` 拼接不含 "Deno"、且 `tool.description` 含 "Node"
- **重現**（已執行證實）：本機 `APOLLO_KERNEL_DENO=/home/ck/.deno/bin/deno` 時該檔 21/22，AC-24 失敗（description 含 "Deno"）；`env -u APOLLO_KERNEL_DENO` 重跑 22/22 全綠。
- **影響**：違反測試政策「CI tests must be unconditional and self-contained」——測試結果取決於執行機是否設定 Deno 環境變數。凡以 Deno 為預設 kernel 的開發機（包括本機），常規 `vitest` 執行即紅。
- **建議修正**（擇一）：
  1. 測試內以 `vi.stubEnv` 固定環境（Node 分支斷言前清除 `APOLLO_KERNEL_DENO`；另加一條 Deno 分支用例鎖定 `iscript (Deno)` 文案）；
  2. 或讓 `createIScriptToolDefinition` 接受可注入的 env，測試傳入受控值。

### A4-ACC-02 `ipython-provisioner.test.ts` 8 個「失敗啟動」測試全紅：fake python override 已被 doStart 靜默忽略

- **對應驗收標準**：計劃二衝擊表（「既有 subprocess 測試保持相容」）
- **位置**：
  - `packages/coding-agent/src/core/kernel/repl-manager.ts:382-410`（doStart）：`configured` 僅在**結尾為 deno** 時被採用；其餘任何 interpreter override（含測試的 fake python shim）被靜默忽略，一律以 `node --experimental-strip-types` 啟動已解析的 TS runtime
  - `packages/coding-agent/src/core/kernel/bootstrap.ts`（`tsRuntimeCandidateDirs`）：候選含 `getPackageDir()`、moduleDir 相對路徑等**封裝相對**候選 → 從任何 cwd（含測試 tempDir）都能解析到本倉 `apollo-cli-runtime/src/rlm/mod.ts`
- **現況**：`test/ipython-provisioner.test.ts` 13/21，8 個以 `writeFakePython()`（`exit 42` shim）傳入 python 選項並期望「啟動失敗 / 不重試快取 / 中斷快照」的用例全部失敗於 "promise resolved ReplKernelManager instead of rejecting"——kernel 以真實 runtime **啟動成功**，失敗路徑已不可達。
- **歸因**：屬 HEAD 既有（本工作樹 diff 未觸及解析/派生路徑；僅改 deno 參數與文案）。但計劃衝擊表「既有 subprocess 測試保持相容、零破壞」之宣稱**與事實相反**，且被驗收模組的測試檔目前為紅。
- **建議修正**：
  1. 將這 8 個用例改指真正的失敗模式：傳入**deno 結尾的假 interpreter**（觸發 spawn 失敗），或以 `PI_PACKAGE_DIR` 指向空目錄期望 "Could not resolve apollo-cli-runtime"；
  2. 明確決定非 deno interpreter override 的語意：目前「靜默忽略」與 `repl-manager.ts:379-381` 註解（"the user's override wins over the TS default. A deno-named interpreter still runs the TS runtime."）**互相矛盾**——註解宣稱 override 優先生效，代碼只剩 deno 一支分岔；二者必改其一。

---

## B. Major（計劃宣稱與事實不符 / 邊界未防護）

### A4-ACC-03 二進位 release 已無可用 kernel：`apollo-cli-runtime` 未進 binary assets，doStart 直接 throw

- **對應**：涵蓋範圍 5（「全代碼庫無 Python Kernel 之事實確認與邊界防護」）、計劃三 1（環境識別與引導）
- **位置**：
  - `packages/coding-agent/scripts/copy-binary-assets.mjs:19-35`（`binaryAssets` 清單）：只有 `prime-agent-runtime`，無 `apollo-cli-runtime`
  - `packages/coding-agent/src/core/kernel/repl-manager.ts:392-395`：解析失敗時 throw "Could not resolve apollo-cli-runtime (TS runtime required for Apollo CLI kernel)"——Python fallback 已移除，**沒有第二條路**
  - `packages/coding-agent/src/config.ts:366`（`getPackageDir`）：Bun binary 取 `dirname(execPath)`（flat sidecar 佈局）
- **影響**：編譯二進位（install.sh / 預設發布形態）的機器上 kernel 啟動必然失敗，且錯誤訊息不會提示「此建置缺少 IScript runtime」。npm 發布無此問題（`copy-assets` 已將 `apollo-cli-runtime` 複製進 `dist/`）。
- **建議修正**（擇一）：
  1. `binaryAssets` 與 `copyBinaryAssets()` 加入 `apollo-cli-runtime`（源於 root，仿 `prime-agent-runtime` 的 `join(root, ...)`），並在 `validateBinaryAssets` 加 marker 校驗（如 `apollo-cli-runtime/src/rlm/mod.ts`）；
  2. 或明確將二進位形態標記為「不支援 kernel」，在 release 腳本/文件加硬門禁，並讓 throw 訊息附帶可操作指引。
- **注意**：此為 HEAD 既有（Python 分岔移除早於本階段），但 Phase 4.1 的「邊界防護」範圍正應覆蓋此邊界，且 `iscript-kernel.md` 的「Distribution reality」節（見 A4-ACC-04）目前雙重失實。

### A4-ACC-04 `iscript-kernel.md` 多處敘述與現行代碼矛盾（工作項 4.1.3 未完成）

- **對應**：工作項 4.1.3（文件更新）、涵蓋範圍 5
- **位置**：`packages/coding-agent/docs/iscript-kernel.md`（本階段僅新增「Ready event handshake」一節，其餘未動）
- **失實清單**（逐條對照現行代碼）：
  1. 「Current state」段：「otherwise it falls back to the legacy Python runtime (python -m rlm.repl ...)」——doStart 已無 Python fallback（改 throw，見 A4-ACC-03）。
  2. 「Execution path (host side)」step 1「ensureKernelPython() runs **unconditionally first**」——doStart 全路徑不再呼叫 ensureKernelPython（僅 CLI/postinstall 入口保留）；step 4「If not found: python -m rlm.repl (legacy runtime)」同為失實。
  3. 「P1: Python bootstrap is still mandatory for IScript starts」整節失實（bootstrap 已不阻塞 IScript 啟動）；同節「APOLLO_KERNEL_DENO env override is validated by executing the binary as Python, so it always fails; the Deno spawn branch is unreachable except via the SDK python option」亦失實——deno 分岔現在可由 env 觸達，且本階段已補 `--unstable-node-globals`（`repl-manager.ts:406`）。
  4. 「P2 and stale artifacts」：「test/suite/regressions/4428-*.test.ts ... is stale」——實測 5/5 通過，該註記本身過期；同節 Python 殘留字串清單應依 A4-ACC-05 結果更新。
  5. 「Distribution reality」節（「Installed npm/binary releases therefore always run the Python kernel」）——npm 現已隨附 `dist/apollo-cli-runtime`；binary 則為 kernel 不可用（A4-ACC-03）。
- **建議**：以現行 doStart 行為重寫上述五節；「Known integration gaps」中仍屬實者（P0-1 / P0-2 等）需逐一複核後保留。

### A4-ACC-05 Host 端 Python 文案殘留未清，目標 3「進度提示真實化」未達

- **對應**：目標 3（「將 Host 端的進度提示統一為代表當前環境之字串」）、AC-4.1.3
- **殘留位置**（均為 host 對使用者/模型可見或對維護者誤導之字串）：
  - `iscript.ts:676` "Waiting for Python kernel..."、`iscript.ts:680` "Restarting Python kernel..."——**無** legacy guard（與 554/574/582 的處理不一致），且被 `test/ipython-provisioner.test.ts:408,439` 以原字串斷言固定
  - `repl-manager.ts:448` 協定錯誤訊息："Update prime-agent-runtime in the kernel Python (PRIME_AGENT_KERNEL_PYTHON) to match this prime-agent."——現行 runtime 為 TS，指引誤導
  - `repl-manager.ts:2` 檔頭註解："python -m rlm.repl"
  - `iscript.ts:584-585` 註解："the TS runtime is preferred when resolvable; otherwise the Python fallback"——fallback 已不存在
  - `repl-manager.ts:531-534` 註解："(repl.py _setup_fds)"——runtime 已為 repl.ts
  - `repl-manager.ts:415` PYTHONUTF8 env 仍設入子行程（無害但同屬殘留）
- **判定**：AC-4.1.3 字面（「不再出現 Starting Python kernel...」）因 legacy guard 成立，勾選字面上可接受；但目標 3 的「統一」與計劃「消除歷史 Python 殘留字串」之宣稱**未達**。
- **建議**：676/680 改為環境感知（或統一 IScript 語彙並同步更新 408/439 斷言）；448 錯誤訊息改指 TS runtime；三處註解隨代碼事實更新。

---

## C. Minor（計劃偏離 / 引用漂移 / 測試缺口）

### A4-ACC-06 Node 分支文案與計劃規格不一致（Node VM vs Node）

- **對應**：工作項 4.1.2（規格：label `iscript (Node VM)`、promptSnippet `persistent TypeScript/JavaScript (Node VM) REPL`）
- **現況**：label 為 `iscript (Node VM)`（`iscript.ts:714`，符合），但 description 為 "persistent IScript (Node) REPL"、promptSnippet 為 "persistent TypeScript/JavaScript (Node) REPL"（717/720 行）——與 label 的 "Node VM" 不一致，亦與計劃文字不符。
- **處理**：三處統一（建議全用 "Node VM" 與 label 一致）；AC-24 的 toContain("Node") 斷言對 "Node VM" 仍兼容。

### A4-ACC-07 工作項 4.1.1「Hint 強化」勾選但本階段 diff 未觸及 `_knownFailureHint`

- **現況**：`repl.ts:808-817` 現存兩條 hint（Deno-not-defined → node: 指引；output() misuse）均源於既有 commit `cd5ea3d`；本階段 diff 未新增任何 hint，計劃宣稱的「Deno 環境下誤調用專用 API 時給予精確對應提示」**不存在**。
- **處理**：實作 Deno 端 hint，或在計劃/changelog 標記延後（`docs/deno-kernel-repl-validation-report.md` 顯示 node: 模組在 Deno 下可載入，此 hint 必要性可降級，但需明文標記）。

### A4-ACC-08 計劃文件行號與片段引用漂移

- 計劃一.3 引 ready payload 現行缺陷位於 `repl.ts:1647-1656`（修訂前行號成立；修正後位於 1654-1669），「核實修訂版」宜更新行號。
- 計劃二衝擊表「repl-manager.ts:948 僅校驗 protocol: 3」——948-950 僅 resolve deferred；實際校驗在 `repl-manager.ts:445-450`（protocol !== REPL_PROTOCOL_VERSION）。結論（host 忽略 runtime/node/deno 欄位、向前相容）經核實**成立**。
- 計劃一.1 引 deno 啟動為 "deno run -A --unstable-kv <mod.ts>"，實作為 "deno run -A --unstable-kv --unstable-node-globals <mod.ts>"（`repl-manager.ts:406`，Deno 下 process global 所需）；WBS 4.1.1 片段同缺此參數。
- **處理**：純文件修正，不改代碼。

### A4-ACC-09 測試缺口：動態 label 與 default-path 啟動文案零覆蓋

- **AC-4.1.2**：全倉無測試斷言 label 為 "iscript (Node VM)" / "iscript (Deno)"（grep 證實）。
- **AC-4.1.3**：default path 的 "Starting IScript kernel..." / "Restoring IScript state..." / "Preparing IScript runtime..." 無任何斷言；唯一相關斷言（`ipython-provisioner.test.ts:195`）走 legacy override 路徑、固定的是**舊** Python 字串。
- **建議**（併入既有檔，勿開新檔）：`prompt-gate-repl-doctrine.test.ts` 加 label/文案雙環境用例（配合 A4-ACC-01 的 stubEnv）；`ipython-provisioner.test.ts` 加一條 default-path 啟動訊息斷言。

### A4-ACC-10 `isLegacyPythonOverride` 判定脆弱且與 label 的環境來源不一致

- **位置**：`iscript.ts:549-552`
  - 以路徑子串 includes("deno") / includes("node") 判定：interpreter 路徑含 "node"（如 /home/node/.local/bin/python3）即被誤判為非 legacy，文案跳過 guard。
  - 文案邏輯只看 `this.options?.python`，而 label 邏輯看 `options?.python ?? process.env.APOLLO_KERNEL_DENO`——同一「環境判定」兩處來源不一。
- **處理**：抽出一個共用的 resolveKernelRuntime(options, env) 回傳 "deno" | "node" | "python-legacy"，label 與進度文案共用。

---

## D. 工作樹衛生

### A4-ACC-11 工作樹混入計劃範圍外變更與無關文件

- `apollo-cli-runtime/src/rlm/bash.ts`（+ Buffer import 與 import 排序）：不在 WBS 4.1.1-4.1.4 內；推測為 Deno 相容驗證（未追蹤檔 `docs/deno-kernel-repl-validation-report.md`，Deno 下 Buffer 非 global）之配套修正。**需確認屬本階段**：屬則補列進計劃 WBS 與 changelog 語意，否則單獨提交。
- 未追蹤的 `docs/exa-mcp-setup-plan.md` 與 Phase 4.1 無關。
- **處理方式**：依 AGENTS.md Git 規則只 git add 本階段相關檔案（`repl.ts`、`bash.ts`（若確認屬本階段）、`repl.test.ts`、`iscript.ts`、`repl-manager.ts`、`iscript-kernel.md`、`phase4-1-protocol-and-naming-cleanup.md`、本計劃文件與本驗收文件），禁止 git add -A。

---

## 已通過項目（供複核對照）

| 項目 | 結果 |
|---|---|
| `npm run check`（biome + check:test-policy + tsgo×2 + installer + push-guard + browser-smoke） | ✅ exit 0 |
| AC-4.1.1 Node 端：runtime `repl.test.ts` 16/16，含新用例「repl emits clean ready event with accurate runtime and no fake python fields」（python/deno 欄位 undefined、runtime = "node"） | ✅ |
| AC-4.1.1 Deno 端（獨立重現）：deno run 首幀 = runtime "deno"、node "20.11.1"、deno "2.1.9"——真實 deno 版本、無 python 欄位 | ✅ |
| AC-4.1.2 label 實作：`iscript.ts:707-714` 依 deno 判定產出 "iscript (Deno)" / "iscript (Node VM)"（文案細節見 A4-ACC-06；測試缺口見 A4-ACC-09） | ✅（實作存在） |
| AC-4.1.3（字面）：default path 不再發出 "Starting Python kernel..."；legacy override（顯式 python 選項）保留舊字串，既有斷言（`ipython-provisioner.test.ts:195`）維持綠 | ✅（殘留見 A4-ACC-05） |
| AC-4.1.4：`npm run check` 與 `check:test-policy` 通過（注意：check 不含測試執行；測試現狀見 A/B 節） | ✅ |
| WBS 4.1.3 ready 握手節：`iscript-kernel.md` 新增 runtime 欄位定義、deno 條件、python 欄位廢除沿革 | ✅（其餘章節失實見 A4-ACC-04） |
| WBS 5 changelog fragment：`packages/coding-agent/.changes/phase4-1-protocol-and-naming-cleanup.md` 存在且與計劃文字一致 | ✅ |
| 衝擊表「核心執行握手無破壞」：host 僅校驗 protocol === 3（`repl-manager.ts:445-450`），忽略新增欄位 → 新/舊 client 與 runtime 交叉皆相容 | ✅（引用行號見 A4-ACC-08） |
| 附加修正（WBS 外但合理）：watchdog unref guard（`repl.ts:1594-1600`，Deno 下 setTimeout 回傳 number，改走 Deno.unrefTimer）；deno 啟動補 --unstable-node-globals | ✅ |
| `test/suite/regressions/4428-*.test.ts` 5/5（文件 P2「stale」註記本身過期，見 A4-ACC-04-4） | ✅ |

## 修復後複驗命令

```bash
# 門禁
npm run check

# runtime（Node 端）
cd apollo-cli-runtime && node --experimental-strip-types --test test/repl.test.ts

# host（A4-ACC-01 修復前，需在無 APOLLO_KERNEL_DENO 之環境執行才可能全綠）
cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/ipython-provisioner.test.ts test/suite/prompt-gate-repl-doctrine.test.ts test/ipython-bootstrap.test.ts test/suite/regressions/4428-remove-legacy-pi-mono-tools.test.ts

# runtime（Deno 端，目視 ready 幀）
cd /home/ck/apollo-cli && APOLLO_KERNEL_OWNER_PID=$$ /home/ck/.deno/bin/deno run -A --unstable-kv --unstable-node-globals apollo-cli-runtime/src/rlm/mod.ts
# 預期首幀：{"event":"ready","protocol":3,"runtime":"deno",...,"deno":"..."}（無 python 欄位）
```

## 通過條件

1. A4-ACC-01 修復（AC-24 雙環境自含），A4-ACC-02 修復（8 個失敗啟動用例改指真實失敗模式；override 語意與註解一致）
2. A4-ACC-03 二進位邊界處理（assets 補附或明確門禁 + 文件）
3. A4-ACC-04 文件五節改寫；A4-ACC-05 殘留字串清理（或逐條明文標記延後）
4. A4-ACC-06～10 逐條實作或於計劃文件標記延後/修正引用
5. A4-ACC-11 提交範圍確認（`bash.ts` 歸屬、無關文件剔除）
6. 複驗命令全綠（Node + Deno 雙端）
