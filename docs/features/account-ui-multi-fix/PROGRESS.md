# 账号页视觉升级与多账号覆盖修复进度（PROGRESS）

- **状态**：已完成并验证通过（2026-11-26）
- **规格**：[SPEC.md](SPEC.md)
- **修改摘要**：
  1. `src/core/credentials.ts`：排除 `aicode-consumers`、`inductive-dreamer-qrkws` 等共享项目 ID，邮箱不同时绝不因项目 ID 相同而合并覆盖账号。
  2. `src/protocol/catalog-parser.ts`：`accountCacheKey` 优先级调整为 `email` → `id` → `projectId`，避免多账号同用 `aicode-consumers` 时串号覆盖内存/磁盘缓存及耗尽冷却状态。
  3. `src/core/oauth.ts` & `src/core/auth.ts`：从 `id_token` JWT 载荷解析 `email` 作为 `/userinfo` 失败时的零网络兜底。
  4. `client.js`：重构 `AccountPanel` 视觉层次（顶部操作栏、当前账号焦点卡片+头像+元信息网格、多账号列表、脱敏页脚提示，以及旧后端未重启时的明确提示）。
  5. 补充 `tests/credentials.test.mjs`、`tests/catalog.test.mjs`、`tests/oauth.test.mjs`、`tests/adapter.test.mjs`、`tests/client-contract.test.mjs` 回归测试。
- **验证结果**：`npm run verify`（154/154 通过，含 `tsc -p tsconfig.json --noEmit` 与 `tsc -p tsconfig.client.json --noEmit`）及 `npm run pack:local` + `release-check.mjs --tag v0.1.0 --archive-dir .` 全绿。
