# 账号页视觉升级与多账号同项目 ID 覆盖缺陷修复（SPEC）

## 1. 问题与需求
1. **账号设置页视觉层次优化**（`client.js` `AccountPanel`）：
   - 改为与「模型」页统一的现代分层设计：顶部标题+操作栏、当前激活账号高亮卡片（突出账号邮箱 + 结构化元信息网格）、独立的已登录账号列表卡片（带首字母头像圆标、切换/移除按钮与自动切号状态徽标），以及独立脱敏提示页脚。
2. **修复多账号登录覆盖旧账号的根因缺陷**：
   - **根因 1**：Google Antigravity 消费者账号的 `loadCodeAssist` 会为不同 Google 账号返回共享项目 ID `aicode-consumers`（以及占位符 `inductive-dreamer-qrkws`）。`sameAccountIdentity()` 在邮箱不同时回退到 `existing.projectId === incoming.projectId`，导致第 2 个 Google 账号覆盖第 1 个账号。
   - **根因 2**：`accountCacheKey()` 优先使用 `projectId` 而非 `email`，导致多个使用 `aicode-consumers` 的账号在 `ModelCatalog` 内存缓存、磁盘缓存和额度冷却表中互相串号覆盖。
   - **根因 3**：若 `/userinfo` 偶发失败导致 `email` 为空，也会失去唯一身份；需支持从 Google OAuth 返回的 `id_token` JWT 载荷提取 `email` 作为零网络兜底。

## 2. 验收标准
- 两个不同邮箱（如 `alice@gmail.com` 与 `bob@gmail.com`）同属 `projectId: 'aicode-consumers'` 时，依次调用 `store.addAccount` 或 `auth.login` 均保留全部账号（`accounts.length === 2`），绝不互相覆盖。
- `accountCacheKey` 为两个同属 `aicode-consumers` 但邮箱不同的账号生成互不相同的缓存键；`ModelCatalog` 冷却与故障转移严格隔离。
- `AccountPanel` 渲染分层清晰的标题栏、当前账号卡片、账号列表与切换/移除操作，`npm run verify`（含 `typecheck:client`）及 `pack:local` + `release-check.mjs` 全绿。
