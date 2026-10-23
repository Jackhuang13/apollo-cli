# HarnessState 與 RLM 改善 — Phase 1 未完成項 Todolist

- 依據文件：`docs/harness-rlm-tune-suggest.md`（Phase 1 完成度檢核）
- 適用模組：`apollo-cli-runtime`（Kernel / REPL / Bash）與 `packages/coding-agent`（Prompt）
- 狀態：Phase 1 共 9 項全數完成（100%）

---

## [x] P0-1 1.1.1 在 apollo-cli-runtime 引入確定性 AST 工具
- **完成方式**：採方案 A，以 `scripts/bundle-vendor-parser.mjs` 將 `@oxc-parser/wasm@0.60.0`（含內嵌 Base64 Wasm）打包為單一檔案 `apollo-cli-runtime/src/rlm/vendor/parser.js`。無外部 runtime 依賴、全平台可攜。

## [x] P0-2 1.1.2 `_transformTopLevelImports` 改 AST 節點遍歷
- **完成方式**：以 `parseSync` 遍歷 `ImportDeclaration` 與 `ImportExpression` AST 節點，依精準 start/end offset 改寫為 `globalThis.__apollo_import__`，徹底消除 regex 與 `_codeMask` 的字串/模板字串外溢風險。

## [x] P0-3 1.1.3 `_splitTopLevelStatements` 改 AST 頂層 Statement 邊界
- **完成方式**：以 AST `program.body` 的陳述式邊界切分頂層陳述式；對無分號且緊接 regex 的邊界實作基於 AST 解析驗證的 incremental fallback，徹底移除逐字元狀態機。

## [x] P0-4 1.1.4 為 AST 重構建立先行回歸測試集
- **完成方式**：`apollo-cli-runtime/test/repl.test.ts` 涵蓋多行鏈、跨行運算子、除法跨行、字串內嵌 import、註解忽略與 regex 語句邊界（12/12 綠）。

## [x] P1-5 1.2.3 `APOLLO_SESSION_KERNEL_PID` 注入 session kernel 自身 env
- **完成方式**：在 `repl.ts` 啟動階段將 `process.env.APOLLO_SESSION_KERNEL_PID = String(process.pid)` 注入 Kernel 本身。

## [x] P1-6 1.2.4 長任務 heartbeat
- **完成方式**：`bash.ts` 建立每 30 秒自動發送的 `bash_heartbeat` 事件定時器，任務完成/reap 時自動清理。

## [x] P1-7 model-facing prompt 同步 600s 預設超時與 `timeout: null` 出口
- **完成方式**：`packages/coding-agent/src/core/prompts/rlm.ts` 已更新說明預設 600s 上界與 `{ timeout: null }` 長任務出口。

## [x] P1-8 補強 descendants / 孤兒回收測試斷言
- **完成方式**：`bash.test.ts` 補強驗證檢測到 `sleep` 子程，且在逾時 group kill 後驗證 `descendants()` 確實清空為 0。

## [x] P2-9 apollo-cli-runtime 納入 type-check 覆蓋
- **完成方式**：新增 `apollo-cli-runtime/tsconfig.json`（支援 `allowImportingTsExtensions`），並將 `tsgo --noEmit -p apollo-cli-runtime/tsconfig.json` 整合進 root `package.json` 的 `npm run check`，修復所有型別報錯。

