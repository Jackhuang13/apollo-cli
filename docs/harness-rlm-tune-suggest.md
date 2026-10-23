# HarnessState 與 RLM 機制改善建議與實施計劃

- 依據文件：`docs/harness-rlm-gap-review.md`
- 產出日期：2026-10-23
- 適用模組：`apollo-cli-runtime`（Kernel / REPL / Bash / Harness）與 `packages/coding-agent`（Agent Session / Refinement / Subagent）

---

## 一、 事實評估與現況核實（Fact & Root Cause Analysis）

針對 `docs/harness-rlm-gap-review.md` 所列之各項缺陷，結合程式碼實測核實如下：

### 1. Kernel Hand-rolled Lexing 層（P0）
- **事實核實**：
  - 現行 `apollo-cli-runtime/src/rlm/repl.ts` 採用正則表達式及自建逐字元狀態機（`_lexCodeRegion`, `_codeMask`, `_splitTopLevelStatements`）。
  - 近期 commit（如 `b6e5112`, `0232aaa` 及當前未提交變更）持續在 hand-rolled scanner 上疊加修補（如字串/註解遮罩、換行 ASI 模擬、除法跨行判定）。
  - 自建 lexer 難以窮舉 ECMAScript 複雜語法（如 template literal 內嵌表達式、動態 import 物件鏈、標籤函式、regex literal 邊界等），且無法精準判定頂層變數宣告，導致 `globalThis` 改寫容易外溢到字串或落盤檔案中。
- **評估結論**：**完全屬實**。長遠必須引入確定性的 AST/TypeScript Compiler API 進行轉換，徹底取代脆弱的 regex scanner。

### 2. bash() 過程監督：無 Timeout 上界、無子孫程序可見性（P0）
- **事實核實**：
  - `apollo-cli-runtime/src/rlm/bash.ts` 中，`BashOptions.timeout` 是可選參數；若呼叫端未指定，則無超時保護（`this._timeoutTimer` 為空），長時間阻塞會卡死 session。
  - 當前程序以 `spawn(shell, ["-c", script], { detached: IS_POSIX })` 啟動，`this._pid` 僅為該 shell process。子程序衍生出之 grandchild 程序對 runtime 完全不可見。
  - 終止程序時依賴 `signalGroup(pid, "SIGKILL")`；若 shell 已死亡或未正確設定 process group，子孫程序將成為孤兒，外部排查時易誤判甚至誤殺 session kernel。
- **評估結論**：**完全屬實**。缺乏預設防禦上限與子行程樹可視性。

### 3. Restored State 清單未驗證（P1）
- **事實核實**：
  - `apollo-cli-runtime/src/rlm/repl.ts` 的 `handleRestore()` 讀取 snapshot 時，僅做 `v8.deserialize()`；若成功則直接 `g[name] = value` 並 `restored.push(name)`。
  - 但是：`v8.serialize` 不支援 function 與 symbol。在 snapshot 建立時（`handleSnapshot()`），任何含 function 的物件（或 function 本身）均被 skipped。
  - 當 session 重啟時，模型收到 `[python-state-restored]` 訊息（由 `agent-session.ts` 送出），宣稱變數已恢復；但如果先前模型定義了含函式的模組或 helper，在 restore 後可能為 `undefined` 或殘缺物件，且未經二次可用性驗證。
- **評估結論**：**完全屬實**。宣告已恢復（restored）但缺乏型別與可用性驗證（verification probe）。

### 4. auto-refine 記錄敘事而非驗證過的事實（P1）
- **事實核實**：
  - `packages/coding-agent/src/core/refinement/refinement.ts` 中，`reviewAutoRefine()` 與 `planRefinement()` 將最後幾輪對話文本（截取長度達 40K~80K 字元）送交 LLM。
  - 若模型在某輪執行了錯誤 probe（如語法錯誤測試或猜測性敘述），而後續剛好觸發 auto-refine，LLM 容易將模型發言中的「假說/錯誤推論」當作已確立的事實寫入 memory。
  - 目前 harness entry 缺乏 `observed`（工具/命令實際輸出檢驗）與 `inferred`（模型主觀推論）之分類標籤，亦無主動校驗機制。
- **評估結論**：**完全屬實**。缺乏知識來源分級與修正更新（superseded）的生命週期機制。

### 5. Memory 無負空間、無淘汰（P2）
- **事實核實**：
  - `HarnessState.entries.memory` 採用 key-value 存儲，只增不減（除非模型主動呼叫 delete）。
  - 對於「已驗證不適用 / 應忽略之項目（如死備份目錄、失效 API）」，缺乏顯式的「負向約束（negative space）」機制。
  - 缺乏基於存取/命中頻率（usage count/TTL）的降級或淘汰機制，隨對話增長會無限制膨脹 context 與 prompt token 成本。
- **評估結論**：**完全屬實**。需要負向標記與使用率追蹤統計。

