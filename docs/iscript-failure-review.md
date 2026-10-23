# IScript 工具失敗歸類回顧

- iscript: 現行主要工具名(ipython 為併存的 legacy alias)。 ipython: legacy alias(刻意保留,非未完成清理)。createAllToolDefinitions() 目前同時註冊 iscript 與 ipython 兩個工具名(同一個 createIScriptToolDefinition、不同 name;packages/coding-agent/src/core/tools/index.ts L60–72),4428 回歸測試鎖定雙名註冊與 legacy 解析,屬預期行為。舊 session log 裡的 "ipython" toolName 在 replay、compaction、ACP、TUI 渲染等路徑仍以雙名檢查相容;ACP 的 _meta 鍵 "ipython" 與 session 內線用字串(ipython_sent_agent_message、ipython_state、ipython_state_restored)保留原值。 日期: 2026-10-22
- 範圍: ~/.apolog 裡的 toolName "ipython"、TUI 顯示的 deno、註冊名 iscript/ipython 是同一個 IScript 持久 REPL 的名字層:lo/agent/sessions/ 最近 47 個 apollo-cli session log(JSONL),掃描 toolName=ipython 的 toolResult
- 方法: 唯讀 log 掃描 + 以 apollo-cli-runtime 來源碼與 live kernel 實測驗證根因
- 結果: 約 57 筆疑似失敗,其中約 50 筆為真實失敗,歸為四類

## 命名對照(先釐清)

log 裡的 toolName "ipython"、TUI 顯示的 deno、目前註冊名 iscript 是同一個 IScript 持久 REPL 的三個名字層:

- ipython: legacy alias(已於 2026-10-22 移除)。createAllToolDefinitions() 原本同時註冊 iscript 與 ipython 兩個工具,清理後只註冊 iscript。舊 session log 裡的 "ipython" toolName 在 replay、compaction、ACP、TUI 渲染等路徑仍以雙名檢查相容;ACP 的 _meta 鍵 "ipython" 與 session 內線用字串(ipython_sent_agent_message、ipython_state、ipython_state_restored)保留原值。
- deno: TUI 程式碼預覽的語言標籤(code-preview.ts 將 python 映射為 deno;iscript-cell.ts 對 deno/python 一視同處)。
- iscript: 現行唯一工具名。

## A. Kernel 本身的 bug(目前 build 仍可重現)

### 多行 method chain → SyntaxError: Unexpected token '.'

- 現行 kernel 實測可重現:[1, 2, 3]\n  .filter(...) 必然拋錯。
- 根因: apollo-cli-runtime/src/rlm/repl.ts 的 _splitTopLevelStatements()(約 L470–485)。碰到 depth-0 換行時,呼叫 _isSyntacticallyCompleteStatement() 判斷「到目前為止解析得通」就切斷 statement;const chain = [1, 2, 3] 單獨是合法 declaration,因此被切斷,下一行 .filter(...) 變成獨立 statement 而爆掉。
- 具體缺陷: _isSyntacticallyCompleteStatement() 只檢查 statement 結尾是否為 operator(/[+\-*/%&|^=<>!,?:.]\s*$/),沒有檢查下一行是否能延伸表達式,違反 JS 的 ASI 規則(V8 只有在下一行無法延續表達式時才會在換行處插入分號)。
- 建議修法: 換行處斷句前 look-ahead 下一非空白、非註解行;若其開頭為 .、?.、) 、]、} 或 binary operator,則不斷句繼續讀。實作位置: _splitTopLevelStatements() 的 \n 分支(L476–484),在 _isSyntacticallyCompleteStatement() 回 true 之後、pushStatement() 之前加檢查。

## B. 舊 kernel build 的 bug(現行 build 已修好)

- ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING(2 筆): 舊 build 未將 await globalThis.__apollo_import__("node:fs") 改寫為 __apollo_import__,直接撞 Node VM 的 dynamic import 限制。現行 build 有改寫(repl.ts _transformTopLevelImports,註明目的即避免此錯),live 驗證正常。
- Kernel bootstrap failed after protocol repair ×4(同一舊 session,舊 checkout /home/ck/workspace/apollo-cli): kernel crash 後重啟也失敗,連 console.log(1+1) 都執行不了,屬當時環境/build 問題,非 cell 程式碼問題。

## C. Prompt / UI 導致的模型混淆(高頻)

- ReferenceError: Deno is not defined ×6,跨 6 個 session: kernel 實際為 Node node:vm(Script.runInThisContext),沒有 Deno global;但 system prompt 寫 IScript (Deno/Node)、TUI 又顯示 deno,模型因此去呼叫 Deno.* API。為最大單一失敗來源。
- TypeError: h.output is not a function ×4,跨 4 個 session: 模型寫 const h = await bash(cmd) 後呼叫 h.output()。但 await bash() 回傳 BashResult,其 .output 是 string property;output() method 存在未 await 的 handle 上(apollo-cli-runtime/src/rlm/bash.ts L424)。模型把 handle 與 result 兩套 API 混用。

## D. 模型一次性誤用(各 1–2 筆)

- ESM kernel 使用 require(×2);import 非 file scheme 的 URL → ERR_UNSUPPORTED_ESM_URL_SCHEME(×1)。
- rlm/harness API 契約錯誤: rlm.delete_subagent target must be a non-empty string、rlm.collect targets must be non-empty strings、agent name 重複(l3child already exists at depth)、memory entry 空 title/content 被拒(×3)。
- 普通 cell 碼錯: fs is not defined(忘記 import)、read / print / writeFileSync is not defined(猜錯 helper 名稱)、readFileSync is not a function、grid / color / allPolys is not defined、mems is not iterable、out.slice is not a function、Cannot read properties of undefined (reading 'slice')。
- Error: spawn sqlite3 ENOENT(主機未安裝 sqlite3)。
- 技能層錯誤(於 iscript cell 內): EditError 精確文本對不上 ×3;AttachImageError 圖片超過 1200px 限制。
- Request was aborted ×3: 長跑 cell(bash/fetch)被中斷(如新訊息打斷執行中 cell),屬執行中斷而非 crash。

## 結論與優先序

1. 值得修: A 組多行 chain bug(repl.ts 分割器違反 ASI)——現行 build 每次寫多行 chain 都會踩到。
2. 值得修: C 組命名混淆——Deno 措辭(prompt/TUI)與 Node-only kernel 不一致,造成 ×6 失敗;h.output 混用是 handle/result 兩套 API 的文件問題,可考慮在 BashResult 上提供明確的 type/錯誤訊息或文件對照。
3. 已修: B 組 dynamic import 改寫;舊 bootstrap 失敗為環境性事件。
4. D 組為模型一次性錯誤,不具系統性,不需改 kernel。
