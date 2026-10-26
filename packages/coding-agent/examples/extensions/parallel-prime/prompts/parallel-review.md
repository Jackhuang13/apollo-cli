---
description: Parallel rlm subagent review of current work
argument-hint: "[autofix] [review target or focus]"
---
<!-- Source: adapted from pi-subagents (MIT, nicopreme) prompts/parallel-review.md; delegation rewritten for Prime Agent native rlm.spawn. -->

對目前工作做對抗性並行 review。你(父 session)是仲裁者與最終決定者。
Reviewer 以 fresh context 執行:沒有你的對話史,因此每份 brief 必須自含。

## 1. 角度

每個 reviewer 一個獨立角度。用戶指定的角度優先;否則從用戶意圖、計畫、
已實作代碼與目前 diff 動態生成。預設 2 個(上限 3;本地模型並發瓶頸,
「2 個強的優於 3 個弱的」)。

以下為範例,不是固定預設:
1. 正確性與回歸:是否滿足需求、保留既有行為、處理邊界案例、無隱藏 runtime 失敗。
2. 測試與驗證:測試層級對不對、assertion 有意義嗎、驗證命令夠不夠。
3. 簡潔與可維護:多餘複雜度、重複結構、single-use wrapper、脆弱抽象、冗贅。

依工作類型加或換角度:
- TypeScript 重:類型安全、source-of-truth types、casts、錯誤邊界紀律
- UI 重:UX、可及性、文案、視覺品質
- 安全敏感:不安全輸入/輸出處理、auth 邊界、隱私、資料暴露
- 文件重:清晰度、準確性、完整性、讀者流暢度
- 大型多檔:可加第四人看結構摩擦、模組邊界、可測試性(需用戶明確同意)

## 2. Review 目標

把本次 invocation 的引數(本模板最末一行)當作主要 review 範圍。
若含 URL、issue 連結、檔案路徑、計畫路徑或 freeform focus:先讀取/抓取
該目標,再定角度,並把目標明寫進每份 brief。
若無引數:review 目前未提交的變更(`git status` + `git diff`)或最近一次 commit。

## 3. 啟動(每個角度一個 child;同一 IScript cell 內 spawn 後立即結束回合,不要 await 完成)

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

    const a = await rlm.spawn("<brief A>", "review-<角度A>")
    const b = await rlm.spawn("<brief B>", "review-<角度B>")

每份 brief 固定骨架(填滿空白後再 spawn):

    你是 <角度> reviewer。唯讀:不得修改任何檔案。
    Repo 絕對路徑:<path>。Review 目標:<檔案/diff 範圍/目標摘要>。
    不依賴任何先前對話:直接從檔案與命令檢查 repo、相關指令文件與目前 diff。
    你的角度:<角度清單>。
    回傳:簡潔、有證據的 findings——每條附 檔案:行號 + 建議修法。
    以證據過濾,不以嚴重度過濾:finding 必須具體且時下成立,有來源證據、
    測試/repro 或契約矛盾支持。diff review 時,問題必須由該 diff 造成或使其可達。
    分級 P0/P1/P2(P0 擋合併、P1 發布前必修、P2 僅回報)。
    結尾必須只寫一行:Merge verdict: BLOCK / OK / OK with notes 之一。
    若無任何 qualified finding,只回:No issues found.
    超過半頁的細節寫入 <artifact-dir>/review-<角度>.md,訊息只放摘要+路徑。
    回報方式:await agent_message.send(<摘要>, { receiver_role: "parent" })

Reviewer 執行期間,你可以自己做狹隘檢查(若有用)。

## 4. 彙總(收齊全部回報後)

彙整為三類:
- 現在值得修的
- 可選改善
- 忽略或遞延的回饋(附短理由)

不盲從任何 reviewer 建議。
第一次 review 不做「blockers only」——該措辭只限:P1/P2 已建庫存後的最終
pre-merge 複查,或明確的緊急 hotfix lane。
針對單一 finding 的後續 review,只問三件事:該 finding 是否已解決、
fix 是否在 fix blast radius 內引入新缺陷、先前 P1/P2 備註是否仍成立。

## 5. 下一步

若 invocation 含精確字 `autofix`:它是流程控制,不是 review 範圍——定目標
前先把該詞剔除。彙總後直接套用「現在值得修的」並驗證、總結;除非用戶明確
要求,不動可選改善;若沒有值得現在修的,就不編輯任何檔案。
否則:套用修改前先問用戶(除非用戶已表示要處理 review 回饋)。問的時候結尾
附緊湊編號選單:

    Reply with [1], [2] or further instructions:
    [1] 只套用現在值得修的。
    [2] 套用現在值得修的 + 可選改善。

本次 invocation 的額外 review 目標或重點:

$@
