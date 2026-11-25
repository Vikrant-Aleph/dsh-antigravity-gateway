# 技术方案与实施计划（PLAN）

> **关联需求**：[SPEC.md](SPEC.md)
> **遵循架构**：严格维持 `src/shared/` ← `src/protocol/` ← `src/core/` ← `src/dsh/` ← `src/index.ts` 四层单向依赖及零额外运行时依赖（仅 `undici`）。

---

## 1. DSH 宿主实证调研结论（基于本机 DSH `0.2.2-rc.5` 源码）

通过读取本机 DSH 客户端包源码（`@deepseek-ai/dsh-client-ui-conversation` 与 `@deepseek-ai/dsh-client-ui-model-selection`）：
1. **聊天框插槽位置**：`@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/InputBar.tsx` 第 537–542 行在模型选择器触发按钮左侧紧邻位置渲染：
   - `conversation.input.right`（`kind: 'list', scope: 'session'`）
   - `conversation.input.model`（`ModelSelect` 触发按钮）
   因此选择 `conversation.input.right` 是**唯一既在模型名称正左侧、又不会与 `conversation.input.model.label`（`kind: 'single'`）产生多插件互斥冲突**的标准插槽。
2. **浮层裁剪约束**：`@deepseek-ai/dsh-client-ui-conversation/src/client/contract/slots.ts` 第 322–325 行明确规定：`conversation.input.right` 内的悬停浮层必须 Portal 到 `document.body`，避免被 composer 容器裁剪。
3. **当前所选模型读取**：`dsh-client-ui-model-selection` 在客户端上下文暴露 `modelDirectories` 服务（`directoryFor(sessionId).store`，快照包含 `current: { provider, model, reasoningEffort? } | null`）。在 `client.js` 中采用独立受保护的 `ctx.inject(['slots', 'modelDirectories'], ...)` 子作用域挂载（外层保持硬依赖仅 `['slots']`），既支持 `modelDirectories` 晚挂载，又保证设置页在无对话视图环境中照常工作。

---

## 2. 分层模块设计与改动计划

### 2.1 共享层 `src/shared/`
- **[src/shared/rpc-contracts.ts](../../../src/shared/rpc-contracts.ts)**：
  - `ACCOUNT_ENDPOINTS` 扩充为 `['status', 'login', 'cancel', 'logout', 'import', 'models', 'switch']`。
  - 新增 `AccountSummary`（`id`, `email?`, `projectId?`, `expiresAt?`, `active`, `addedAt?`）与 `AccountModelsPayload` / `ActiveAccountMeta` DTO 契约，并在 `AccountModelsResponse` 中透出 `providers`、`activeAccount`、`accountCount`、`autoSwitchAccount`。
  - 注：保持 `LOG_ENDPOINTS` 不变。

### 2.2 协议层 `src/protocol/`
- **[src/protocol/catalog-parser.ts](../../../src/protocol/catalog-parser.ts)**：
  - `accountCacheKey(info)`: 新增可选 `id` 回退（`proj:...` → `email:...` → `acct:${id}` → `'default'`），彻底防止无 `projectId`/`email` 的多账号共享缓存键冲突。
  - 新增纯辅助函数 `selectQuotaForModel(report, modelId)`：按模型家族匹配 `5h` bucket 并附带单模型 `remainingFraction`/`resetTime` 回退，供前后端（及单测）复用同一套配额计算规则（DRY）。

### 2.3 核心层 `src/core/`
- **[src/core/credentials.ts](../../../src/core/credentials.ts)**：
  - 新增 `GatewayAccountRecord`（继承 `GatewayCredential`，增加 `id: string`、`addedAt?: number`）与 `CredentialVault`（`version: 2`, `activeAccountId`, `accounts`）。
  - 向下兼容读写：
    - 读取兼容 v1 单对象与 v2 多账号对象；
    - 单账号时保持 v1 写入形状（确保既有单账号用户与原有单测 100% 兼容）；当账号数 `>= 2` 时原子写入 v2 `CredentialVault`；
    - 新增 `listAccounts()`、`readActiveAccount()`、`addAccount(cred, { activate? })`、`setActiveAccount(id)`、`removeAccount(id?)`、`switchAccountIfCurrent(expectedId, nextId)`。
- **[src/core/auth.ts](../../../src/core/auth.ts)**：
  - 将 `refreshInFlight` 与 `cachedTier` 从单值改为按 `accountId` 隔离的 `Map`；保留 `authGeneration` 防写回竞争机制（记录每次状态变更/删除/切换）。
  - `login()` 与 `importFromAntigravityAuth()` 改为调用 `store.addAccount(..., { activate: true })`。
  - `logout(accountId?, all?)` 支持移除指定账号、默认移除当前账号并自动递补下一个账号，或全部登出。
  - 新增 `listAccounts()`、`switchAccount(accountId)`、`switchAccountIfCurrent(expectedId, nextId)`、`getCredentialForAccount(accountId, signal, forceRefresh)`；`status()` 补充返回 `activeAccountId` 与 `accounts: AccountSummary[]`。
