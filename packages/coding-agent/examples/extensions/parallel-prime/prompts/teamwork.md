---
description: Sequential rlm subagent pipeline (research -> plan -> build -> [deploy] -> test)
argument-hint: "<task goal> [local | remote:<env> | skip-research]"
---
<!-- 本套件原創模板(無 pi-subagents 藍本);編排紀律(brief 骨架、session-artifacts、agent_message 回報、spawn 後結束回合)與同套件 pi-subagents 衍生模板(MIT, nicopreme)一致。 -->

對請求的任務跑父編排的順序流水線。你(父 session)是 Leader(規劃、填
brief、spawn、失敗路回、最終回報)與 Observer(收回報、驗證產物、向用戶
回報);child 只做單一角色任務,不得自行 spawn child,不得自管鏈路。
Child 以 fresh context 執行:fresh spawn 的 child 沒有你的對話史,brief 必
須自含;continue 的 child 保留原有上下文(見 §2 continue/spawn 裁量)。

## 1. 階段與跳過規則

固定鏈:Researcher(+Scout 選用)→ Architect → Builder → [DevOps] → Tester。

1. 研究(選用;唯一併行點;≤2 child;全唯讀):
   - 需線上素材:spawn researcher(本機 websearch/Serper 未設定,用
     felo skill;時效性主題偏好 2026/2025 來源)。
   - 需本機素材:可另 spawn scout 併行(讀 repo;brief 必附 repo 絕對路徑)。
   - 不需研究:跳過(invocation 明寫 skip-research,或 Leader 判定)。
2. Architect(單獨、唯讀):收全部研究產物路徑,產出完整規劃書;spawn architect child。
3. Builder(單獨;唯一本地寫角色):依規劃書產交付物;本地唯一寫入點為
   <artifact-dir>(父 session 的 artifact 目錄;recipe 見 §2「Artifact 目錄」)。
4. DevOps(條件式;單獨;唯一遠端副作用 child):僅當需發佈遠端時出現。
   spawn 前 Leader 必須已向用戶取得目標環境、動作範圍、回滾方式的確認,
   並明寫於 brief。佈署方式未知:Leader 先 spawn researcher 做唯讀佈署
   調察,再把調察結果交 devops。child 之間不可委派:「devops 轉
   researcher」一律由 Leader 居中。
5. Tester(單獨、唯讀):對照規劃書驗收標準清單逐項驗收;已部署時另做
   遠端唯讀探查。

併行與深度紀律:
- 任一時刻至多 2 個 child;唯一併行點 = researcher + scout(皆唯讀)。
- 實作型 child(builder、devops)永不並行;architect、tester 單獨。
- 深度 1:child 不可扇出;一切 spawn 由 Leader 執行。
- 唯讀聲明無 runtime 強制,靠 brief;Leader 最終回報前必複核產物路徑。

控制詞(來自 invocation):
- local:強制跳過 devops(交付物只留本地)。
- remote:<env>:宣告部署目標(spawn devops 前仍需用戶確認)。
- skip-research:跳過研究階段(直接從 architect 起;上游素材 = 目標文字)。

## 2. 啟動(一階段一 child;同一 IScript cell 內 spawn 後立即結束回合,不要 await 完成)

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

每份 brief 固定骨架(填滿空白後再 spawn):

    你是 <角色>。<讀寫聲明:唯讀 / 唯一寫入點>。
    任務目標:<把目標完整寫入,自含,不依賴對話史>。
    上游產物(直接讀取,不憑記憶或先前對話):
    - <產物絕對路徑>(<一句話內容說明>)
    本階段驗收標準:<可核驗、逐項列舉>。
    長材料(超過半頁)寫入 <artifact-dir>/<階段>-<主題>.md,
    訊息只放摘要+路徑。
    回報方式:await agent_message.send(<摘要>, { receiver_role: "parent" })

角色專有重點(與本套件同名角色卡一致):
- researcher / scout:唯讀;findings 附證據(本地:檔案:行號;外部:來源
  連結);信心度與缺口。
- architect:規劃書必含目標重述、交付物規格、內容大綱、執行步驟、可核驗
  驗收標準清單(每項可打勾;不寫主觀詞)。
