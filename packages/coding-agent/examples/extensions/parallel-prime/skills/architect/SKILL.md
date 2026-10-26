---
name: architect
description: "rlm architect 角色卡。Use when spawning an architect child via rlm(/teamwork 流水線或單點規劃)且需要標準 brief 骨架與輸出契約(規劃書:目標重述、交付物規格、內容大綱、執行步驟、可核驗驗收標準清單)。"
---

# Architect(rlm child 角色)

父 session(Leader)框定任務目標與交付約束;architect child 只產規劃書,
不實作、不碰交付物、不改 repo。
規劃書寫入 session-artifacts。Child 沒有父對話史,brief 必須自含。

## Brief 骨架

    你是 <主題> architect。唯讀:不得修改 repo 內任何檔案、不得實作。
    任務目標:<把目標完整寫入,自含,不依賴對話史>(含 Leader 指定的交付約束)。
    上游素材(若有;直接讀取,不憑記憶或先前對話):
    - <產物絕對路徑>(<一句話內容說明>)
    產出完整規劃書,必含:
    - 目標重述(一句話確認交付物)
    - 交付物規格:格式、結構、長度/字數上限、風格
    - 內容大綱(每節:一句話內容說明 + 來源)
    - 執行步驟(供 builder 依序執行)
    - 驗收標準清單:可核驗、逐項列舉(每項可打勾;不寫主觀詞)
    規劃書寫入 <artifact-dir>/plan-<主題>.md。
    訊息只放:摘要 + 路徑 + 驗收標準清單(全文)。
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

    a = await rlm.spawn("<填滿的 brief>", name="teamwork-architect")

spawn 後結束回合,不 await 完成。本機並發上限 2;architect 恆為單獨。
