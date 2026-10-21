# IScript 遷移對抗性並行 Review — 彙整報告

- 日期: 2026-10-19
- 範圍: /home/ck/apollo-cli(單一 commit + packages/coding-agent/docs 未提交 diff),聚焦 IPython→IScript 取代殘留、prompt gate/教義 TS 化、9 技能 TS 對齊、websearch/office docs/ACP MCP/文件清理
- 方法: 2 個 fresh-context 唯讀 reviewer 並行(migration-gate / skill-alignment),父 session 仲裁;P0 級主張由仲裁者直接讀碼復核
- 結論: 兩份 review 均 **Merge verdict: BLOCK**
  - review-migration-gate: 3×P0(仲裁者全數證實)、P1×8、P2×4
  - review-skill-alignment: 5×P0、P1×16、P2×9
- 原始報告: ~/.prime/agent/session-artifacts/review-migration-gate.md、review-skill-alignment.md

## 仲裁備註(A/B 分歧裁定)

1. **A-P1-2(「新 TS kernel 不跑 bootstrap cell」)判定為錯誤。** 實證: iscript.ts:517-520 在每次 fresh start 無條件 `m.execute(bootstrapCode)`(restore 之後、首個 user cell 之前)。因此 A 基於此的推論失效;B-P0-2/B-P0-4 成立。
2. **A-P0-2 與 B-P1-2 為同一問題(op/payload shape)**,A 定 P0、B 定 P1。仲裁採 P0:與 M1 同批修復,且僅修 M1 時全部 delegation 仍 100% 失敗。
3. **A-P2-2 與 B-P1-13 為同一問題(goal local-only)**,仲裁採 P1:host 錯誤訊息主動教模型呼叫不存在的 `await goal.complete()`,屬積極誤導。
4. B 之 P0-2(ESM namespace)有 Node v22.23.1 實測支撐,採納。

---

## 一、發現(合併去重;M 編號供後續修訂引用)

### P0(擋合併)

- **M1 · host_request 傳輸幀不匹配 — TS kernel 全部 host 呼叫 300s 逾時**(A-P0-1, B-P0-1;仲裁者讀碼證實)
  - 送: apollo-cli-runtime/src/rlm/repl.ts:112-117 `{id: cellId, event:"host_request", request_id, payload}`
  - 收: packages/coding-agent/src/core/kernel/repl-manager.ts:924-925 讀 `event.data`(=undefined)→ 1428-1429 拋 "payload must be an object"
  - 回: repl-manager.ts:1398-1412 `{type:"host_reply", id: cellId, data:{...}}`(無 `request_id`)
  - 配: repl.ts:1347-1354 依 `msg.request_id` 匹配 → 永遠失配 → 300s timer(repl.ts:105-109)
  - Python 參考幀(host 即按此撰寫): prime-agent-runtime/src/rlm/repl.py:163、__init__.py:135-153
  - 影響: rlm.spawn/create_session/list_subagents/collect/delete_subagent/find_models、agent_observe.*、compact.*、goal.*、refine.*、rlm_heartbeat.*、agent_message.*、mcp.* 全死;PROTOCOL_VERSION 兩側皆 3,ready 手shake 通過,故障被掩蔽。
  - 修法: TS 端送 `data: {type, ...payload}` + 唯一 frame id + 以同 id 配對回覆;加 round-trip 整合測試(現無任何測試)。
- **M2 · mod.ts payload 用 `op` + 扁平 shape;host 要求 `type` + kwargs**(A-P0-2, B-P1-2;仲裁者讀碼證實)
  - mod.ts:131/150/163/176/191/218 送 `op:"rlm_spawn"` 等扁平欄位;host repl-manager.ts:1431-1432 要求 `data.type` 字串
  - host handler 契約(agent-session.ts:10950-10998): `rlm.run` ← `{prompt, kwargs}`、`rlm.create_session` ← `{prompt, kwargs}`、`rlm.delete_subagent` ← `{target}`(非 `subagent_id`)
  - 另: mod.ts 各處 `reply.ok === false` / `reply.result` 頂層讀取皆為死碼(host 回 `data.status`/`data.result`)
  - 同 runtime 內正確慣例已存在: bash.ts:570,602 用 `type:`
  - 修法: 單一 `_op(type, payload)` helper,對齊 prime-agent-runtime/src/rlm/__init__.py 的形狀;`subagent_id`→`target`;讀 `reply.data.status`。