- **[src/core/catalog.ts](../../../src/core/catalog.ts)**：
  - 内存缓存改为按 `accountKey` 隔离的 `Map<string, AccountCatalogState>`；磁盘 `catalog-cache.json` 升级为 `{ version: 2, entries: Record<string, DiskCatalogCache> }` 并向下兼容读取 v1 单账号格式。
  - 新增 `quotaCooldowns: Map<string, number>`（key 为 `${accountKey}::${modelId}`，值为冷却截止时间戳）及相关方法：
    - `markAccountQuotaExhausted(accountKey, modelId, untilMs?)`
    - `clearAccountQuotaExhausted(accountKey, modelId?)`
    - `isAccountQuotaExhausted(accountKey, modelId, now?)`
    - `selectBestAccountForModel(accounts, activeAccountId, modelId, triedAccountIds)`：综合冷却状态、缓存可用性/禁用状态（跳过 `disabled` / `not-offered`）与已知 `remainingFraction` 排序选出最优候选账号。
  - 新增 `onActiveAccountChanged()`：触发目录更新通知（`registration.replace` + `llm/models-updated`）。

### 2.4 宿主层 `src/dsh/` 与入口 `src/index.ts`
- **[src/dsh/config.ts](../../../src/dsh/config.ts)**：
  - 新增 `autoSwitchAccount: Schema.boolean().default(true)`。
- **[src/dsh/account-service.ts](../../../src/dsh/account-service.ts)**：
  - 接收 `providers: readonly string[]` 与 `autoSwitchAccount: boolean`。
  - `status()` 附加 `providers`、`autoSwitchAccount`、`activeAccountId`、`accounts`。
  - `switch(accountId)` 切换账号并刷新/通知目录。
  - `logout(payload?)` 支持 `{ accountId?, all? }`。
  - `models()` 附加 `providers`、`activeAccount`、`accountCount`、`autoSwitchAccount`、`quotaSummary`（含由 `selectQuotaForModel` 产出的辅助字段如需要）。
  - `dispatch` 支持 `'switch'`。
- **[src/dsh/adapter.ts](../../../src/dsh/adapter.ts)**：
  - 接收 `autoSwitchAccount?: boolean`。
  - 在 `stream(options)` 实现透明故障转移：
    - 预检：若 `autoSwitchAccount` 开启且当前账号已知 `isAccountQuotaExhausted(accountKey, resolved.modelId)`，先尝试切换至最佳候选账号；
    - 被动：在 `!hasEmitted.value && !signal?.aborted` 条件下，若上游返回 `429` 或流内 `429`/`RESOURCE_EXHAUSTED` 错误事件（尚未发射任何内容块），标记当前账号冷却 → 尝试 `selectBestAccountForModel` + `auth.switchAccountIfCurrent` → 刷新目录通知 → **保持相同 `options.model` 与 `options.reasoningEffort` 重试**；
    - 每个账号每次请求至多尝试一次（`triedAccountIds`），全部耗尽后抛原 `RATE_LIMIT` 错误。
- **[src/dsh/commands.ts](../../../src/dsh/commands.ts)**：
  - `/agw status` 列出已配置账号列表与激活标记；
  - 新增 `/agw accounts`（列出账号）、`/agw switch <序号|邮箱|id>`（切换激活账号）；`/agw logout [all]` 兼容既有默认行为。
- **[src/index.ts](../../../src/index.ts)**：
  - 将 `providers` 与 `cfg.autoSwitchAccount` 注入 `AccountService` 与 `AntigravityGatewayAdapter`。

### 2.5 前端模块 `client.js`
- **Quota 进度条与重置时间格式化**：
  - `formatResetCountdown(iso, t)`：计算剩余时间（如 `3h 42m`、`18m`）与本地重置时刻。
  - `QuotaProgressBar({ fraction, t })`：进度条 + 颜色分级（绿色 >25%、琥珀 1–25%、红色 0%）+ 无障碍属性。
- **AccountPanel（设置 → 账号 tab）**：
  - 展示已登录账号列表（激活徽标、邮箱、项目 ID、操作按钮：`设为当前` / `移除`）、添加新 Google 账号按钮（多账号登录不再被“已登录”隐藏）、从 `antigravity-auth` 导入按钮、刷新按钮。
- **ModelsPanel（设置 → 模型 tab）**：
  - 展示当前激活账号标识，为每个 `quotaGroups` bucket 和每个可用模型行渲染 `QuotaProgressBar` 与重置时间倒计时。
