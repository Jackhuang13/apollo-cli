---
description: Parallel rlm subagent research (grounded answer)
argument-hint: "<question or decision> [angles...]"
---
<!-- Source: adapted from pi-subagents (MIT, nicopreme) prompts/parallel-research.md; delegation rewritten for Prime Agent native rlm.spawn. -->

對目前的問題/決策做並行研究,建構有證據的回答。你(父 session)框定問題與
分配角度;child 只做研究或探勘,不發明大計畫。
Research child 以 fresh context 執行:沒有你的對話史,因此每份 brief 必須自含。

## 1. 角度

預設 2 個(問題廣泛時 3;上限 3;本地模型並發瓶頸)。用戶明確指定的角度優先。

1. 外部證據:現行權威來源——官方文件、spec、release notes、benchmark、
   issue threads、一手解釋。
2. 本地代碼脈絡:repo 中相關檔案、既有 pattern、約束、測試、
   會被影響的檔案(brief 必須給 repo 絕對路徑)。
3. 實務權衡:選項比較、風險、邊界案例、維護成本、什麼最易驗證。

依問題類型適配:
- 函式庫/API 題:官方文件 + 近期範例
- 架構決策:本地模組邊界、依賴方向、遷移成本
- Debug 題:可能失效模式、本地呼叫路徑、精確錯誤證據
- UI/產品題:使用者流、可及性、設計先例、實作約束
- 時效性主題:近期動態角度,偏好 2026/2025 來源

## 2. 啟動(每個角度一個 child;同一 IScript cell 內 spawn 後立即結束回合,不要 await 完成)

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

    const a = await rlm.spawn("<brief A>", "research-<角度A>")
    const b = await rlm.spawn("<brief B>", "research-<角度B>")

每份 brief 固定骨架(填滿空白後再 spawn):

    你是 <角度> researcher。唯讀:不得修改任何檔案、不得實作。
    問題:<把問題完整寫入,自含,不依賴對話史>。
    Repo 絕對路徑(若涉本地範圍):<path>。
    直接檢查來源,不憑記憶或先前對話。
    你的角度:<角度描述>。
    回傳簡潔 findings(附證據):
    - 本地 findings:檔案路徑 + 行號範圍
    - 外部 findings:來源連結
    - 信心度與缺口
    - 建議的下一步或決策意涵
    (涉本地系統時,brief 也要附關鍵拓撲參數:port、上游位址、服務名——child 不知道本機拓撲。)
    超過半頁的材料寫入 <artifact-dir>/research-<角度>.md,訊息只放摘要+路徑。
    回報方式:await agent_message.send(<摘要>, { receiver_role: "parent" })

## 3. 彙總(收齊全部回報後)

彙整回答為五段:
- 我們知道什麼
- 本地代碼暗示什麼
- 權衡與風險
- 缺口與假設
- 建議的下一步

Findings 互相矛盾時,點出矛盾,不抹平。
本模板僅為研究 pass:除非用戶明確要求,不做任何實作。

本次 invocation 的問題或決策:

$@