- **M3 · 裸全域 skill 呼叫必爆 — `globalThis[skillName]` 是 ESM namespace 而非可呼叫**(B-P0-2;Node v22.23.1 實測)
  - iscript.ts:112 `globalThis[skillName] = await globalThis.__apollo_import__(skillName)`;`__apollo_import__` = createRequire(require)(repl.ts:1189-1243);dual-export mod.ts 回傳 `{__esModule, default, ...named}`
  - 實測: `edit(...)` → `TypeError: ns is not a function`;而 prompt 主動教導該形式(rlm.ts:138)
  - 注意: import 失敗路徑(iscript.ts:117-119)放的是可呼叫的 thrower placeholder — 成功路徑反而不可呼叫
  - 修法: bootstrap/`__apollo_import__` unwrap ESM namespace(default 合併 named exports);named import 維持可用。
- **M4 · 委託契約斷裂 — 子 agent 無法回 parent**(B-P0-3)
  - TS skill(skills/agent-message/src/agent_message/mod.ts:16-50)只是顯示卡片函式 `agent_message(content,{title?,format?})`,無 `.send`
  - host parseSentAgentMessage 期待 `{id, message, deliveryStatus, receiverRole, target:{...}}`(shared.ts:127-137)→ 卡片 payload 永遠解析失敗
  - host handler 存在且可用: agent-session.ts:4222-4227, 11030-11060(`agent_message.send`);Python 軌(__init__.py:17,48-61)是完整 send 契約
  - prompt 教的形式(rlm.ts:74, 177-178)同時踩 M3(無 `.send`)+ 無效 kwargs
  - 修法: TS skill 重建為 host_request client(send(message, receiver_role, receiver_name)),回 host receipt 並從其發顯示卡。
- **M5 · Prompt gate 非對稱 — 預設 `["iscript"]` session 整段 REPL/委託教義被丟棄**(A-P0-3, B-P0-5;仲裁者讀碼證實)
  - system-prompt.ts:64-65 已含 iscript;但 prompts/rlm.ts:93 與 :65 只認 `"ipython"` → 預設 session(預設工具 `["iscript"]`, agent-session.ts:10894)hasIpython=false
  - 被丟: REPL_CONTROL_PROMPT、skill 行、create_session 行、spawn 遞迴 block、refine 教義、child-doctrine 回覆/progress 行
  - 仍附加: buildSubagentGuidance + Generic MCP section(教的全是 M1-M4 壞掉的 API)
  - 另漏: system-prompt.ts:85-86 `customPromptHasFileAccess` 只認 ipython/bash,漏 iscript
  - 無任何測試覆蓋 buildRlmPrompt/buildChildAgentDoctrine/buildSubagentGuidance
  - 修法: 統一 kernel-tool flag(iscript||ipython),三處共用;補 gate 測試。
- **M6 · Python fallback 路徑收到 JS bootstrap — 外部 cwd 必壞**(B-P0-4;與 A-P1-2 衝突,仲裁判 B 對 — iscript.ts:517-520)
  - buildRlmBootstrapCode 只發 JS(iscript.ts:97-127),fresh start 無條件執行(iscript.ts:517-520)
  - interpreter 選擇: 預設 `python -m rlm.repl`;TS 分支僅當 cwd-relative 解析到 apollo-cli-runtime/src/rlm/mod.ts(repl-manager.ts:357-396)
  - 外部 cwd(安裝版/非 repo 根)→ Python kernel → JS bootstrap → 第一格 SyntaxError → kernel 不可用
  - 修法: 按 interpreter 分支 bootstrap;或先解決 TS runtime 的 package-relative 解析(見 M17)。

### P1(發布前必修)

