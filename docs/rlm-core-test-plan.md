# rlm 核心功能測試計劃（TS runtime, apollo-cli-runtime）

目標：驗證 TS rlm runtime 的**實際**核心功能完整與可用（非 unit mock），涵蓋 kernel 啟動、
rlm API 全表面、bash、harness、mcp、snapshot/restore、interrupt，以及真實遞迴 agent 路徑。
層級由低到高，前一層全綠才進入下一層。

臨時/產物目錄：/system-prompt（不可寫時 fallback：/home/ck/system-prompt）

---

## L0 — 環境與啟動（5 min，手動腳本）

| ID | 項目 | 操作 | 通過標準 |
|---|---|---|---|
| L0-1 | Node 版本 | `node --version` | >= 22.8.0 |
| L0-2 | 啟動即 ready | `node --experimental-strip-types apollo-cli-runtime/src/rlm/mod.ts`，讀 stdout 第一行 | `{event:"ready",protocol:3}` 在 5s 內出現 |
| L0-3 | unit 基線 | `cd apollo-cli-runtime && npm test` | 24/24 pass |
| L0-4 | 套件回歸 | `cd packages/coding-agent && npx vitest run test/suite/kernel-host-request-round-trip.test.ts` | pass |

## L1 — 真實 runtime × fake host（NDJSON 驅動，可 CI）

沿用 test/suite/kernel-host-request-round-trip.test.ts 的 RuntimeHost 模式：spawn 真實
mod.ts 子程，測試端扮演 host。全部以 kernel cell（execute 框架）內執行 rlm 調用。

### rlm API 表面
| ID | 場景 | 操作 | 通過標準 |
|---|---|---|---|
| L1-01 | spawn 正常 | cell 內 `await rlm.spawn({prompt:"hi",name:"w1"})` | host 收到 host_request type=rlm.run, kwargs={name}；fake 回 spawn handle；cell result 含 rlm_child_id |
| L1-02 | spawn 客戶端驗證 | 無 name / 空 prompt / 帶 timeout | 分別抛對應錯誤，host **收不到**請求 |
| L1-03 | create_session | name/model/thinking/cwd | wire type=rlm.create_session，cwd 進入 kwargs |
| L1-04 | list_subagents / find_models | fake 回多筆 | cell 拿到陣列；空 payload（無 subagents 鍵）回 [] 不抛 |
| L1-05 | collect 快照 | timeout_ms=0，fake 回未 settled | 回 snapshot、不阻塞 |
| L1-06 | progress_note | 正常 / 513 字 / throttle 回應 | 正常accepted=true；超长抛錯；throttle 回 retry_after_ms |
| L1-07 | delete_subagent | 字串 / handle | wire target 正確 |
| L1-08 | host 錯誤傳播 | host 回 status=error | cell 收 error 事件（RuntimeError 訊息），kernel 存活 |
| L1-09 | rlm.run 改名護欄 | cell 觸碰 rlm.run | 收到改名錯誤訊息 |

### bash（真實子程）
| ID | 場景 | 通過標準 |
|---|---|---|
| L1-10 | 基本 | echo 輸出+exit 0+duration |
| L1-11 | 非零 exit | exit 42 捕獲 |
| L1-12 | 大輸出 | 產生 10MB；output() 含 head+tail 與 dropped marker，kernel 不死 |
| L1-13 | timeout | bash sleep 60 timeout=2 → 約 2s 後 kill，exit 非 0 |
| L1-14 | kill 升級 | sleep 10 + trap TERM ignore → SIGKILL 生效 |
| L1-15 | 背景完成通知 | 未 await 的 bg bash 完成 → host 收 bash.completed 事件 + display activity（active true→false）；cell 讀結果後 bash.consumed |
| L1-16 | 跨 cell 持續 | cell A 建 handle，cell B 讀 output/await | 變量與子程都存活 |

### 其他
| ID | 場景 | 通過標準 |
|---|---|---|
| L1-17 | view | 讀檔含行號；目錄列表；不存在→錯誤 |
| L1-18 | harness | cell 內 harness.create_memory/get/overview（設 local state dir env）；global_ 分流正確 |
| L1-19 | mcp NotEnabled | 無憑證 server 調用 → NotEnabled 訊息（含 /mcp login 提示） |
| L1-20 | mcp host bridge | fake host 答 mcp.list_tools/mcp.call_tool → McpIntegration 方法可用、_parse_result 解包（is_error→McpToolError） |
| L1-21 | emit/display | cell 內 emit({mime:...}) → host 收 display 事件 |
| L1-22 | snapshot/restore | 設 global→snapshot→清 global→restore→值回來；manifest saved/skipped 正確 |
| L1-23 | interrupt | cell 跑 30s 循環→發 interrupt → error/done 事件，kernel 存活、後續 cell 正常 |
| L1-24 | 惡意輸入 | 巨深嵌套 JSON、重複 in-flight id | reader 不死，protocol error 事件 |
| L1-25 | shutdown | 發 shutdown → 子程退出 0、live bash handles 被殺（orphan journal 有 false 記錄） |