### 6. 子 agent 結果契約是軟性的（P2）
- **事實核實**：
  - RLM 子 agent 在建立後（admission）父端即返回；子 agent 是否完成、結果如何，完全依賴其是否主動發送 `agent_message` 或寫入特定檔案。
  - 父 agent 在呼叫 `rlm.collect()` 時，若子 agent 尚未完成或中途失敗，缺乏結構化契約（typed contract / exit status）；對於序列性偵錯（sequential debugging），過多的檔案往返反增認知負擔。
- **評估結論**：**完全屬實**。應加強狀態機與結構化結果回傳機制。

### 7. 次要問題（P3）
- **7.1 Kernel 單一全域上下文**：所有 cell 共享同一個 `globalThis`，若執行過程污染變數或留下 stray timer 無法隔離。
- **7.2 Ready 協定欄位誤導**：`repl.ts` 在 `ready` 事件中仍回傳 `deno: denoVersion`、`python: denoVersion`，與真實環境矛盾。
- **7.3 測試行數預算與測試效能**：測試套件在無 build dist 時執行易爆，且 real subprocess 測試較慢。
- **評估結論**：屬實，屬於清理與工程品質強化項目。

---

## 二、 各階段可行性評估（Feasibility Assessment）

| 階段 | 項目 | 技術可行性 | 影響範圍 | 風險程度 | 實施考量 |
|---|---|---|---|---|---|
| **Phase 1 (P0)** | **1. Kernel AST 轉換** | **高** | `apollo-cli-runtime` | 中 | 以 TypeScript Compiler API (`ts.transform`) 取代手工 regex 與字串改寫；需確保效能不顯著下降（parse cell 只需毫秒級）。 |
| **Phase 1 (P0)** | **2. bash() 監督與超時防護** | **高** | `apollo-cli-runtime/src/rlm/bash.ts` | 低 | 設定合理的預設超時（例如 10 分鐘上限或可設定預設值）；透過 Linux `/proc` 或 `pstree`/`pgrep` 追蹤 process group 與樹狀結構；定時發出進度 heartbeat。 |
| **Phase 2 (P1)** | **3. Restore 狀態探測與驗證** | **高** | `repl.ts` & `agent-session.ts` | 低 | 在 `handleRestore` 注入完成後，對注入的變數進行 `typeof` 與基本完整性快檢，排除無效或非預期型別，回傳真實 verified 清單。 |
| **Phase 2 (P1)** | **4. Auto-refine 知識分級** | **中高** | `packages/coding-agent/src/core/refinement` | 中 | 在 `HarnessEntry` 新增 `source_type: "observed" \| "inferred"`；更新 prompt 指引，要求 LLM 僅將「有實測輸出佐證」之事實列為高可信記憶，推論應標註假說。 |
| **Phase 3 (P2)** | **5. Memory 負向標籤與淘汰機制** | **中** | `harness.ts` & `agent-session.ts` | 低 | 支援負向標籤（如 `negative: true` 代表該路徑/方法已被驗證無效勿再嘗試）；新增 access count / last accessed 時間戳，供 prompt digest 做動態挑選與淘汰。 |
| **Phase 3 (P2)** | **6. 子 Agent 結構化契約** | **中** | `packages/coding-agent` & `rlm-runtime.ts` | 中 | 規範 subagent 結束時必填的結構化結果（status, return value, error）；父端 `rlm.collect()` 提供更明確的超時與狀態辨識。 |
| **Phase 4 (P3)** | **7. 次要問題與協議清理** | **高** | `repl.ts`, 測試套件 | 低 | 修正 `ready` 事件欄位（移除混淆的 `python`/`deno` 欄位或精準標記為 node）；優化測試套件與 pre-requisite build 檢查。 |

---

## 三、 實施計劃（Implementation Roadmap）

### 階段一：穩定核心執行環境（P0）

#### 1.1 以 TypeScript Compiler API 重構 Kernel Lexing / Rewriter
- **目標**：徹底消除 `_codeMask` 與手寫 regex 引起的語法改寫漏洞（A2/A3 類缺陷）。
- **作法**：
  1. 在 `apollo-cli-runtime` 引入 TypeScript Compiler API（或輕量 AST 剖析工具如 `@babel/parser` / `oxc-parser`）。
  2. 重構 `_transformTopLevelImports`：透過 AST 節點遍歷（`ts.visitEachChild`），精確辨識 `import` 宣告、動態 `import()` 表達式與字面量，保留原本字串與註解內容，安全改寫為 `globalThis.__apollo_import__`。
  3. 重構 `_splitTopLevelStatements`：利用 AST 頂層 Statement 邊界切分，取代手工 ASI 模擬。
  4. 加入針對動態 import 物件鏈、跨行運算子、正規表達式結尾等全面回歸測試。