- **M7 · 教義 snippet 是 Python 語法/不存在的 TS API**(A-P1-1, B-P1-1): kwargs(rlm.ts:74,138,159,166,177-178,220-224)、`help()/dir()/inspect.signature`(rlm.ts:126)、三引號(rlm.ts:138)、`time.sleep()`(rlm.ts:17)、"Pre-installed Python packages / uv pip install"(rlm.ts:108-109,TS kernel 不實)、`rlm.create_session('task', name=...)` 應為 `create_session({prompt, name})`(mod.ts:148)。修法: 依各 SKILL.md/實際 TS 簽名重寫。
- **M8 · progress_note 只發 display MIME,host 丟棄**(A-P1-4, B-P1-3): mod.ts:201-212 發 `application/vnd.apollo-cli.progress-note+json`;host display 只解析 diff/attachment/agent-message(repl-manager.ts:988-1004);功能性路徑是 host_request `rlm.progress.note`(agent-session.ts:10991)。修法: `host_request({type:"rlm.progress.note", message})`。
- **M9 · attach_image 發 raw image MIME 被丟棄,且無 size cap**(A-P1-3, B-P1-11): host 只認 `application/vnd.apollo-cli.attachment+json` {mime_type, data, path}(shared.ts:90,175-186);Python 參考有 350KB base64/1200px 縮放,TS 版無 cap → 大圖可超 MAX_PROTOCOL_LINE_CHARS 32MiB(repl-manager.ts:81)觸發 protocol repair/kernel 重啟。修法: 發 structured MIME + 移植縮放/cap。
- **M10 · ACP MCP 把 Python 碼注入 kernel**(A-P1-5, B-P1-7): acp-mcp.ts:69,92-93 `print(__import__("json").dumps(..., default=str))` → TS kernel SyntaxError;且工具仍被自動掛上(agent-session.ts:10887 附近)。修法: JS 等價(`JSON.stringify` + `mcp.call_tool(server, tool, args)`)或改 host 端產生工具。
- **M11 · compact / rlm-heartbeat / agent-observe op 名與欄位錯誤**(A-P1-6, B-P1-9/12/14):
  - compact: `op:"compact_status"/"compact_request"` vs host `compact.status`/`compact.run`;讀 host 不送的欄位(should_compact/threshold_percent;host 送 `scheduled`)(mod.ts:47,51-57,83,92-100 vs agent-session.ts:4008-4043)
  - rlm-heartbeat: 只有 check_subagents/report_progress,缺 host 已就緒的 list/create/update/delete CRUD(agent-session.ts:11014-11023)
  - agent-observe: `op:"rlm_inspect_subagent"` 無對應 host handler;host 有 `agent_observe.list/get/recent`(agent-session.ts:11073-11079);prompt 教 `list_agents()`(不存在)
  - orchestration-heartbeat 是 2 行跨技能 relative re-export(非 sibling 安裝即斷)