## L2 — 真實遞迴 agent（foux provider, packages/coding-agent/test/suite）

用 harness.ts + faux provider 起**真** agent session（host 為真 coding-agent host，
rlm.run 由真 session 管理器處理），不用 mock host。

| ID | 場景 | 通過標準 |
|---|---|---|
| L2-01 | spawn→子 agent 真跑 | 父 cell rlm.spawn({prompt, name}) → 子 session 建立並執行 faux 任務；父 list_subagents 見 running→completed |
| L2-02 | 子回覆 | 子用 agent_message 回 parent → 父 collect 見 answer_preview / replied_since_task=true |
| L2-03 | collect 等待 | timeout_ms>0 阻塞至 settled；timeout 到回 snapshot 不報錯 |
| L2-04 | progress_note 到 parent | 子發 note → 父 list_subagents 快照見 progress_note（含 throttle 行為） |
| L2-05 | delete_subagent | 删除後不再出現在 list；再 collect 該 target 報錯/空 |
| L2-06 | 名字唯一性 | 同 sibling 重複 name → spawn 失敗 |
| L2-07 | model/thinking 傳遞 | find_models 選型 → 子 session 使用該 model（foux 斷言） |
| L2-08 | 父 kernel 重啟恢復 | 父 kernel restore 後 list_subagents 仍見 retained 子 | 

## L3 — 真實 TUI / CLI 冒煙（tmux，手動或半自動）

依 AGENTS.md 的 tmux 流程，真實二進位/source 啟動：
1. `tmux new-session -d -s rlm-e2e -x 120 -y 30`，啟動 apollo CLI。
2. 輸入提示讓 agent 在 iscript 工具內跑 `rlm.spawn` + 後續 collect。
3. capture-pane 驗證：roster 顯示子 agent、完成通知注入、父回覆。
4. 驗證 TUI 的 bash activity 顯示與完成 follow-up。
通過標準：全流程無 crash、狀態顯示正確、會話可繼續。

## L4 — 穩健性 / 混沌（抽樣執行）

| ID | 場景 | 通過標準 |
|---|---|---|
| L4-01 | kernel 被 kill -9（bg bash 運行中） | orphan journal 有記錄、host 可 reap、無永久孤兒 |
| L4-02 | host 斷線 | pending host_request 全 reject，kernel 退出，無掛起 |
| L4-03 | 並發 spawn x5 | 全部 admission、id 唯一、collect 全數 |
| L4-04 | 長時間 cell 中 snapshot | snapshot 完成、cell 後續正常 |
| L4-05 | 大 snapshot（>16MB 單變量） | 該變量 prune 進 manifest，restore 後缺失有提示 |

## L5 — PY parity 抽驗（可選，TS single-track 收尾）

以 L1 同一 fake-host 驅動腳本改跑 PY runtime（PRIME_AGENT_KERNEL_PYTHON 指向 uv venv），
逐條比對 L1-01..L1-25 的行為差異；預期差異僅上次審計列出的：view/timeout/is_active/
回傳形狀/snapshot magic。產出：差異對照表，標記「已知差異」vs「新發現 bug」。

---

---

## 實作狀態（L0–L2 已完成）

### L1 — 已落實：packages/coding-agent/test/suite/rlm-core-l1.test.ts（commit cbe09b2）

15 個用例全綠（種子 1/7/7/42/99 重複通過，npm run check exit 0）。
L1Host 驅動 spawn 真實 apollo-cli-runtime/src/rlm/mod.ts 子程（node --experimental-strip-types），
測試端只扮演 NDJSON host。計劃 ID 與實作對應：

實際 15 個用例（test 標題即計劃 ID）：

