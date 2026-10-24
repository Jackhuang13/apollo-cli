# Phase 3.5 Spike: 同進程輕量沙箱架構探索（In-process Lightweight Sandbox Spike）

- 日期：2026-10-24
- 關聯計劃：[`docs/harness-rlm-tune-suggest-phase3-plan.md`](file:///home/ck/apollo-cli/docs/harness-rlm-tune-suggest-phase3-plan.md) (Track D / 工作項 3.4.1)

---

## 1. 背景與痛點 (Problem Statement)
目前 RLM 在分派子任務（`rlm.spawn`）時，每個子 agent 皆作為獨立完整的 `AgentSession` 運行，背後配置獨立的通訊管道與 kernel/runtime。
- **優勢**：強隔離性，適合長任務、複雜探索或高破壞性行為。
- **痛點**：對於「單次純函數計算」、「臨時檔案格式轉換」或「短期探針試探（Probe）」等輕量任務，完整的 session admission、file descriptor 開銷與 context tree 構建帶來明顯的延遲（通常約 100ms ~ 300ms）與額外記憶體負擔。

## 2. 候選同進程隔離方案評估

| 方案 | 隔離機制 | 啟動延遲 | 記憶體開銷 | 安全性與崩潰防護 | 適用性結論 |
|---|---|---|---|---|---|
| **Node.js 原生 `node:vm` (`createContext`)** | V8 Context 隔離 | 極低 (< 1ms) | 極低 (~數 KB) | ⚠️ 無法抵禦惡意 Prototype 逃逸，但可隔離全域變數污染與計時器 | **推薦用於內部純計算與輕量試探** |
| **`isolated-vm`** | 獨立 V8 Isolate | 低 (~5ms) | 低 (~數 MB) | ✅ 記憶體硬上限防護、完全隔離、防逃逸 | **可作為未來高安全要求的進階沙箱** |
| **Worker Threads (`node:worker_threads`)** | 線程級隔離 | 中 (~20ms) | 中 (~10-20MB) | ✅ 可透過 `terminate()` 強制回收，支援非同步 I/O | **適合有阻塞風險的 CPU 密集子任務** |

## 3. 建議之架構整合演進路徑

1. **輕量執行協定 (Lightweight Task Protocol)**：
   在 `rlm.spawn` 支援 `isolated: "in_process"` 參數：
   ```ts
   const result = await rlm.spawn("compute_hash", {
     isolated: "in_process",
     code: "return crypto.createHash('sha256').update(input).digest('hex')",
     inputs: { input: "hello" }
   });
   ```
2. **安全邊界防護**：
   - 封鎖危險全域對象（如 `process.exit`, `child_process`）。
   - 設定 execution timeout（利用 `node:vm` 的 `timeout` 參數防止死循環）。
3. **無縫向後相容**：
   - 輕量任務產出的結果結構完全遵照 Phase 3 定義之 `RlmStructuredResult`。
