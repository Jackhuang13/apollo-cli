# TS RLM 對齊 Py RLM 改造計劃與實作規範

本文檔定義將 TS RLM（`apollo-cli-runtime` 與 `packages/coding-agent`）對齊 Python RLM（`prime-agent-runtime`）的四項核心改造計劃，目標在於讓 TS 版 Agent 擺脫「過度依賴 Bash Wrapper」的行為模式，回歸以 TypeScript/JavaScript 為主編排語言（Orchestration Language）的狀態運算與推理本質。

---

## 改造方向與具體設計

### 1. 調整 Prompt 引導策略（Prompt Alignment）
* **現狀問題**：
  TS Prompt 中包含突兀的強警告：
  `CRITICAL TOOL CALLING RULE: You only have the iscript tool available. There is NO standalone bash tool... To run shell commands, you MUST call the iscript tool and execute await bash('your command').`
  此段引導導致模型過度將 REPL 當作執行 Bash 指令的入口。
* **修改方案**（`packages/coding-agent/src/core/prompts/rlm.ts`）：
  1. 移除該大寫警告區塊。
  2. 恢復 Py 原版的敘述，強調「TypeScript 是編排語言（loops, conditionals, parsing, state），`bash()` 僅用於啟動外部進程」。
  3. 明確告知預裝套件列表與全域 Helper，提示模型優先使用原生腳本進行檔案與資料處理。

---

### 2. 對齊預裝高階工具庫與 Helper（Ecosystem & Convenience Alignment）
* **現狀問題**：
  Python RLM 預先提供了 12 個高階資料/科學/網路套件，並內建極簡檔案讀取能力；TS RLM 先前缺乏這些生態庫，且 Node 原生 fs 非同步操作繁瑣。
* **對齊清單**：
  在 `apollo-cli-runtime` 引入對應純 JS/ESM 相容套件並暴露在全域：
  - `yaml`（對齊 `pyyaml`）
  - `cheerio`（對齊 `beautifulsoup4`）
  - `zod`（對齊 `pydantic`）
  - `dotenv`（對齊 `python-dotenv`）
  - `fast-xml-parser`（對齊 `lxml`）
  - `smol-toml`（對齊 `tomli`）
  - 內建 `fetch` / `http` 輔助封裝（對齊 `requests` / `httpx`）
* **注入全域檔案 Helper**（在 `mod.ts` 或 global 中）：
  - `read(path, encoding?)`：快速讀取文字檔案。
  - `write(path, data)`：快速寫入文字或物件。
  - `glob(pattern)`：目錄與檔案模式匹配。

---

### 3. 對齊 Skill 呼叫合約（Callable Skills Contract）
* **現狀問題**：
  Py RLM 的 Skill 可被直接作為全域函式呼叫（如 `await edit(...)`），而 TS 版主要偏向 CLI 參數解析 `runCli`。
* **修改方案**（`apollo-cli-runtime/src/rlm/skill.ts` 與 `iscript.ts`）：
  - 在 bootstrap 注入 installed skills 時，使用 Proxy 包裝，確保無論模組的導出是 default、具名或 `.run`，均可直接被 `await <skillName>(...)` 呼叫。
  - 在 Prompt 中聲明 `Installed skills are callable directly: await <skillName>(...)`。

---

### 4. 參數簽名與解構優化（Ergonomics Alignment）
* **現狀問題**：
  TS 版先前的 RLM API 僅接受單一物件選項 `{ prompt, name }`，模型若傳入位置參數（例如 `await rlm.spawn("task", "worker")` 或 `await rlm.spawn("task", { name: "worker" })`）會拋錯。
* **修改方案**（`apollo-cli-runtime/src/rlm/mod.ts`）：
  - `rlm.spawn(promptOrOptions, nameOrOptions?)` 支援字串與物件雙重型別多載。
  - `rlm.create_session(promptOrOptions, nameOrOptions?)` 同步支援雙重型別。
  - `rlm.collect(targets, timeoutOrOptions?)` 支援數字 timeout_ms 或 options 物件。
  - `snake_case` 與 `camelCase` 屬性全相容。

---

## 執行與驗證步驟
1. 實作 `apollo-cli-runtime/src/rlm/mod.ts` 參數多載與 Helper 導出。
2. 更新單元測試 `apollo-cli-runtime/test/` 驗證位置參數與物件參數均通過。
3. 更新 `packages/coding-agent/src/core/prompts/rlm.ts` 引導 Prompt。
4. 跑完整 `npm run check` 與 test suite 確保相容性與無回歸。