- **M12 · edit diff payload 形狀不合 — TUI diff 永遠空白**(B-P1-10): TS 發 `{path, diff, firstChangedLine, replacements}`(mod.ts:330-340);host parseDiffDisplay 解構 `{path, old_str, new_str, start_line}`(shared.ts:158-167)→ 靜默丟棄。Python 參考形狀正確(__init__.py:52-63)。
- **M13 · refine skill 幾乎每個入口都打不中 harness**(A-P1-1 表, B-P1-4): 呼叫不存在的 list_rules/upsert_rule/get_preferences 等;`search(query, limit)` 參數位移(limit 綁到 kind);scope 詞彙 user|project vs local|global(harness.ts:19);`refine.run()` 不存在(rlm.ts:198 教它)。harness 真實面: create/update/delete memory|prompt_note|skill|subagent + record_refinement + plan_refinement + overview/search/snapshot + 通用 upsert/get/delete/list/create/update。修法: 以真實 harness 面重寫,scope 用 local/global;run() 若要保留應為 host_request client。
- **M14 · websearch 參數序反 + `globalThis.mcp` 被 bootstrap 覆蓋**(B-P1-5/6): `call_tool("web_search_exa", {...}, "exa")` 是 tool-first,runtime 是 `call_tool(server, tool, args)`(mcp.ts:735-739)→ TypeError;bootstrap 把 skill namespace 覆蓋掉 runtime 的 mcp 全域(無 call_tool),named import 又自指 Proxy 有遞迴風險。修法: 不覆蓋 runtime 全域;websearch 改 server-first。
- **M15 · mcp_base hostInventory 讀整幀**(B-P1-8): mcp_base.ts:106-140 在 resolved 值上讀 connections/plugins/nextCursor,但 resolved 是整幀 `{type,id,data}` → 即使 M1 修好仍炸。修法: 先 unwrap `reply.data`。
- **M16 · goal skill 純本地 + host 誤導訊息**(A-P2-2, B-P1-13;仲裁升 P1): mod.ts 只有 create_goal/GoalTracker(記憶體);host goal.get/create/complete 無人呼叫;host 錯誤文本教 `await goal.complete()`(agent-session.ts:4279)與 goals.ts:233 皆指向不存在的 API。
- **M17 · Python provisioning 在 TS 判定前全量執行 + TS runtime 未隨包發佈**(A-P1-7, B-P1-15): ensureKernelPython(uv + Python 3.11 venv + prime-agent-runtime + 12 個預裝包 + per-skill pip)每次 kernel 啟動無條件跑(repl-manager.ts:357-396);TS runtime 解析是 cwd-relative;copy-assets 只拷 prime-agent-runtime 不拷 apollo-cli-runtime → 安裝版永遠走 Python;`--prime-agent-bootstrap`/install.sh 在安裝時裝 uv/Python;resolveRuntimeSourceDir 只認 pyproject.toml,apollo-cli-runtime 候選是死碼。修法順序: TS runtime 隨包 + package-relative 解析 → 才移除 Python 熱路徑。
- **M18 · 過期回歸測試為紅**(B-P1-16): test/suite/regressions/4428-remove-legacy-pi-mono-tools.test.ts:45 期待 `["ipython"]`,現況 `createAllToolDefinitions` 回 `["iscript","ipython"]`(tools/index.ts:53,62-69)→ CI 必紅。

### P2(僅回報)

- **M19 · office-doc 四技能是 14 行 stub,SKILL.md 過度承諾**(B-P2-1): docx/xlsx/pdf/pptx 的 mod.ts 只實作 `inspect_<fmt>` 回 metadata;SKILL.md 宣稱 read/create/edit/extract/generate。修法: 實作或把 SKILL.md 降級為「metadata inspection only」。
- **M20 · SkillKind 無 "iscript"**(B-P2-2): skills.ts:26 只有 markdown|python;TS 技能被標 `kind:"python"`、prompt XML 發 `<python_import>`。
- **M21 · dual-track Python skill 殘留**(A-P2-1, B-P2-3): 9+ 技能目錄並存 pyproject.toml + .py;TS kernel 不載入但 ensureKernelPython 仍 pip install。
- **M22 · Python 字樣/命名殘留**(A-P2-1, B-P2-2/4/8, A-P2-4): ipython.ts 別名層、Ipython* 別名、"Starting Python kernel…" 進度字串(iscript.ts:493/511/517)、repl-manager.ts 頭注、state-snapshot.ts "pickled with dill"(TS 用 v8 幀)、ensureKernelDeno 別名(bootstrap.ts:1046)、ready 幀 `python` 欄位(repl.ts:1319-1325)、"pre-imported Python mcp object"(system-prompt.ts:178)、extensions.md:1897 上游 prime-agent 連結。
- **M23 · Deno spawn 用已移除旗標**(B-P2-5): repl-manager.ts:391 `--unstable-kv`(Deno 2 已移除);本機無 Deno,Node 為主要路徑。
- **M24 · 用戶文件大規模 Python REPL/ipython 殘留**(B-P2-6): usage.md、rlm.md、quickstart.md、skills.md、long-running-agents.md、acp.md、mcp-integrations.md、sdk.md、extensions.md、compaction.md 多處;iscript-kernel.md 與 textual-tui.md 已屬準確。
- **M25 · docs.json 漏 standalone-binaries.md**(B-P2-7)。
- **M26 · websearch 契約分歧**(A-P2-3): 安裝機上技能描述仍說 Serper/Google,repo SKILL.md 與 mod.ts 是 Exa MCP;Python 軌(Serper)殘留矛盾。
- **M27 · SKILL.md 與實作細部不一致**(B-P2-9): compact 的 should_compact 語義、goal 本地 tracker vs host 狀態、agent-message 卡 API vs 委託教義兩文矛盾(取 M4 的 messaging 契約為準)。

