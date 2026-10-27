# rlm-roles

Prime Agent 原生 rlm 子代理的並行 review/research 模板、順序 teamwork 流水線與角色卡,
委派全部走內建 `rlm.spawn`(child = 獨立 fresh-context 的 prime-agent session)。

## 內容

| 類型 | 名稱 | 用途 |
|---|---|---|
| prompt | `/parallel-review` | 2~3 個 fresh reviewer 並行對抗性 review(總數 ≤3、同時 ≤2;P0/P1/P2 + Merge verdict) |
| prompt | `/parallel-research` | 2~3 個 researcher/scout 並行(總數 ≤3、同時 ≤2)研究,五段彙總 |
| prompt | `/parallel-cleanup` | 2 個 reviewer 並行清理(deslop + verbosity) |
| prompt | `/teamwork` | 父編排順序流水線:研究→規劃→產出→[部署]→驗收;Leader/Observer 主 agent,至多 2 併行,失敗路回無獨立除錯角色 |
| skill | `reviewer` | reviewer child 角色卡(brief 骨架 + 輸出契約) |
| skill | `researcher` | researcher child 角色卡 |
| skill | `scout` | scout child 角色卡 |
| skill | `architect` | architect child 角色卡(規劃書 + 可核驗驗收標準清單) |
| skill | `builder` | builder child 角色卡(交付物;修正輪可改規劃書) |
| skill | `devops` | devops child 角色卡(唯一遠端副作用 child;授權邊界明寫於 brief) |
| skill | `tester` | tester child 角色卡(逐項驗收 + Acceptance 裁決) |

## 安裝

在 apollo-cli 倉庫根目錄執行(`--local` 為專案級安裝,預設全域):

```bash
apollo-cli package install "$(pwd)/packages/coding-agent/examples/extensions/parallel-prime"
```

等價於 `<apollo-cli 倉庫根>/packages/coding-agent/examples/extensions/parallel-prime`
的絕對路徑。相對路徑相對 cwd 解析;SDK 以相對 config 目錄的形式存檔
(~/.apollo/agent/ 或 <project>/.apollo/agent/),載入時解回絕對路徑。
安裝是引用不是複製,源目錄須保持原位;路徑不存在時 install 報錯、
載入時產生 error diagnostic。

## 使用

```
/parallel-review auth-flow
/parallel-review autofix src/api/
/parallel-research 下一步的 vector store 該選 pgvector 還是 Qdrant?
/parallel-cleanup
/teamwork 替我完成關於市場調查的簡報 local
/teamwork 產出部署 Runbook 並發佈到 wiki remote:wiki.internal
```

## 回滾

```bash
apollo-cli package remove "$(pwd)/packages/coding-agent/examples/extensions/parallel-prime"
```

## 環境注意(本部署)

並行角度型模板(review/research)總數至多 3 個 child;任一時刻至多 2 個
child 並行(teamwork 無總數上限,但同樣每次至多 2 併行);實作型 child
(worker)永不並行。

## 授權

模板編排紀律改編自 [pi-subagents](https://github.com/nicopreme/pi-subagents)
(MIT, nicopreme)的 prompt 模板;角色卡與 rlm 委派層為本套件原創。