| 實作 test | 覆蓋計劃 ID | 備註 |
|---|---|---|
| L1-09 | L1-02/L1-09 | run 改名護欄 + spawn 無 name 驗證在客戶端抛出，host 收不到請求 |
| L1-17 | L1-17 | view 行號/目錄/缺檔錯誤 |
| L1-18 | — | rlm.is_active 在 cell 執行期間為 true |
| L1-12 | L1-12 | >3.5MB 輸出 head/tail 保留 + dropped marker |
| L1-13 | L1-13 | timeout 殺長命令，非零 exit |
| L1-14 | L1-14 | trap TERM ignore → SIGKILL 升級（exit 128） |
| L1-16 | L1-16 | bash handle 與子程跨 cell 存活 |
| L1-18h | L1-18 | cell 內 harness state 持久化 + overview |
| L1-19 | L1-08/L1-19 | 實作修正：call_tool 無本地 NotEnabled 檢查，改斷言 host error 經 bridge 傳播 |
| L1-20 | L1-20 | MCP list_tools/call_tool host bridge round-trip |
| L1-21 | L1-21 | emit display 事件含 active cell id |
| L1-22 | L1-22 | snapshot/restore；成功幀是 done+saved[]（snapshot_complete 只用於空路徑錯誤路徑） |
| L1-23 | L1-23 | interrupt：以 emit 幀作為 cell 啟動信號再發 interrupt，KeyboardInterrupt + kernel 存活 |
| L1-24 | L1-24 | 惡意 stdin（非 JSON、深嵌套）reader 不死 |
| L1-25 | L1-25 | shutdown exit 0 + live bash 被殺；存活檢查用 ps 命令身份（PID 重用下 kill(pid,0) 不可靠） |

計劃中未單獨落 L1 的項（L1-01/03/04/05/06/07 的 wire 形狀、L1-10/11 基本 bash、L1-15 背景完成通知）
由 apollo-cli-runtime/test/ 的 unit 層（subagent.test.ts、bash.test.ts 等，24/24）與
packages/coding-agent 的 kernel-host-request-round-trip.test.ts 覆蓋；L1 聚焦真實子程可觀察行為。

### L2 — 已落實：packages/coding-agent/test/suite/rlm-core-l2.test.ts（commit 69d171d）

7 個用例全綠（種子 1/7/42/99 通過，npm run check exit 0）。
createHarness（foux provider，不傳 options.tools）+ 私有 _ipythonKernelProvisioner 取真 KernelClient，
client.execute 跑 rlm.spawn，完成信號一律 await collectRlmChildren（settlement deferred，不用輪詢）。

| 計劃 ID | 實作 | 備註 |
|---|---|---|
| L2-01 | L2-01 | spawn→done、answer_preview、model 傳播（子 session model.id 斷言） |
| L2-02 | （未實作，已記錄） | inline 子 session 不帶 agentMessageController，child→parent agent_message 不屬於 inline 真實路徑；改由 L2-04 progress_note 覆蓋「子→父可觀察信號」 |
| L2-03 | L2-03 | collect 對全部直接子回 typed 快照（順序 spawn 避免 foux 隊列競態） |
| L2-04 | L2-02 | 子發 rlm.progress_note → 父 listRlmSubagents 快照見 progress_note |
| L2-05 | L2-05 | delete 後 roster 不再見該子 |
| L2-06 | L2-04 | 重複 sibling name 在 admission 被拒（execute 回 error） |
| L2-07 | L2-01 | model 傳遞併入 L2-01 斷言 |
| L2-08 | L2-07 | 修正：provisioner 為一次性（dispose 後 re-ensure 立即 abort），改斷言 roster 在父 kernel dispose 後仍存活（生命周期歸 host session） |

額外覆蓋：L2-06（實作）rlm.spawn 只向 host 轉發 name/model/thinking（timeout kwarg → "remove unsupported options"）。

### 關鍵約束（寫入持續 memory rlm-ts-test-plan-progress）
- check:test-policy 禁止 per-test {timeout}（explicit-test-timeout）與 vi.waitFor（wall-clock-poll）；
  完成等待一律用 collectRlmChildren 的 settlement deferred。
- KernelClient 型別出自 core/kernel/shared.js（iscript.js 只再導出 provisioner）。
- foux response 按 provider 排隊、被任意 session 消耗；多子場景需順序 spawn 或精確排響應。

## 執行順序與退出標準

1. L0 → L1（L1 是主體，建議落實成 vitest 檔 test/suite/rlm-core-*.test.ts，fake host 可重現）
2. L2（真遞迴，foux only，零 token 成本）
3. L3（每次發布前手動一次）
4. L4 抽樣 + L5 一次
退出標準：L0-L2 全綠；L3 無 crash；L4 無孤兒進程/無掛起；L5 差異表無「新發現 bug」。

## 注意事項（repo 規則）
- CI 測試 unconditional、port 0、temp path 唯一、finally 清理、無 sleep 當 ready 信號
  （ready 握手用事件等待+失敗邊界 timeout，附 test-policy 註解）。
- 不改 prime-agent 主碼來配合測試；縫合點只允许既有 _set* 風格的最小注入。
- 測試行數不超過對應 source 行數；回归測試放既有 suite 檔。
