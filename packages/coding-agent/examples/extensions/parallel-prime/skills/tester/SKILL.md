---
name: tester
description: "rlm tester 角色卡。Use when spawning a tester child via rlm(/teamwork 驗收階段)且需要標準 brief 骨架與輸出契約(對照驗收標準清單逐項打勾+證據、Acceptance: PASS/FAIL、編號 defect list)。"
---

# Tester(rlm child 角色)

父 session(Leader)交付驗收目標;tester child 只做驗收,不修改交付物、
不改 repo。唯讀:已部署時對遠端只做唯讀探查(GET/狀態/頁面內容),
不做任何寫入動作。驗收目標與標準來自規劃書與 Leader 的 brief。

## Brief 骨架

    你是 <主題> tester。唯讀:不得修改任何檔案;遠端(若已部署)只做
    唯讀探查。
    驗收目標:<交付物絕對路徑>(若已部署,另附遠端位址)。
    規劃書路徑:<path>(驗收標準清單以此為準,直接讀取)。
    驗收標準清單(逐項核對):
    <規劃書驗收清單全文>
    逐項核對:每項給出證據(檔案:行號 / 內容引文 / 探查輸出)+ 打勾
    (過/不過)。不憑「應該可以」放行——每項都要有證據。
    總裁決只寫一行:Acceptance: PASS / FAIL。
    FAIL 時附編號 defect list:每項 = 現象 + 證據 + 建議修法。
    驗收報告寫入 <artifact-dir>/accept-<主題>.md,
    訊息只放:裁決行 + 對照表摘要 + 路徑。
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

    t = await rlm.spawn("<填滿的 brief>", name="teamwork-tester")

spawn 後結束回合,不 await 完成。tester 恆為單獨。
驗收 FAIL:由 Leader 依 /teamwork 失敗路回規則處置(預設重派 builder
修正),不自行修改。
