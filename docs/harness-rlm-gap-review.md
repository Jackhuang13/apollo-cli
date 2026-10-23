# HarnessState + RLM 機制 — 不足處檢視稿

- 日期:2026-10-23
- 來源:IScript 長除錯 session(本週 import-rewriter/splitter 修復線),各層機制在高負載下被壓力測試
- 狀態:待檢視;改善方案於檢視後擬定

## 摘要:優先級排序

| 優先級 | 缺陷 | 依據 |
|---|---|---|
| P0 | Kernel hand-rolled lexing 層(rewriter / splitter) | 復發:本週 A1、A2、A3 與 2 個連帶缺陷全部出自同一根源 |
| P0 | bash() 過程監督:無 timeout 上界、無子孫程序可見性 | 1 小時卡死 + 誤殺自己 kernel 兩起事故 |
| P1 | Restored state 清單未驗證 | 每次 kernel 重啟都可能浪費 cell、侵蝕信任 |
| P1 | auto-refine 記錄敘事而非驗證過的事實 | 錯誤 memory 會主動誤導後續 session |
| P2 | Memory 無負空間、無淘汰 | stale 事實累積;prompt 成本單向成長 |
| P2 | 子 agent 結果契約是軟性的 | 無法區分「忘了回」與「還在跑」 |
| P3 | 單全域上下文 / deno 協定欄位 / 測試預算 soft / runtime suite 慢 | 見 §7 |

## 1. Kernel hand-rolled lexing 層(P0)

觀察:
- import rewriter 與 statement splitter 都是 regex + 逐字元掃描,沒有真正的 parser。
- rewriter 掃整個 cell source,不區分 string / template 文字 / 註解 → A2:string 內的 dynamic import 文字被改寫;連帶缺陷:被改寫的內容經 writeFileSync 落盤,檔案本身不經 kernel 卻已含 globalThis.__apollo_import__ 呼叫,spawn 出去必死(本週實測確認)。
- rewriter 不保留 await 語意 → A3:dynamic import 的 member chain 變成 Promise 的 property access,呼叫 undefined。
- 保留名是白名單記憶,不是解析層約束 → 與 builtin 同名的 top-level const 永久遮蔽,無警示,只能重啟 kernel 恢復。
- 本週的修復方向(_codeMask)是「在一個 lexer 上面再寫一個 lexer」來補第一個 lexer 的錯。

影響:這類缺陷對每個新 session 都會復發;模型必須依賴 local memory 的 workaround(片段拼字)避坑——這是 model-level 記憶負擔,不是 mechanism-level 保護。

改善方向(待決):以 TS compiler API(AST transform)取代 rewriter + splitter,一次消除 A2 / A3 / 遮蔽整類;最低限度讓 rewriter 與 splitter 共用同一個 lexer。

## 2. bash() 過程監督(P0)

觀察:
- handle 沒有 timeout 上界;長跑 handle 不會主動浮現。本 session 1 小時卡死 = blocking await 一條無上界管線。
- 看不到子孫程序樹:handle.pid 只是 shell,grandchild 不可見。認孤兒要人肉 ps + PPID 推理,還用 etimes 猜錯、殺了自己的 session kernel(999560);protocol repair 恢復了但 session 中斷。
- 對 stdio / pipe 拓撲無警示(例如 stderr: inherit 會讓管線長時間保持)。

改善方向(待決):process group 追蹤 + 子孫報告;長跑 handle 的 heartbeat 浮現;timeout 可選但預設可見。

## 3. Restored state 不可信(P1)

觀察:
- kernel 被重啟後,restored 清單宣告 readFileSync 可用——實際是 undefined,浪費一格才發現。
- 宣告的綁定是 best effort、無 verify;模型只能「信任然後踩雷」。

改善方向(待決):restore 時做 typeof 探測,或明確標記 unverified。

## 4. auto-refine 記錄敘事,不是驗證過的事實(P1)

觀察:
- turn 邊界的 auto-refine 建了一筆 memory,稱某 test 檔有 SyntaxError(行號未知)——那實際是我自己 broken probe 的誤報,下一格才更正。
- 機制把模型的「最後印象」(含錯誤)直接固化成 memory;沒有 observed 與 inferred 的區分;沒有「下次命中時驗證」的迴圈。

改善方向(待決):memory 標記來源(observed / inferred);relevance 命中時做便宜驗證;更正時標記 superseded 而非靜默改寫。

## 5. Memory 無負空間、無淘汰(P2)

觀察:
- 「某 checkout 是死備份、可忽略」需要用戶親口糾正我才更新——機制不區分「驗證過已排除」與「未驗證」。
- promote / demote(local 與 global)沒有證據(命中次數、省下的 cell 數),全靠人肉判斷。
- harness digest 的 relevance ranking 不透明;token 成本隨筆數單向成長。

改善方向(待決):hit / usage 計數 + 升降層候選建議;ranking 可解釋;TTL 或淘汰政策。

## 6. 子 agent 結果契約(P2)

觀察:
- spawn 在 admission 即回;結果只能靠 child 記得送 agent_message 或寫檔。
- 忘了回 → 父端難以區分「忘了」與「還在跑」(progress_note 只是軟訊號)。
- 沒有 typed output / 檔案慣例的機制強制;「大輸出寫檔」只是教條。
- 價值缺口:對串行的、狀態緊耦合的除錯工作(如本 session),spawn 只增加檔案往返、無並行收益——機制最適的是 fan-out,但大量真實工作是 sequential debugging。

改善方向(待決):結果契約(typed output 或檔案慣例 + collect 入口);「無需回複」的顯式預設;為串行工作提供 kernel 內的隔離沙箱(見 §7.1)。

## 7. 次要問題(P3)

7.1 kernel 單全域上下文:實驗失敗(stray const 遮蔽、stray timer)污染一切;沒有 isolated eval 或狀態 time-travel。
7.2 ready 協定欄位仍回 deno 版本字串(實際是 Node runtime)——C1 只修了 model-visible 措辭,協定層仍留误导性欄位。
7.3 測試行數預算 soft:B 組超標要人肉裁決——要嘛機械強制,要嘛廢掉。
7.4 runtime 測試套件慢且 CI 脆弱:source checkout 無 dist 即紅;spawn 真 kernel 的測試每則秒級。

## 附錄:事故 → 機制缺口對照

| 事故(本 session) | 機制缺口 |
|---|---|
| 1 小時 suite 卡死 | bash handle 無 timeout 上界、無長跑訊號(§2) |
| 誤殺自己的 session kernel | 子孫程序樹不可見、無識別輔助(§2) |
| restored 清單宣告可用、實際 undefined | restore 未驗證(§3) |
| auto-refine 固化誤報 memory | 記錄敘事而非事實(§4) |
| 死備份的風險誤判 | 無負空間(§5) |
| 反覆踩 import-rewriter 陷阱、寫檔需片段拼字 | hand-rolled lexing(§1) |

—(改善方案於檢視後擬定)—
