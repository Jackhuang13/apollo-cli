# HarnessState 與 RLM 改善 — Phase 1 P0 1.2 驗收方 Todolist

- 角色:驗收方(P0 1.2 驗收 session,2026-10-23)
- 驗收對象:commit `db131e4`(見 `docs/harness-rlm-tune-suggest-phase1-p0-1.2-issues.md`)
- 結論:**FAIL**。本表為修復後再驗收之工作清單;項目 1/2 為再驗收前置條件,3/4/5 可隨批處理或後補,6 為文件同步。
- 驗收基線:1.2「應完成事項」取自已 `docs/harness-rlm-tune-suggest.md` 1.2 節作法 1–4 與第四節「驗證與交付標準」。

## 一、 應完成事項對照表(驗收方判定)

| # | 應完成事項(規格原文要點) | 判定 | 證據 | 關聯 issue |
|---|---|---|---|---|
| 1 | 預設超時 600s(省略 `timeout` 即生效) | ✅ | 實測排程 600000ms 計時器;`DEFAULT_BASH_TIMEOUT_SECONDS=600` | — |
| 2 | 長跑任務 `timeout: null` 出口 | ✅ | 實測無限制、正常完成 | — |
| 3 | 長跑任務可自訂秒數(`timeout: <seconds>`) | ❌ | `timeout: 900` 於 0.91s 被殺(exit 128);>600 被當成 ms | ISSUE-2 |
| 4 | Linux/macOS process group kill(`process.kill(-pid)`) | ✅ | 實測群組 kill 後 2 個 sleep 全消失、無 zombie | — |
| 5 | 輔助方法讀 `/proc` 子行程樹(PID、名稱、狀態) | ⚠️ | `descendants()` 有 pid/ppid/comm,**缺 state 欄位** | ISSUE-3 |
| 6 | session kernel 與子行程注入自保 env(`APOLLO_SESSION_KERNEL_PID`) | ✅ | kernel 自身 + 子行程 env 實測正確;含 orphan journal 雙重保護 | — |
| 7 | 長任務 heartbeat(定時進度日誌或事件通知) | ❌ | 事件被 host 判為未知協議 → **kernel 被殺重建**(實地事故 14:32:21) | ISSUE-1 |
| 8 | 功能測試:`bash()` 逾時中斷、孤兒行程終止邊界測試 | ⚠️ | `bash.test.ts` 5/5 綠,但**無** timeout 單位契約、heartbeat、`timeout: null` 測試 | ISSUE-2/5 |
| 9 | 回歸驗證:`npm run check` 無 error/warning | ✅ | 唯讀等效:biome / test-policy / tsgo ×2 全 exit 0 | — |
| 10 | 文件同步:架構變更補入模組文件與變更紀錄 | ⚠️ | prompt(`rlm.ts`)已同步;協議事件層未同步(heartbeat 根本不在協議內) | ISSUE-1 |
| 11 | (額外發現,不在規格)kernel 死亡後巢層 bash 子行程回收 | ⚠️ | 事故實例:sleep 34 孤兒 ~7s + stale journal 記錄殘留 | ISSUE-4 |

## 二、 工作項清單(TODO)

| # | 狀態 | 優先級 | 對應項目 | 對應 issue | 工作項 | 驗收標準(驗收方複核) |
|---|---|---|---|---|---|---|
| W-1 | ☑ 完成 | **P0(再驗收前置)** | 項目 7、8、10 | ISSUE-1 | 修復 `bash_heartbeat` 協議衝突: 採方案 B 暫止發射(全面盤點確保僅發射 PROTOCOL_EVENT_KINDS 內之合法事件)，待協議能力協商擴充後再啟用 | 移除 `bash_heartbeat` 定時器避免觸發 `failProtocolFrame`，存活 >30s handle 穩定運行無 host frame failure；全盤點 sendRawEvent 符合協議契約 |
| W-2 | ☑ 完成 | **P1(再驗收前置)** | 項目 3、8 | ISSUE-2 | `timeout` 一律以秒解讀(浮點秒 → ms),移除 `<=600` 斷崖;prompt 與文件一致；保留 `timeout: null` 與 `0` 不排程計時器 | 新測試: 斷言 `timeout: 900` 排程 900,000ms；`timeout: null` 與 `0` 為 null；`bash.test.ts` 全綠 |
| W-3 | ☑ 完成 | Minor | 項目 5 | ISSUE-3 | `descendants()` 解析 `/proc/<pid>/stat` 補 `state` 欄位;以最後閉括號 `)` 切分防 comm 錯位;Windows 回傳 `[]` | 測試斷言 state 欄位存在且值符合 `/^[RSDZTW]$/` 合法集合 |
| W-4 | ☐ 待做 | Minor | 項目 11 | ISSUE-4 | kernel 死亡回收遞迴匹配巢層 kernelPid,或 host 定期以 startId 對帳清理 stale `active=true` 記錄 | kernel 死亡後其巢狀 kernel 的 bash 子行程被回收;journal 無殘留 active 記錄(對 incident journal 1133754 複核) |
| W-5 | ☐ 待做 | Minor | 項目 8 | ISSUE-5 | heartbeat 間隔常數化 + 可注入(測試 hook);隨 W-1 補 host 端消費者 | 測試可在秒級內斷言 heartbeat 事件產出與 handle 結束時清理 |
| W-6 | ☑ 完成 | 文件 | 項目 10 | ISSUE-1 | 文件同步:`harness-rlm-tune-suggest-phase1-todo.md` 更新 1.2 狀態(現稱 9/9 完成,與驗收結果不符);本 issue 報告與 todolist 掛入該文件 | 文件狀態與驗收結論一致;無殘留「已完成」誤導 |

## 三、 再驗收流程

1. 重跑回歸門:`bash.test.ts` + 唯讀等效 `npm run check`(biome 不加 `--write`、`check:test-policy`、tsgo root、tsgo runtime)。
2. W-1 若選方案 A,另依 AGENTS.md daemon-protocol 規則複核 capability gate 與雙向 compat 測試。
3. 全部通過後,更新本表狀態並將 issue 報告結論改為 PASS。

> 實測產物:沙箱 probe 結果 `/tmp/apollo-acceptance-results.jsonl`(probes A–F)、回歸門日誌 `/tmp/apollo-gate.log`、事故 journal `~/.apollo/agent/daemon-workers/a9d8b9ee737a/db116a083330.orphans.jsonl`。
