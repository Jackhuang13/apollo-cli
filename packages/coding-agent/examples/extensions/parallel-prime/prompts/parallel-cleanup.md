---
description: Parallel rlm cleanup review (deslop + verbosity)
argument-hint: "[autofix] [scope or focus]"
---
<!-- Source: adapted from pi-subagents (MIT, nicopreme) prompts/parallel-cleanup.md; delegation rewritten for Prime Agent native rlm.spawn. -->

對目前工作做 fresh context 並行清理 review。你(父 session)是仲裁者與最終決定者。
Reviewer 以 fresh context 執行:沒有你的對話史,因此每份 brief 必須自含。

## 1. 清理範圍

把本次 invocation 的引數(本模板最末一行)當作主要清理範圍。若含 URL、檔案
路徑或 diff 範圍,先讀取再分配 brief。若無引數:清理未提交變更
(`git status` + `git diff`)或最近一次 commit。

## 2. 啟動(2 個固定角度、2 個 child;同一 IScript cell 內 spawn 後立即結束回合,不要 await 完成)

Artifact 目錄(spawn 前先在父 kernel 執行一次;`art` 以字面值填進每份 brief 的
`<artifact-dir>`——child 拿到字面絕對路徑,child 端零計算):

    import fs from "node:fs"; import path from "node:path";
    const st = rlm.get_harness_state();
    const art = st && st.file_path
      ? path.dirname(path.dirname(st.file_path))
      : (() => { const log = "<你 system prompt 的 Conversation log 路徑,逐字抄>";
                 return path.join(path.dirname(path.dirname(log)), "session-artifacts",
                                  path.basename(log).replace(/\.jsonl$/, "")); })();
    fs.mkdirSync(art, { recursive: true });
    if (!fs.statSync(art).isDirectory()) throw new Error("artifact dir invalid: " + art);

IScript REPL:

    const a = await rlm.spawn("<brief deslop>", "cleanup-deslop")
    const b = await rlm.spawn("<brief verbosity>", "cleanup-verbosity")

每份 brief 公共骨架:

    你是 <deslop|verbosity> 清理 reviewer。唯讀:不得修改 repo 內任何檔案。
    Repo 絕對路徑:<path>。清理目標:<檔案/diff 範圍>。
    不依賴任何先前對話:直接從檔案與命令檢查。
    你的角度:<以下對應清單>。
    回傳:簡潔、有證據的 findings——每條附 檔案:行號 + 最小安全修法。
    分級 P0/P1/P2(P0 擋合併、P1 發布前必修、P2 僅回報)。
    結尾必須只寫一行:Merge verdict: BLOCK / OK / OK with notes 之一。
    若無任何 qualified finding,只回:No issues found.
    超過半頁的細節寫入 <artifact-dir>/review-<角度>.md,訊息只放摘要+路徑。
    回報方式:await agent_message.send(<摘要>, { receiver_role: "parent" })

角度 1(deslop):找 AI-slop 模式:
- 重述代碼的註釋、占位文字、stale 理由、debug 殘留
- 掩蓋有用錯誤的防禦性檢查、回傳模糊預設值、對已過真實邊界的受信內部資料做重複驗證
- 類型逃逸、broad cast、重複類型定義、object-bag typing
- 與鄰近非-slop 代碼及專案指令的風格漂移
- 生成感的文件、changelog 文字、UI 文案、狀態文字、測試名
- pass-through wrapper、死 helper、不強制任何 invariant 的抽象
把掃描輸出當線索不當裁決:只報有證據、有 檔案:行號 的具體問題。

角度 2(verbosity):找多餘冗贅(代碼、測試、文件、狀態文字、changelog):
- 只改寫一個表達式的 single-use helper
- 只給明顯表達式命名的暫存變數
- 可以變直接 return 而不丟失意圖的巢狀 return/分支
- 可用既有本地 fixture 或小型本地 helper 取代的重複 boilerplate
- 重述已在更便宜層級覆蓋的 formatter 細節的測試
- 把同一件事說兩次、口吻空泛、或把重要規則埋掉的行文
「更短比較好」僅在更清晰且保留行為、錯誤訊號、清理語義與本地風格時成立。

Reviewer 執行期間,你可以自己做狹隘檢查(若有用)。

## 3. 彙總(收齊全部回報後)

彙整為三類:
- 現在值得清的
- 可選改善
- 忽略或遞延的回饋(附短理由)

不盲從任何 reviewer 建議。

## 4. 下一步

若 invocation 含精確字 autofix:它是流程控制,不是清理範圍——定目標前先把
該詞剔除。彙總後只套用「現在值得清的」並驗證、總結;除非用戶明確要求,
不動可選改善;若沒有,就不編輯任何檔案。
否則:套用前先問用戶(除非用戶已表示要處理清理回饋)。問的時候結尾附:

    Reply with [1], [2] or further instructions:
    [1] 只套用現在值得清的。
    [2] 套用現在值得清的 + 可選改善。

本次 invocation 的額外範圍或重點:

$@