- **ComposerQuotaBadge（聊天框模型名称左侧 `5h | 87%`）**：
  - 在 `apply()` 中通过独立的 `try { ctx.inject(['slots', 'modelDirectories'], ...) } catch {}` 注册 `conversation.input.right`（`order: 10`）。
  - 订阅 `directory.store` 与 `remote.$on('llm/models-updated')`，仅当 `current && providers.includes(current.provider)` 时渲染紧凑胶囊 `5h | 87%`。
  - 鼠标悬停 / 键盘聚焦时通过 `ReactDOM.createPortal`（降级支持无 `react-dom` 环境）在 `document.body` 渲染完整额度浮层（当前账号、所选模型进度条、全部配额分组 5h/周进度条与重置时间、多账号自动切换状态），鼠标移出或按 `Escape` 关闭。

---

## 3. 文件级修改清单

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `src/shared/rpc-contracts.ts` | 修改 | 新增 `'switch'` 端点及多账号/额度扩展 DTO 类型 |
| `src/protocol/catalog-parser.ts` | 修改 | `accountCacheKey` 增补 `id` 回退；新增 `selectQuotaForModel` 纯函数 |
| `src/core/credentials.ts` | 修改 | 实现 `CredentialVault`（v1/v2 兼容迁移、多账号增删查切） |
| `src/core/auth.ts` | 修改 | 按账号隔离 `refreshInFlight`/`cachedTier`、支持 `switchAccount`/`switchAccountIfCurrent`/`listAccounts`/指定登出 |
| `src/core/catalog.ts` | 修改 | 按账号隔离内存与磁盘缓存、冷却状态追踪与 `selectBestAccountForModel` |
| `src/dsh/config.ts` | 修改 | 新增 `autoSwitchAccount` 配置项（默认 `true`） |
| `src/dsh/account-service.ts` | 修改 | 暴露多账号状态、`switch`、按账号 `logout` 与 `providers` 列表 |
| `src/dsh/adapter.ts` | 修改 | 实现预检 + `429`/流内额度耗尽自动切换账号（保留原模型与档位） |
| `src/dsh/commands.ts` | 修改 | `/agw status` 展示账号列表，新增 `/agw accounts` 与 `/agw switch` |
| `src/index.ts` | 修改 | 装配 `providers` 与 `autoSwitchAccount` |
| `client.js` | 修改 | 设置页进度条+多账号管理 UI + `conversation.input.right` 额度徽标与悬停浮层（保持严格 `// @ts-check`） |
| `tests/*.test.mjs` | 修改 | 更新与新增单元测试、集成测试及 `client-contract` 契约测试 |
| `README*.md`, `TECHNICAL*.md`, `CHANGELOG.md` | 修改 | 第三阶段同步文档与变更说明 |

---

## 4. 渐进式实施步骤与测试策略

1. **Task F1（共享/协议/核心多账号与缓存隔离）**：`rpc-contracts.ts` → `catalog-parser.ts` → `credentials.ts` → `auth.ts` → `catalog.ts`；验证 `credentials.test.mjs`、`auth.test.mjs`、`catalog.test.mjs`（含 v1→v2 迁移、多账号缓存隔离、冷却与候选选择）。
2. **Task F2（DSH 适配与自动切换故障转移）**：`config.ts` → `account-service.ts` → `adapter.ts` → `commands.ts` → `index.ts`；验证 `account-service.test.mjs`、`commands.test.mjs`、`adapter.test.mjs`（含 429 自动切换并保留原模型、预检切换、流内 429 切换、全账号耗尽返回 `RATE_LIMIT`、并发 CAS 防连跳、已发射输出禁止切换）。
3. **Task F3（前端进度条、多账号 UI 与聊天框 `5h | XX%` 指示器）**：`client.js`；扩展 `client-contract.test.mjs`（含 `conversation.input.right` 注册、非自有模型隐藏、自有模型显示 `5h | 87%`、悬停完整额度展示、缺失 `modelDirectories` 安全降级、`typecheck:client` 零错误）。
4. **Task F4（文档与全量验收）**：更新 `TECHNICAL*.md`、`README*.md`、`CHANGELOG.md`、`PROGRESS.md`，全量运行 `npm run verify`、`npm run pack:local` 与 `release-check.mjs`。

---

## 5. 风险与缓解措施

1. **聊天框插槽与宿主版本差异**：`conversation.input.right` 与 `modelDirectories` 为软依赖，若宿主版本不同导致服务缺失，通过独立 `try/catch` 安全降级，不影响插件激活与设置页。
2. **单账号旧数据兼容**：保留 v1 单账号数据结构在单账号时的原位兼容，仅在多账号（`>=2`）时升级 v2，原子写盘防止损坏。
3. **并发刷新与并发切换竞争**：`AuthManager` 按 `accountId` 隔离单飞刷新并保留 `authGeneration`；`Adapter` 通过 `switchAccountIfCurrent` CAS 语义避免并发请求连续跳过健康账号。
