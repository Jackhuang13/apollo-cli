# IScript REPL 內部機制開放問題 — 模型側不可見機制

- 來源：2026-10-25 13:00 (local) 後 session 日誌分析（01a17196 / 01a1718e / 01a1719b / 01a171ac / 01a171e7 / 01a171ee / 01a171f9 / 01a171ff）＋ 分析 agent 對自身 kernel（Deno 2.1.9，session 01a1729f）的唯讀自省
- 日期：2026-10-25
- 性質：非驗收缺陷，而是模型在 cell 內無法自我觀察的 runtime 機制問題；每項附證據與建議解法方向
- 狀態：全部 open

| 編號 | 主題 | 優先 | 狀態 |
|---|---|---|---|
| OQ-01 | 狀態 revival 的內容邊界 | Major | open |
| OQ-02 | Node/Deno 雙 runtime 差異矩陣與錯誤訊息 | Major | open |
| OQ-03 | Kernel 重啟的重試預算 | Minor | open |
| OQ-04 | __apollo_import__ proxy 的解析規則與內省 | Major | open |
| OQ-05 | compaction 對 kernel 變量的影響與通知 | Minor | open |

---

## OQ-01 狀態 revival 的內容邊界

**問題**：kernel 重啟後的 "best-effort revival" 快照到底包含什麼？頂層變量、函式/類別定義、pending promise、bash handle 分別如何處理？doctrine 所述 16 MiB 是單變量上限——總快照有上限嗎？哪些東西重啟後保證會丟？

**證據**：
- [python-state-restored] custom message（01a171f9，2026-10-25T08:33:12Z）：「Your kernel state was revived from your previous session. These names have been verified and are re...」——模型只能看到變量名清單，看不到序列化機制
- [python-state]（01a171f9，08:37:58Z、09:03:16Z）：「Your Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available」
- 模型側完全無法預測跨 turn 變量的存活與否，只能用了才知道

**建議方向**：在 docs（iscript-kernel.md 之類）明列快照語意表（變量/函式/類別/promise/handle 各行為）、上限值與超限時的事件；或讓 revival 事件帶 schema 化明細（哪些名字成功、哪些被丟、原因碼）。

---

## OQ-02 Node/Deno 雙 runtime 差異矩陣與錯誤訊息

**問題**：同一 cell 落在 Node 或 Deno runtime 行為不同，且 tool 層錯誤訊息不標註這是 runtime 差異。需要一份已知 compat 差異清單（或測試矩陣）；ready payload 已報 runtime，但 boot crash 與 cell 錯誤應能提示「本 kernel runtime 為 X，該 API 在 X 下行為不同」。

**證據**（2026-10-25 13:00 後，皆為真實撞擊）：
- Deno 下 Buffer 非 global：ReferenceError: Buffer is not defined（src/rlm/bash.ts:10，01a171ee 15:21 local ×3 boot crash）
- Deno 下 timer 無 .unref()：TypeError: timer.unref is not a function（_startParentWatchdog，01a171f9 15:32 local ×3 boot crash；另於 16:55 由 vitest 經 dist build 複現）
- 分析 agent 自身 kernel（Deno 2.1.9）即時自省：
  1. cell 內 TS as cast → SyntaxError: Unexpected identifier 'as'（cell 走 node:vm new Script，Deno vm compat 不做 type stripping；系統提示稱 "TypeScript REPL"，實際 JS only）
  2. node:child_process.promises namespace 為 undefined（Node 有）
  3. node:child_process/promises 子路徑為 Unknown built-in module（Node 有；__apollo_import__ 於 repl.ts:1575 拋 TypeError）

**建議方向**：(a) 維護 runtime 差異表並入 iscript-kernel.md；(b) _knownFailureHint 對 runtime 差異類錯誤（Buffer/timer/promises/TS 語法）加 hint，含「本 kernel runtime = deno 2.1.9」；(c) 決定 cell 是否先經 type stripping（esbuild/swc/ts-blank-space）再入 vm——若是設計決策（JS only），應同步修正 doctrine 文案；(d) 雙 runtime 的 boot 冒煙矩陣列入 CI（Buffer、timer.unref、child_process 子路徑、TS 語法各一格）。

