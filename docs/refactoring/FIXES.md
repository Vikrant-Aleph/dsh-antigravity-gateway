# 独立代码审查问题修复清单（FIXES）

> **审查来源**：
> - 第一轮（架构重构验收）：`REVIEW_ROUND2`（基准 `@ e7fceeb` / 复审 `@ b428f8a`，归档于历史提交 `13b365a`）
> - 第二轮（新功能全面验收）：历史记录（基准 `@ 1c93221` / `FIX-010`~`FIX-015`）
> - 第三轮（`v0.2.0` 全量发布前独立验收）：[REVIEW.md](REVIEW.md)（基准 `main @ 3bc93a1`）
> **修复分支**：`main`
> **原则**：逐项实证核实，保留原始审查报告不改动；每项修复均配套离线回归测试或可复现验证证据。

---

## 第三轮：`v0.2.0` 发布前独立验收审查修复台账（`FIX-016` ~ `FIX-018`）

| 修复 ID | 审查编号 | 级别 | 核实结论 | 根因与影响范围 | 处理方案 | 状态 | 验收标准与验证证据 |
|---|---|---|---|---|---|---|---|
| **FIX-016** | `P2-01` | **P2** | **已核实为真** | [docs/features/oauth-client-externalization/SPEC.md:4-5](../features/oauth-client-externalization/SPEC.md#L4-L5) 仍标注「第一阶段（需求更新，待专人确认并实施）」，[PLAN.md:4, 60-64](../features/oauth-client-externalization/PLAN.md#L60-L64) 任务表仍为 `WAITING`/`TODO`，未随 `PROGRESS.md` 同步。 | 更新 `SPEC.md` 头部为「已实施验收（`v0.2.0`）」并同步 `PLAN.md` 全部任务状态为 `DONE`。 | `DONE` | 文档状态与代码及 `PROGRESS.md` 完全一致。 |
| **FIX-017** | `P2-02` | **P2** | **已核实为真** | [AGENTS.md:47](../../AGENTS.md#L47) 的 `release-check.mjs` 示例命令仍沿用 `--tag v0.1.0`，与当前 `0.2.0` 版本不一致。 | 将示例命令更新为 `node scripts/release-check.mjs --tag v0.2.0`。 | `DONE` | `AGENTS.md` 示例命令与当前 `package.json` 版本一致，实测通过。 |
| **FIX-018** | `P2-03` | **P2** | **已核实为真** | 1）[src/core/logger.ts:45](../../src/core/logger.ts#L45) 使用 `\b` 前置词边界，紧邻下划线 `_` 时不会匹配脱敏；<br>2）[src/index.ts:66-73](../../src/index.ts#L66-L73) 未将 `resolveOAuthClient().clientSecret` 注入 `PluginLoggerOptions.secrets`，自定义非标准前缀环境变量密钥依赖表单键名脱敏。 | 1）将正则前置边界放宽为 `(?<![A-Za-z0-9-])`；<br>2）`src/index.ts` 将 `resolveOAuthClient().clientSecret` 传给 `PluginLogger({ secrets: [...] })`；<br>3）补充 `tests/logger.test.mjs` 与 `tests/index.test.mjs` 回归用例。 | `DONE` | `tests/logger.test.mjs` 验证下划线前缀仍被脱敏；`tests/index.test.mjs` 验证自定义环境变量密钥在日志中被替换为 `[redacted]`。 |

---

## 第二轮：新功能全面验收审查修复台账（`FIX-010` ~ `FIX-015`）

| 修复 ID | 审查编号 | 级别 | 核实结论 | 根因与影响范围 | 处理方案 | 状态 | 验收标准与验证证据 |
|---|---|---|---|---|---|---|---|
| **FIX-010** | `P1-01` | **P1** | **已核实为真** | [client.js:602-630, 697-705](../../client.js#L602-L630) 中 `fetchModelsReport` 仅在 `res.ok && res.value` 时写入 `sharedQuotaState.report`，在全量登出（`AccountService.models()` 抛出 `AUTH`）或 `status().loggedIn === false` 时从未清理旧账号配额缓存，导致聊天框继续展示已登出账号的 `5h | XX%` 与邮箱浮层。 | 1）新增 `clearSharedQuota()` 清空 `sharedQuotaState.report` 并广播刷新；<br>2）在 `fetchModelsReport()` 捕获 `AUTH` / `MISSING_CREDENTIAL` 错误时、以及 `AccountPanel` 登出至无剩余账号或 `load()` 返回 `!loggedIn` 时调用 `clearSharedQuota()`；<br>3）在 `tests/client-contract.test.mjs` 补充登出后回归验证。 | `DONE` | `npm run typecheck:client` (0) 与 `tests/client-contract.test.mjs` 验证登出后指示器立即回退 `5h | --` 且浮层不再显示旧账号邮箱。 |
| **FIX-011** | `P1-02` | **P1** | **已核实为真** | [docs/features/quota-multi-account/PLAN.md:11, 15](../features/quota-multi-account/PLAN.md#L11-L15) 的 Markdown 链接包含了个人本机绝对路径 `C:\Users\Vikrant\...`，违背 `AGENTS.md §5` 脱敏要求并在跨机器构成死链；全仓 `grep` 核实其余仅出现在保留原文的 `REVIEW.md`。 | 将两处路径替换为 `@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/InputBar.tsx` 与 `src/client/contract/slots.ts` 包相对引用；全仓复检无遗留本机绝对路径。 | `DONE` | `grep` 确认仓库源码与功能文档零 `C:\Users\` / `C:/Users/` 个人路径残留（仅保留原始 `REVIEW.md` 引用）。 |
| **FIX-012** | `P2-01` | **P2** | **已核实为真** | [src/core/auth.ts:154-191, 312-331](../../src/core/auth.ts#L154-L191) 在 `switchAccount()` 与 `switchAccountIfCurrent()` 中递增全局 `authGeneration` 并清空 `refreshInFlightByAccount`，导致切号瞬间并发刷新中的令牌请求误抛 `ABORTED`。 | 改为按 `accountId` 隔离的 `accountGenerations: Map<string, number>` + `globalAuthGeneration`（仅 `logout(all)` 递增全局代数；单账号登出/重新登录/导入仅失效对应 `accountId`）；`switchAccount` 与 `switchAccountIfCurrent` 不再破坏其他账号的在途刷新。 | `DONE` | `tests/auth.test.mjs` 新增并发用例验证 `switchAccount` 期间另一账号的在途 `getCredentialForAccount` 刷新正常完成并落盘。 |
| **FIX-013** | `P2-02` | **P2** | **已核实为真** | [TECHNICAL.md](../../TECHNICAL.md) 与 [TECHNICAL.us.md](../../TECHNICAL.us.md) 滞后于新功能架构（缺 `autoSwitchAccount`、`accounts`/`switch`/`logout [all]` 命令、`switch` RPC、`CredentialVault` v2、`SHARED_PROJECT_IDS`、`catalog-cache.json` v2、自动故障转移与 `conversation.input.right` 指示器），且 4 份文档测试计数停留在 153。 | 全面同步更新 `TECHNICAL.md` 与 `TECHNICAL.us.md`（§1、§3.2、§6.1–6.3、§7、§8、§10），并将 `README.md`、`README.us.md`、`TECHNICAL.md`、`TECHNICAL.us.md` 测试数统一更新为实际 **155**。 | `DONE` | 4 份文档与实际代码及测试数量（155）完全对齐。 |
| **FIX-014** | `P2-03` | **P2** | **已核实为真** | [client.js:1065-1067, 1091-1099](../../client.js#L1065-L1067) 当 `compact.window === 'model'` 回退时仍硬编码前缀 `5h |`；按钮未绑定 `Escape` 键关闭浮层。 | 1）当 `compact.window === 'model'` 时显示 `quota | ${pct}%`；<br>2）在徽标按钮 `onKeyDown` 补充 `Escape` 关闭浮层逻辑；<br>3）补充契约测试断言。 | `DONE` | `tests/client-contract.test.mjs` 验证 `quota | 65%` 回退展示与 `Escape` 关闭浮层行为。 |
| **FIX-015** | `P2-04` | **P2** | **已核实为真** | 1）[src/core/credentials.ts:71-81, 305-308](../../src/core/credentials.ts#L71-L81) `deriveAccountId` 未跳过 `SHARED_PROJECT_IDS`，且碰撞后缀使用 `accounts.length + 1`；<br>2）[scripts/release-check.mjs:72-78](../../scripts/release-check.mjs#L72-L78) 未显式拦截 `package/docs/features/`。 | 1）`deriveAccountId` 跳过 `SHARED_PROJECT_IDS`，`addAccount` 改为 `while` 递增唯一后缀（`-2`, `-3`, ...）；<br>2）`release-check.mjs` 黑名单增加 `package/docs/features/`；<br>3）补充无邮箱同项目 ID 单元测试。 | `DONE` | `tests/credentials.test.mjs` 验证两个无邮箱 `aicode-consumers` 账号生成互不相同的 `acct:*` ID；`release-check.mjs --tag v0.1.0 --archive-dir .` 通过。 |

---

## 第一轮：四层架构重构审查修复台账（`FIX-001` ~ `FIX-009`）

| 修复 ID | 审查编号 | 级别 | 核实结论 | 根因与影响范围 | 处理方案 | 状态 | 验收标准与验证证据 |
|---|---|---|---|---|---|---|---|
| **FIX-001** | `P1-01` | **P1** | **已核实为真** | `client.js` 将 `slots.register` 提取为裸函数 `registerSlot` 调用，丢失 `this === slots` 接收器；`slots.inject` 回调可能异步触发逃逸外层同步 `try/catch`。 | 改用 `registerSlot.call(slots, ...)` 并为 `slots.inject` 回调补充独立 `try/catch`；在 `tests/client-contract.test.mjs` 验证 `this === ctx.slots` 与延迟抛错容错。 | `DONE` | `npm run typecheck:client` (0) 与 `tests/client-contract.test.mjs` 通过。 |
| **FIX-002** | `P2-01` | **P2** | **已核实为真** | `resolveGatewayConfig(raw)` 未调用 `Config(raw)` 且 `dumpRequestsTo` 被推导为必选 `string`。 | `resolveGatewayConfig(raw = {})` 改用 `Config(raw)`，剥离 `Schemastery.ObjectT` 索引签名精确类型；补充 `apply(ctx, {})` 单测。 | `DONE` | `npm run typecheck:ts` (0) 与 `tests/index.test.mjs` 通过。 |
| **FIX-003** | `P2-02` | **P2** | **已核实为真** | `ModelCatalog` TTL 过期后 `list()` 刷新 `cachedParsed` 未重置 `cachedFullReport`。 | 非完整探测刷新时重置 `fullReport = false`；在 `tests/catalog.test.mjs` 补充回归测试。 | `DONE` | `tests/catalog.test.mjs` 验证 `quotaCalls === 2`。 |
| **FIX-004** | `P2-03` | **P2** | **已核实为真** | `readBoundedText()` 未对 `reader.read()` 做 `AbortSignal` 竞态，超限未调用 `reader.cancel()`。 | 使用 `raceWithAbort(reader.read(), signal, ...)` 并确保中止/超限调用 `reader.cancel()`。 | `DONE` | `tests/transport.test.mjs` 验证挂起流即时按 `ABORTED` 退出并取消 reader。 |
| **FIX-005** | `P2-04` | **P2** | **已核实为真** | `startCallbackServer().close()` 未调用 `server.closeAllConnections?.()`，`error` 监听未移除 `onAbort`。 | `close()` 调用 `server.closeAllConnections?.()` 并移除 `onAbort`。 | `DONE` | `tests/oauth.test.mjs` 验证 Keep-Alive 下立即释放端口。 |
| **FIX-006** | `P2-05` | **P2** | **已核实为真** | `logout()` / `importFromAntigravityAuth()` 未使在途 `refresh()` 失效。 | 引入防写回代数守卫并在 `tests/auth.test.mjs` 补充并发登出回归测试（后于 `FIX-012` 升级为按账号隔离）。 | `DONE` | `tests/auth.test.mjs` 通过。 |
| **FIX-007** | `P2-06` | **P2** | **已核实为真** | `rpc.ts` 挂载时缓存 `mode`，晚挂载 `webServer` 不会切换为 `blocked`。 | 在路由 `fetch` 内动态评估 `accountModeFor(ctxWithConnection.get?.('webServer'))`。 | `DONE` | `tests/account-service.test.mjs` 通过。 |
| **FIX-008** | `P2-07` | **P2** | **已核实为真** | 流式中途取消、发射后错误不重试、`dumpRequestsTo` 异步落盘与 `MAX_DISPATCHERS` 淘汰缺少直接单测。 | 在 `tests/adapter.test.mjs` 与 `tests/transport.test.mjs` 补齐全部 4 项边界测试。 | `DONE` | 4 项边界测试通过。 |
| **FIX-009** | `P2-08` | **P2** | **部分修复 / 保留项已登记** | `REPORT.md`/`PROGRESS.md` 计数与过期段落、`pack:local` 重复构建、`TECHNICAL*.md` `GatewayError` 命名、`.npm-cache/` 保留说明。 | 修正文档计数、`pack:local` 改为 `npm pack`、更新 `TECHNICAL*.md`，保留 `.gitignore` 忽略的 `.npm-cache/`。 | `DONE` | `npm run verify` 与 `release-check.mjs` 全绿。 |
