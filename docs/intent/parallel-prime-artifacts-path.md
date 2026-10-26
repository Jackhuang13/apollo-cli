# parallel-prime session-artifacts 路徑:tree-agnostic、父 session 聚合

Status: approved (2026-10-26)。Scope: `packages/coding-agent/examples/extensions/parallel-prime`(4 prompts + 7 skill cards,16 處)。

## 背景

- 16 處硬編碼 `~/.prime/agent/session-artifacts/`。`.prime/agent` **不是失活殘留**——它是另一棵活實例/build 的 config 樹(settings.json 裝著 rlm-roles、mem0、daofy,sessions/artifacts 存在至 2026-10/20-21)。本 build `CONFIG_DIR_NAME = ".apollo/agent"`(`packages/coding-agent/src/config.ts`)。機械改名 `.prime` → `.apollo` 對另一實例指錯樹。
- SDK 正規佈局是 `<agentDir>/session-artifacts/<session-id>/`(`session-manager.ts` `getSessionArtifactsRoot`/`getSessionArtifactPath`);直接寫根層造成散檔長期積累。
- 用戶约束:LLM 運行時推導路徑(從 system prompt)不穩定;機制必須是確定性(code,非推理)。套件保持 pure prompt、零相依、零檔案交叉引用。

## Decision

**父 session**(執行模板的編排者)在 spawn 前用自己的 kernel 推導自己的 session artifact 目錄, mkdir + 驗證,以**字面絕對路徑**填入每份 child brief 的 `<artifact-dir>`;child 照抄寫入,端點零計算:

```
    import fs from "node:fs"; import path from "node:path";
    const st = rlm.get_harness_state();
    const art = st && st.file_path
      ? path.dirname(path.dirname(st.file_path))
      : (() => { const log = "<你 system prompt 的 Conversation log 路徑,逐字抄>";
                 return path.join(path.dirname(path.dirname(log)), "session-artifacts",
                                  path.basename(log).replace(/\.jsonl$/, "")); })();
    fs.mkdirSync(art, { recursive: true });
    if (!fs.statSync(art).isDirectory()) throw new Error("artifact dir invalid: " + art);
```

- 主路徑:`rlm.get_harness_state().file_path` = `<agentDir>/session-artifacts/<sid>/harness/harness_state.json`(本 session 實測,同步回傳)→ `dirname(dirname(...))` = `<agentDir>/session-artifacts/<sid>`,與 `getSessionArtifactPath` 逐字一致。
- Fallback:system prompt 的 `Conversation log: <agentDir>/sessions/<sid>.jsonl` → `join(dirname(dirname(log)), "session-artifacts", basename(log) 去 .jsonl)`。
- `mkdirSync(recursive)` 後 `statSync().isDirectory()` 驗證;失敗 throw、loudly 報錯,不静默回退錯路徑。
- recipe 內嵌於 4 個 prompt 的「啟動」段與 7 張 skill card 的「Spawn」段(模板/卡必須自含;保持包內零檔案交叉引用)。

效果:同一次 run 的全部長材料聚合在 `<agentDir>/session-artifacts/<父 sid>/`(一處收攏);樹(`.prime`/`.apollo`/任何 configDir)自洽;符合 SDK per-session 佈局。

## 考慮過且否決的替代

- **機械改名 `.prime` → `.apollo`**:另一棵樹是活實例,改名對它指錯樹。
- **child 自推導(各寫各 session 目錄)**:材料散落 N 個 child session 難收攏(用戶決策);child 是 fresh context,須從 system prompt 再推導——正是要消除的 LLM 推導。
- **Env 變數 `PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID`**:daemon 注入每個 worker 進程(實測存在),但名字 INTERNAL 可隨時變、值為 12-hex worker id(非 session ULID)、只給 sid 不給 agent dir(樹分叉仍須另解)。

## Consequences

- 4 個 prompt 的「Python REPL:」/「同一 Python cell」標記是移植期誤標(代碼實為 TypeScript kernel,`await rlm.spawn`),**不在本次範圍**,記錄於此待後續。
- `/mnt/c/scripts/parallel-prime` 副本(.prime 實例 settings.json 引用的來源)不動。
- SDK source 不改。
