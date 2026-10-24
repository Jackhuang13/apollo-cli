# Skill 路徑解析修補計劃 (IScript Kernel)

Status: complete — all work items checked, committed as fa3b27c (main)
Date: 2026-07-21

## Background

`apollo-cli-runtime/src/rlm/repl.ts` 的 `_setupSkillModuleResolver` 硬編碼了兩個
home 目錄 skill roots, 與產品實際 skill 解析慣例不符:

1. `~/.prime/skills` — 殘留路徑, 從來不是任何版本讀寫過的真實路徑
   (現行 config 目錄 `.apollo/agent`, legacy 為 `.prime/agent`;
   真正的 legacy skills 路徑應是 `~/.prime/agent/skills`)。
2. `~/.apollo/skills` — 漏了 `/agent` 一層。權威 user skills 目錄是
   `getAgentDir()/skills` = 默認 `~/.apollo/agent/skills`
   (`packages/coding-agent/src/core/skills.ts:522`, `config.ts:527-533`)。

同類 bug: runtime 側 `harness.ts:118` / `mcp_base.ts:57` 的 `agentDir()`
默認值 `~/.apollo` 同樣漏了 `/agent` (磁盤證據: global harness、auth.json
均在 `~/.apollo/agent/` 下)。

## 設計決定 (user confirmed)

- skill roots 只認 `APOLLO_SKILLS_DIR` 一個 env 名。
  **移除 `PRIME_AGENT_SKILLS_DIR` fallback** (避免雙目錄技能衝突; breaking change)。
- `APOLLO_SKILLS_DIR` 未設或為空時, 由 host (kernel spawn 點) 注入
  `join(getAgentDir(), "skills")`; 用戶 env 優先; 空字串等同未設。
- 解析權威來源保持 `config.ts` 一處; runtime 不複製 agent dir 解析鏈。
- 保留 dev fallback `<cwd>/packages/coding-agent/skills` (dev checkout 用)。
- 目錄不存在時 `existsSync` 靜默跳過, 不 crash。

## 工作項

### 代碼

- [x] **W1** `apollo-cli-runtime/src/rlm/repl.ts` `_setupSkillModuleResolver`:
      L1527 改為 `process.env.APOLLO_SKILLS_DIR` (刪除 `PRIME_AGENT_SKILLS_DIR`);
      刪除 L1535 (`~/.apollo/skills`) 與 L1536 (`~/.prime/skills`);
      移除僅此兩行使用的 `os` import
- [x] **W2** `packages/coding-agent/src/core/kernel/repl-manager.ts` `doStart`
      (~L411-417 spawn env): 注入
      `...(process.env.APOLLO_SKILLS_DIR ? {} : { APOLLO_SKILLS_DIR: join(getAgentDir(), "skills") })`;
      新增 `import { getAgentDir } from "../../config.js"`
- [x] **W3** `apollo-cli-runtime/src/rlm/harness.ts:123` 與
      `mcp_base.ts:62`: `agentDir()` 默認值 `~/.apollo` → `~/.apollo/agent`
      (env chain 不變)

### 測試 (test 行數不得超過 source 行數; 每條須對舊代碼必紅)

- [x] **W4** `apollo-cli-runtime/test/repl.test.ts` 新 case:
      (a) skill 放 fake homedir 的 `.apollo/skills` / `.prime/skills` → 解析不到;
      (b) 只設 `PRIME_AGENT_SKILLS_DIR` 指到含 skill 的 temp dir → 解析不到
      (證明 legacy 名失效); (c) `APOLLO_SKILLS_DIR` 指到 temp dir → 可解析
- [x] **W5** `packages/coding-agent/test/suite/kernel-host-request-round-trip.test.ts`
      既有 suite 內加 case: `APOLLO_AGENT_DIR` 指 temp dir, options env 不傳
      `APOLLO_SKILLS_DIR` → kernel 能 import 該 temp dir 下 skill
      (證明 host 自動注入生效)

### 文檔與 changelog

- [x] **W6** `packages/coding-agent/docs/iscript-kernel.md:72-76`:
      skill roots 改為 `$APOLLO_SKILLS_DIR` (host 默認注入 `<agent dir>/skills`,
      默認 `~/.apollo/agent/skills`) 與 `<cwd>/packages/coding-agent/skills`;
      刪除 `$PRIME_AGENT_SKILLS_DIR`、`~/.apollo/skills`、`~/.prime/skills`
- [x] **W7** `packages/coding-agent/.changes/<slug>.md` fragment:
      - `Changed IScript kernel skill resolution: skills load only from APOLLO_SKILLS_DIR (default <agent dir>/skills); removed the PRIME_AGENT_SKILLS_DIR and hardcoded home-directory fallbacks.`
      - `Fixed kernel-side global harness and auth paths missing the agent dir segment.`
      (apollo-cli-runtime 非 publish 包, 無 fragment)

### 驗證

- [x] **W8** `node --experimental-strip-types --test test/repl.test.ts`
      (apollo-cli-runtime 包根) 通過
- [x] **W9** `npx tsx ../../node_modules/vitest/dist/cli.js --run
      test/suite/kernel-host-request-round-trip.test.ts` (packages/coding-agent 包根) 通過
- [x] **W10** `npm run check` 全量通過 (0 error / 0 warning / 0 info)
- [x] **W11** commit: 僅 `git add` 本次改動的文件, 訊息標明
      `PRIME_AGENT_SKILLS_DIR` 移除為 breaking change (release 應歸 minor)

## 不做的事

- 不改 `piConfig.configDir`, 不動 `LEGACY_CONFIG_DIR_NAME`
- 不碰 `~/.prime/agent/skills` (真 legacy 路徑, 本產品從未讀寫)
- 不為 runtime 複製 agent dir env 解析鏈

## 全倉引用點 (審計記錄)

`APOLLO_SKILLS_DIR` / `PRIME_AGENT_SKILLS_DIR` 僅 3 處, 無其他 `*SKILLS_DIR` 變體:

| 位置 | 性質 |
|---|---|
| `apollo-cli-runtime/src/rlm/repl.ts:1527` | 唯一實際讀取 fallback chain 的代碼 |
| `packages/coding-agent/docs/iscript-kernel.md:72-76` | 文檔 (過時, W6 更新) |
| `packages/coding-agent/test/suite/kernel-host-request-round-trip.test.ts:393` | 測試直接傳 `APOLLO_SKILLS_DIR` 覆蓋, 不受影響 |