## 二、事實(verified,供修復時對照)

**Host 協定契約(host 係按 Python 參考撰寫,TS runtime 是 outlier)**
- 請求幀: `{event:"host_request", id: rid, data: {..., type: "<dotted.op>"}}`;回覆 `{type:"host_reply", id: rid, data:{status:"ok"|"error", result|error}}`(prime-agent-runtime/src/rlm/repl.py:163、__init__.py:135-153;repl-manager.ts:924-926,1398-1400,1427-1443)
- host handler 註冊表(agent-session.ts:10950-11097): rlm.run(10952)、rlm.create_session(10955)、bash.completed(10958)、bash.consumed(10983)、rlm.find_models(10986)、rlm.list_subagents(10987)、rlm.collect(10988)、rlm.progress.note(10991)、rlm.delete_subagent(10992)、model.info(10993)、goal.*(10999-11002)、compact.*(11004-11008)、refine.*(11009-11013)、rlm_heartbeat.*(11014-11023)、agent_message.*(11030+, handler 4222)、agent_observe.*(11073-11079);MCP inventory 在 mcp-manager.ts:575-662(mcp.refresh/config/list_plugins/search_plugins/list_connections/begin_login/connect)

**TS kernel 已驗證可用(無 host_request 依賴的部分)**
- 頂級 await、`!cmd` 轉譯(repl.ts:516-534)、bash() handles(pid/running/tail/output/poll/kill)、16MiB/變數快照上限、state restore(repl-manager.ts:1710-1740)、v8 序列化快照(repl.ts:882-977)、`import {x} from "skill"` on-demand 路徑(repl.ts:1189-1244 + 537-565)
- harness 全 API 對齊: harness.ts 提供 prompt 聲稱的全部 CRUD(含 global/global_ 雙旗標、Proxy :1365、get_harness_state :1325)→ harness 教義可原樣恢復
- host 回覆形狀: spawn → {rlm_child_id, name, session_dir, model};create_session → {active_session_id, session_id, name, session_file, model};collect → {results: [...]}
- bash.completed/consumed 用正確 `type:` 幀(bash.ts:569-603);但 bash.ts:575 在整幀上讀 reply.status 永遠 undefined → completion 通知從不 arm,用戶只看到 stderr fallback
- PROTOCOL_VERSION 兩側皆 3(repl-manager.ts:70、repl.ts:13)
- rlm.run 更名 guard 為刻意(mod.ts 對 .run 拋 _RENAMED_RUN_MESSAGE)
- 無測試覆蓋 buildRlmPrompt/buildChildAgentDoctrine/buildSubagentGuidance 或 host_request round-trip

**環境事實**
- 本機 Node v22.23.1(/home/ck/.local/bin/node),無 Deno;MAX_PROTOCOL_LINE_CHARS = 32MiB(repl-manager.ts:81)
- 9 個「已對齊」技能均有 TS mod.ts;orchestration-heartbeat 為 alias;docx/xlsx/pdf/pptx/mcp/skill-creator/prime-intellect 無 Python 軌;attach-image 與 websearch 殘留 .py

**非問題(已驗證一致)**
- textual-tui.md 與 iscript-kernel.md 內容與代碼相符
- mcp skill SKILL.md 的 server-first call_tool 文檔正確
- bash API 與 prompt 一致;`!cmd` 已實作

## 三、改善事項(依依賴順序)