---

## OQ-03 Kernel 重啟的重試預算

**問題**：Kernel exited before ready 後，下次 tool 調用即重啟 kernel——連續崩潰會重試幾次？有 backoff 嗎？崩潰迴圈會不會把整個 turn 卡死？目前觀察到的行為是模型自費改道（撞 N 次後換方法），不是系統保護。

**證據**：
- 01a171e7（15:12–15:13 local）：spawn /home/ck/.deno/bin/deno ENOENT 連撞 5 次（deno 二進位 15:17 才安裝到位）
- 01a171f9（15:32 local）：timer.unref boot crash ×3，連 1+1 都失敗
- 期間無系統層重試/降級訊息，全部以 isError tool result 逐次回給模型

**建議方向**：明確重試預算（如 N 次同因失敗後停止重啟、回帶聚合錯誤與建議）；boot 失敗訊息標註失敗階段（spawn / ready 握手 / bootstrap）與 runtime，便於模型一次改道。

---

## OQ-04 __apollo_import__ proxy 的解析規則與內省

**問題**：B 類 51 次 skill 匯入失敗即 proxy 解析 bare specifier 失敗。修好後（01a171f9 17:11 local changelog：skills importable as bare globals; default-export skills are callable as bare globals while named imports keep working）：bare globals fallback 的優先序？與 pre-installed 清單（yaml/zod/undici/dotenv/toml/xml/math/pandas）的邊界？bare global 與 cell 頂層變量撞名時誰贏？模型能在 kernel 內列出 proxy 目前解析得了什麼嗎？

**證據**：
- Node kernel：Cannot find package 'agent_message' imported from .../dist/apollo-cli-runtime/src/rlm/repl.ts（01a17196 13:44、01a1719b 13:50，各 17/17 skill）
- Deno kernel：Import "agent_message" not a dependency and not in import map from file:///.../dist/.../repl.ts（01a171ac 14:08，17/17 skill）
- proxy 存在於 stack：async globalThis.__apollo_import__ (repl.ts:1575)

**建議方向**：提供 rlm（或 __apollo__）內省入口列出已註冊 bare specifiers 與 skill globals；文件化解析優先序；撞名語意明確（建議：顯式 import 恆贏，並給 hint）。

---

## OQ-05 compaction 對 kernel 變量的影響與通知

**問題**：[python-state] 稱 compaction 後 kernel persist，doctrine 又稱序列化 >16 MiB 的變量會被移除——移除時有無事件/通知？被移除變量之後 access 是 undefined 還是 ReferenceError？模型無法區分「我沒定義過」與「被 compaction 清掉」，會直接產生錯誤推理。

**證據**：
- [python-state] custom message（01a171f9，08:37:58Z、09:03:16Z）緊接 compaction 事件，僅稱 remaining variables... still available，未列被移除項
- 系統提示（doctrine）：Compaction removes individual variables whose serialized form exceeds 16 MiB——無對應 kernel 事件可驗證

**建議方向**：compaction 觸發的變量移除發出 [python-state-removed]（或等價事件）列名與原因；移除後 access 拋帶原因的 ReferenceError（如 variable "x" was removed during compaction (18.2 MiB > 16 MiB)）而非靜默 undefined。

---

## 附錄：分析時自身 kernel 的即時發現（2026-10-25，session 01a1729f，Deno 2.1.9）

| # | 發現 | 影響 |
|---|---|---|
| 1 | cell 內 TS as cast → SyntaxError（node:vm 不做 type stripping） | doctrine 稱 TypeScript REPL，實際 JS only；模型會反覆撞同一 SyntaxError |
| 2 | node:child_process.promises undefined；node:child_process/promises unknown module | Node 慣用法在 Deno kernel 靜默失靈（undefined 而非 import 失敗），錯誤出現在調用點、遠離根因 |
| 3 | setTimeout 回傳帶 .unref() 的 object（A3 已修）；Buffer 為 global（A2 已修） | 同一路代碼在不同 kernel 版本/runtime 下行為不同，模型無從在內部查 kernel 版本 |