#### 1.2 bash() 強化過程監督與程序樹可視性
- **目標**：防止無上限卡死，並避免排查孤兒程序時誤殺 Kernel。
- **作法**：
  1. **預設超時機制**：提供系統級預設超時（如 600 秒），長跑任務需顯式指定 `timeout: null` 或自訂秒數。
  2. **程序群組與子孫追蹤**：
     - 在 Linux/macOS 下使用 process group（`process.kill(-pid, signal)`）。
     - 提供輔助方法（如 `handle.tree()` 或 `handle.descendants()`），利用 `/proc` 讀取目前 shell 的子行程樹（PID、名稱、狀態）。
  3. **Kernel 自保標識**：在 session kernel 與子行程中注入專屬環境變數（如 `APOLLO_SESSION_KERNEL_PID`），避免 ps 誤殺自己。
  4. **長任務 Heartbeat**：對於執行超過一定時間的指令，定時產生進度日誌或事件通知。

---

### 階段二：狀態可信度與自動記憶校準（P1）

#### 2.1 核心狀態 Restore 驗證機制
- **目標**：確保重啟後通報給模型的變數清單真實可用。
- **作法**：
  1. 在 `handleRestore` 完成反序列化後，遍歷 `restored` 清單，檢查 `g[name] !== undefined` 且基本屬性正常。
  2. 區分可序列化資料與不可序列化函式；若模組需要重載，明確在通知中提示重新 `import`。
  3. 產出 `verified: string[]` 與 `unverified: string[]`，在 `[python-state-restored]` prompt 中如實呈現。

#### 2.2 Auto-refine 記憶機制事實化
- **目標**：避免將暫時性的錯誤試探（broken probe）當作永久事實記憶。
- **作法**：
  1. **資料模型擴充**：在 `HarnessEntry` 增加 `status: "verified" | "hypothetical"` 或 `source_type: "observed" | "inferred"`。
  2. **Prompt 調優**：修正 `reviewAutoRefine` 與 `planRefinement` 的 system prompt，嚴格要求：
     - 只有包含實際命令執行成功輸出者，才能列為 `verified` memory。
     - 若後續對話修正了先前的錯誤結論，必須將舊 memory 設為 `superseded` 或執行 `delete`，禁止重複累積相左敘述。

---

### 階段三：認知架構優化與多 Agent 契約（P2）

#### 3.1 支援負空間與 Memory 淘汰（TTL / Access Tracking）
- **目標**：避免無效資訊累積，降低上下文污染與 token 浪費。
- **作法**：
  1. **負向記憶（Negative Knowledge）**：支援如 `[excluded]` 或 `[invalidated]` 標記，例如記錄「目錄 `/foo/bar` 為無效備份，不需搜索」，使模型下次讀取時能直接跳過。
  2. **存取統計**：在 `HarnessState` 中為每筆 entry 記錄 `hit_count` 與 `last_accessed_at`。
  3. **動態 Digest 淘汰**：在組裝 system prompt 的 `formatHarnessStateForPrompt` 時，依命中頻率與時間排序，優先注入高頻重要記憶，超出預算者降級忽略。

#### 3.2 子 Agent 結果結構化契約
- **目標**：解決 sequential debugging 中 spawn 子 agent 結果不明確、檔案往返繁瑣的問題。
- **作法**：
  1. 定義標準結果格式（Exit code, summary, structured outputs）。
  2. `rlm.collect()` 增加支援超時等待與主動 polling 機制，並能明確區分「運行中」、「已成功」、「意外退出（無回報）」。
  3. 針對深度耦合的單工作階段，提供更輕量的同進程隔離執行方式（如 `vm.createContext` 沙箱），降低跨 Agent 通訊成本。

---

### 階段四：協定清理與測試體質健全（P3）

#### 4.1 協定與命名清理
- **作法**：
  1. 清理 `repl.ts` 內 `ready` 事件的遺留欄位（移除或將 `deno` 欄位精準修正為 `node`），避免外部工具或模型產生混淆。
  2. 統一內部溝通字串，減少在 node 核心中殘留的 python/deno 混用痕跡。

#### 4.2 測試基礎設施與預算落實
- **作法**：
  1. 確保 `apollo-cli-runtime` 測試具備自動前置構建檢查，防止在未編譯環境下執行直接報紅。
  2. 優化 Subprocess 測試的啟動與回收耗時，確保測試穩定且符合專案測試行數規範。

---

## 四、 驗證與交付標準

1. **功能測試**：
   - 針對多行語法、動態 import 物件鏈執行 unit test，確認在 AST 轉換下不再發生 `SyntaxError` 或外溢。
   - 針對 `bash()` 逾時中斷、孤兒行程終止進行邊界測試。
   - 驗證 Restore 流程能正確過濾未成功載入的符號。
2. **回歸驗證**：
   - 執行 `npm run check` 與指定測試套件，確保所有型別與規格皆無 error / warning。
   - 於 live session 中驗證 auto-refine 生成之 memory，確認無幻覺或錯誤推論固化。
3. **文件同步**：
   - 實作完成後將相關架構變更補充至各模組文件與變更紀錄。