- builder:本地唯一寫入點 = session-artifacts;修正輪可修改規劃書(記錄
  改動);回報 = 交付物路徑 + 逐項對照驗收清單自檢 + 偏差與缺口。
- devops:授權邊界明寫於 brief(目標環境、允許/禁止動作、回滾方式);回報
  = 部署結果 + 驗證證據 + 回滾記錄 + 部署記錄路徑;超出授權邊界 = 回報
  卡點,不動作。
- tester:逐項:打勾(過/不過)+ 證據;總裁決只一行 Acceptance:
  PASS / FAIL;FAIL 時附編號 defect list(現象 + 證據 + 建議修法)。

IScript REPL:

    // 研究階段(選用;唯一併行點;≤2;同 cell spawn 後結束回合):
    const a = await rlm.spawn("<brief researcher>", "teamwork-research")
    const b = await rlm.spawn("<brief scout>", "teamwork-scout")
    // 之後每階段各一個 cell:先驗證上一階段產物路徑,填進 brief 再 spawn:
    const c = await rlm.spawn("<brief architect>", "teamwork-architect")
    const d = await rlm.spawn("<brief builder>", "teamwork-builder")
    const e = await rlm.spawn("<brief devops>", "teamwork-devops")   // 僅需遠端發佈時
    const f = await rlm.spawn("<brief tester>", "teamwork-tester")


每階段回報以 agent_message 普通訊息到達:收到後驗證其聲稱的產物路徑,
填下一階段 brief 並 spawn,再結束回合。不要阻塞等待 child 完成。

Continue vs fresh spawn(Leader 裁量;completed child 會保留在 registry,
可用 `await agent_message.send(<訊息>, { receiver_role: "child",
receiver_name: "<child 名>" })` 繼續對話,同 session、保留全部先前上下文、免
冷啟動):
- **continue 同一 child**(限階段內 follow-up):
  - 向 child 追問它自己工作的細節(實作理由、依據、邊界);
  - 同一交付物的小修/補件(目標不變、不跨驗收邊界);
  - 回報後 Leader 發現缺資料,一問可補的。
- **fresh spawn**(階段交接的預設):
  - 換角色或換目標(architect→builder 等);
  - 失敗路回修正輪(見 §3):**永不 continue 原產出 defect 的 child**——
    修正輪若繼承原 child「我這樣寫是對的」記憶,易超範圍修(T3 實測:
    窄 brief + fresh context → 修正 diff 只 1 行)。
- **continue 上限**:同一 child 階段內 continue ≤3 回合;超過、child 回報
  顯示上下文膨脹(每輪明顯變慢/回報膨脹)、或請求已等同新目標 → 轉
  fresh spawn,按標準 brief 骨架重新交接(上游產物一律傳路徑)。
- **命名**:continue 的 child 保留原名;同角色 fresh spawn 加後綴
  (-fix1、-r1 等)以便區分。

## 3. 失敗路回(Leader 裁決;無獨立除錯角色)

觸發:builder 產出錯誤/不完整、tester 驗收 FAIL(附 defect list)、
devops 部署失敗。Leader 分類並路回:
- 實作層:重派 builder(fresh spawn,**不得 continue 原 builder**):brief = 目標 + 規劃書路徑 +
  defect list/錯誤記錄全文;builder 有權在修正輪內調整規劃書。
- 規劃層(方向性錯誤):重派 architect 修規劃書 → builder 重做。
- 部署層且原因不明:先 spawn researcher(唯讀佈署調察)→ 結果交新 devops。
每階段最多 3 輪修正(用戶指定上限優先);超限:停止,向用戶回報卡點、
現狀與選項(繼續/換方向/中止)。

## 4. 最終回報(全鏈完成後)

回報前,驗證所有聲稱的產物路徑確實可讀。向用戶的最終回報為五段:
- 交付物:絕對路徑 + 一句話說明
- 驗收結論:裁決 + Tester 逐項對照表(路徑)
- 部署結果(若有):目標、驗證證據、回滾方式
- 缺口與假設
- 建議的下一步

## 5. 下一步

最終回報後結束。除非用戶要求修正,不主動啟動新流水線;修正要求走第 3
節路回(從對應階段起)。

本次 invocation 的額外目標、控制詞(local / remote:<env> / skip-research)或修正輪數:

$@
