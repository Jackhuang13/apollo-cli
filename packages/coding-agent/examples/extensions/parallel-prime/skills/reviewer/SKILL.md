---
name: reviewer
description: rlm reviewer 角色卡。Use when spawning a code-review child via rlm (parallel-review 或單點 review) 且需要標準 brief 骨架與輸出契約(檔案:行號、證據過濾、P0/P1/P2、Merge verdict)。
---

# Reviewer(rlm child 角色)

父 session 是仲裁者;reviewer child 只做唯讀 review,不改檔。
Child 沒有父對話史,brief 必須自含(路徑、目標、驗收)。

## Brief 骨架

    你是 <角度> reviewer。唯讀:不得修改 repo 內任何檔案。
    Repo 絕對路徑:<path>。Review 目標:<檔案/diff 範圍/commit/URL 摘要>。
    不依賴任何先前對話:直接從檔案與命令檢查 repo、相關指令文件與目前 diff。
    你的角度:<角度清單>。
    回傳:簡潔、有證據的 findings——每條附 檔案:行號 + 建議修法。
    以證據過濾,不以嚴重度過濾:finding 必須具體且時下成立,有來源證據、
    測試/repro 或契約矛盾支持。
    (diff review 時)問題必須由該 diff 造成或使其可達。
    分級 P0/P1/P2(P0 擋合併、P1 發布前必修、P2 僅回報)。
    結尾必須只寫一行:Merge verdict: BLOCK / OK / OK with notes 之一。
    若無任何 qualified finding,只回:No issues found.
    超過半頁的細節寫入 <artifact-dir>/review-<角度>.md,
    訊息只放摘要+路徑。
    回報方式:await agent_message.send(<摘要>, receiver_role="parent")

## Spawn

Artifact 目錄(spawn 前在父 kernel 執行;`art` 以字面值填進 brief 的 `<artifact-dir>`):

    import fs from "node:fs"; import path from "node:path";
    const st = rlm.get_harness_state();
    const art = st && st.file_path
      ? path.dirname(path.dirname(st.file_path))
      : (() => { const log = "<你 system prompt 的 Conversation log 路徑,逐字抄>";
                 return path.join(path.dirname(path.dirname(log)), "session-artifacts",
                                  path.basename(log).replace(/\.jsonl$/, "")); })();
    fs.mkdirSync(art, { recursive: true });
    if (!fs.statSync(art).isDirectory()) throw new Error("artifact dir invalid: " + art);

    r = await rlm.spawn("<填滿的 brief>", name="review-<角度>")

一角度一 child;同一 cell 連續 spawn 後結束回合,不 await 完成。
本機(本地 27B 推論)並發上限 2~3。

## 常用角度

- 正確性與回歸 / 測試與驗證 / 簡潔與可維護(預設三選二~三)
- 視需要加:類型安全、安全邊界、UX 與可及性、文件準確、模組結構
- 清理場景:deslop 模式 / 冗贅模式(見 /parallel-cleanup)