1. **傳輸層**(M1+M2+M15): runtime 端單一 `_op(type, payload)` helper — 送 `data:{type, ...payload}` + 唯一 frame id、以同 id 配對回覆、unwrap `reply.data`、`data.status==="error"` 時 throw;把全部 op 指向 dotted host 名(rlm.run 含 kwargs、delete_subagent 用 target、progress.note 等)。加 round-trip 整合測試。此一步解鎖大半技能;之前做的 per-skill 修無法端到端驗證。
2. **namespace unwrap**(M3): bootstrap 對 ESM namespace 暴露 default(合併 named),named import 不變。
3. **agent_message 重建**(M4): host_request client 化,Python surface(send/receiver_role/receiver_name);SKILL.md 同步。
4. **prompt gate + 教義 JS 化**(M5+M7): rlm.ts:65/93 與 system-prompt.ts:85 統一 kernel-tool flag + 補測試;snippet 全改 TS(positional、import-first、移除 help/dir/三引號/uv pip 行;create_session 改 options 形式)。
5. **interpreter 預設與 bootstrap 分支**(M6+M17): TS runtime 先判定/包內解析,bootstrap 按 interpreter 分支或刪除;ensureKernelPython 移到 Python fallback 才跑;apollo-cli-runtime 隨 dist 發佈。
6. **payload 契約**(M8-M12, M16): edit diff 發 {path, old_str, new_str, start_line};attach_image 發 structured MIME + cap;progress_note 走 host_request;compact 對齊 host 欄位;goal 暴露 get/create/complete host client 並同步 host 錯誤文本(agent-session.ts:4279、goals.ts:233)。
7. **MCP 身份**(M10, M14): globalThis.mcp 不被覆蓋;websearch server-first;ACP MCP 改 JS 注入或 host 端工具。
8. **技能重寫**(M11, M13, M27): refine 改真實 harness 面(local/global);rlm-heartbeat 補 list/create/update/delete;agent-observe 對齊 agent_observe.list/get/recent;orchestration-heartbeat 去跨技能 re-export。
9. **測試**(M18): 4428 期待改 ["iscript","ipython"] 並跑綠。
10. **文件/命名 sweep**(M19-M26): docs/* 改 iscript + TS 例;docs.json 補 standalone-binaries.md;SkillKind 加 "iscript";去 --unstable-kv;Python 字樣/進度串/別名清理;office-doc SKILL.md 降級或實作;dual-track Python 技能刪除(在 TS 路徑驗證後);websearch Serper 殘留清除;fork 連結指向本 repo。

## 四、仲裁三類歸檔

**現在值得修的(與 P0/CI 紅直接相關,彼此依賴)**
1. M1+M2 傳輸層 + `_op` helper + round-trip 測試(解鎖一切 delegation/host 技能)
2. M3 namespace unwrap(裸全域 skill 呼叫)
3. M4 agent_message 重建(子 agent 回覆路徑)
4. M5 prompt gate 三處統一 + gate 測試(兩行級修改,恢復教義交付)
5. M6 bootstrap 按 interpreter 分支(外部 cwd 不可用)
6. M18 過期測試修紅(CI 阻擋)

**可選改善(值得排期,不擋本次)**
- M7 教義全量 TS 化(可分階段:先恢復 A 報告驗證過的「現即安全」子集 — REPL control 減 completion-follow-up 句、harness CRUD、import-first skill 行;其餘待 M1-M4 落地)
- M8-M12、M16 技能/host payload 契約(待步驟 1 落地後可端到端驗證)
- M13 refine 重寫、M11 rlm-heartbeat CRUD + agent-observe 對齊
- M14+M15 MCP 身份與 inventory
- M17 包內發佈 + Python 熱路徑移除(「完全移除 IPython」的最後一段)
- M19 office-doc 決策(實作 vs 降級文檔)

**忽略或遞延(附理由)**
- A 報告之 P1-2(「新 kernel 不跑 bootstrap」): 經仲裁為錯誤事實,無對應動作;僅留紀錄避免未來誤導。
- M22/M24 命名與 Python 字樣殘留: 純表面,功能不受影響;批次 sweep,不逐條現在修。
- M23 Deno `--unstable-kv`: 本機無 Deno、Node 為主要路徑,該分支目前不可達;保留 Deno 路徑時再修。
- M25/M26 docs.json 孤兒與 Serper 文檔分歧: 極小,併入文件 sweep。
- M21 dual-track Python 技能刪除: 依賴 M17(TS 路徑先被驗證為預設),現在刪會削弱回退能力。
