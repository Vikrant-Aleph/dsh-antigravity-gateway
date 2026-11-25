# 系统性重构实施方案（PLAN）

> **规划基线**：`main` @ `aedfa19f7bafd5f6a70c40a00c57b4f7fc5536f8`（`v0.1.0`）
> **关联审计**：[AUDIT.md](AUDIT.md)
> **待决决策**：[DECISIONS.md](DECISIONS.md)（`D-001`~`D-006`）
> **状态**：已批准（2026-11-26 获用户明确批准按推荐默认方案实施 Phase 2–5）

---

## 1. 架构对比与目标设计

### 1.1 现行架构痛点
- 17 个源文件扁平堆放在 `src/` 下（约 5,256 行），纯协议逻辑、运行时 I/O 状态、与 DSH 宿主适配交织在 `catalog.ts`（745 行）、`payload.ts`（641 行）、`adapter.ts`（591 行）、`transport.ts`（431 行）、`auth.ts`（390 行）中。
- `src/index.ts` 既包含 21 字段重复类型断言与 Config Schema，又承担全量 `export *` 与插件装配。
- `account-service.ts` 与 `log-service.ts` 各自手写 `/api` RPC 包装；后者缺失 fiber disposer 与环回安全守卫。

### 1.2 目标四层轻量化架构（单向依赖）

针对 ~5.3k 行代码规模，采用四层清晰边界而不制造空壳抽象或重量级容器：

```
Host (DSH / Cordis / WebServer)
   │
   ▼
src/index.ts                      [薄入口：Config 装配、ctx.effect 绑定、受控导出]
   ├──▶ src/dsh/                  [唯一允许导入 @deepseek-ai/* 的宿主适配层]
   │       ├──▶ src/core/         [运行时核心：I/O、状态机、代理/传输、凭据、缓存、日志]
   │       │       ├──▶ src/protocol/   [纯协议层：零宿主/网络/FS/child_process 依赖]
   │       │       └──▶ src/shared/     [零内部依赖：错误模型、守卫、原子写盘、RPC 契约]
   │       ├──▶ src/protocol/
   │       └──▶ src/shared/
   └──▶ src/core/
client.js                         [零打包器前端模块，与 src/shared/rpc-contracts.ts 对齐]
```

**强依赖红线（由 `tests/architecture.test.mjs` 静态守卫校验）**：
1. `src/shared/`：不导入 `src/protocol/`、`src/core/`、`src/dsh/`、`src/index.ts` 或 `@deepseek-ai/*`、`undici`。
2. `src/protocol/`：仅允许导入 `src/shared/` 与纯无 I/O 标准库（如 `node:crypto`、`node:buffer`）；**严禁**导入 `@deepseek-ai/*`、`undici`、`node:fs`、`node:http`、`node:net`、`node:child_process`。
3. `src/core/`：仅允许导入 `src/shared/`、`src/protocol/`、`undici` 与 Node 标准库；**严禁**导入 `@deepseek-ai/*` 或 `src/dsh/`。
4. `src/dsh/`：**唯一**允许导入 `@deepseek-ai/*` 的目录；可依赖 `shared`/`protocol`/`core`；不得反向导入 `src/index.ts`。
5. `src/index.ts`：仅做装配、导出和生命周期绑定，不承载协议或 I/O 业务逻辑。

---

## 2. 文件级迁移映射表（Exact File-Level Plan）

> 注：本表覆盖仓库内全部旧文件与目标新文件。在 Phase 2 实施时通过小批次可回滚提交推进，旧文件在对应层迁移完成且全量测试通过后删除。

### 2.1 `src/` 源文件迁移表

| 操作 | 旧路径 | 目标路径 | 职责变化与说明 |
|---|---|---|---|
| **拆分/重构** | `src/errors.ts` (112 行) | `src/shared/errors.ts` | 重命名为主符号 `GatewayError`/`GatewayErrorCode`/`isGatewayError`，保留 `@deprecated` `Bridge*` 别名（`D-001`）；保留 `statusToError`、`parseRetryAfterMs`、`reportsContextOverflow`、`reportsModelCapacity`、`sanitizeProviderText`。 |
| **新建** | （多处内联重复 `isRecord`/`boundedString` 等） | `src/shared/guards.ts` | 统一提供 `isRecord`、`boundedString`、`stringValue`、`numberValue`、`parseFraction`、`parsePositiveInt`、`boundedInteger`、`raceWithAbort`。 |
| **新建** | （`credentials.ts`/`catalog.ts` 手写 `.tmp` 写盘） | `src/shared/fs-atomic.ts` | 提供 `writeFileAtomicSync(file, data, options?)`：使用 `${file}.${pid}.${randomUUID()}.tmp` 唯一临时文件、`mode`/`chmod` 与 `finally` 残留清理。 |
| **新建** | （分散在 `account-service.ts`/`log-service.ts`） | `src/shared/rpc-contracts.ts` | 集中定义 `/api` 通道、`ACCOUNT_RPC_NAMESPACE`、`LOG_RPC_NAMESPACE`、`ACCOUNT_ENDPOINTS`、`LOG_ENDPOINTS`、`REQUEST_DIAGNOSTICS_VERSION` 与共享响应类型。 |
| **移动** | `src/constants.ts` (116 行) | `src/protocol/constants.ts` | 纯净搬迁至协议层。 |
| **移动/微调** | `src/models.ts` (350 行) | `src/protocol/models.ts` | 将错误导入切换至 `../shared/errors.js`；保持模型表、别名、档位及 `resolveRoute` 完全一致。 |
| **拆分** | `src/payload.ts` (641 行) | `src/protocol/session-metadata.ts` | 拆出 `fnv1a64Signed`、`RequestSessionStore`、`requestSessionKey`、`buildRequestMetadata`（支持直接复用已解析的 `ResolvedRoute`，消除重复 `resolveRoute` 调用同时兼容旧签名）。 |
| **拆分** | `src/payload.ts` | `src/protocol/schema-sanitizer.ts` | 拆出 `sanitizeToolSchema`、`normalizeToolParameters`、`sanitizeToolName`。 |
| **重构** | `src/payload.ts` | `src/protocol/payload.ts` | 保留 `buildEnvelope`、`buildGenerationConfig`、`groupClaudeFunctionResponses` 及结构化输入类型，依赖同层与 `shared/guards.js`。 |
| **移动/微调** | `src/response.ts` (204 行) | `src/protocol/response.ts` | 依赖 `../shared/errors.js` 与 `../shared/guards.js`，解析逻辑不变。 |
| **拆分** | `src/catalog.ts` + `src/auth.ts` (`parseAccountTier`) | `src/protocol/catalog-parser.ts` | 抽离纯解析逻辑：`parseLiveCatalog`、`parseLiveModelIds`、`parseQuotaSummary`、`definitionAvailable`、`buildReportFromParsed`、`parseAccountTier`、`extractProjectId` 与所有 report/quota 类型。 |
| **拆分** | `src/transport.ts` (431 行) | `src/core/transport/proxy.ts` | 拆出 `proxyFromEnv`、`noProxyMatches`、`parseWindowsProxyServer`、`defaultWindowsProxyReader`、`systemProxy`、`resetSystemProxyCache`。 |
| **拆分/修复** | `src/transport.ts` | `src/core/transport/http-client.ts` | 拆出 `AgyTransport`，改为有界 `Map<string, Dispatcher>` 池（淘汰与 `close()` 时安全关闭所有旧池）。 |
| **拆分/修复** | `src/transport.ts` | `src/core/transport/sse.ts` | 拆出 `iterateSse`、`readBoundedText`、`cancelResponse`、`SseEvent`；修复 `withIdleTimeout` 忽略 `AbortSignal` 导致挂起 `idleTimeoutMs` 的问题（`D-006`）。 |
| **新建** | — | `src/core/transport/index.ts` | 聚合导出 `transport/` 子模块。 |
| **移动/修复** | `src/credentials.ts` (169 行) | `src/core/credentials.ts` | 使用 `writeFileAtomicSync` 修复并发写盘竞争；导出 `GatewayCredential` 与 `@deprecated BridgeCredential`。 |
| **移动** | `src/oauth.ts` (237 行) | `src/core/oauth.ts` | 迁移至 `core/`，切换依赖到 `shared/errors.js` 与 `protocol/constants.js`。 |
| **移动/修复** | `src/auth.ts` (390 行) | `src/core/auth.ts` | 迁移至 `core/`；`getCredential()` 使用独立内部生命周期刷新 + `raceWithAbort` 解耦单个 caller 取消；`parseAccountTier` 复用 `protocol/catalog-parser.js`。 |
| **重构/修复** | `src/catalog.ts` (745 行) | `src/core/catalog.ts` | 仅保留运行时探测与缓存管理；新增 `fetchLiveState` single-flight；修复 `definitionsForReport` 与 `offlineReport` 丢失 `agentOrder` 顺序问题；复用 `ANTIGRAVITY_ENDPOINT_FALLBACKS`；改用 `writeFileAtomicSync`。 |
| **移动** | `src/logger.ts` (291 行) | `src/core/logger.ts` | 迁移至 `core/`；新增 `GatewayLogger` 类型别名（保留 `@deprecated BridgeLogger`）。 |
| **新建** | — | `src/dsh/types.ts` | 集中宿主轻量结构接口（`HostContext`、`AttachmentsServiceLike`、`AccountAccessContext`、`LogAccessContext`、`CommandContext`、`PromptCompatContext`）。 |
| **新建** | `src/index.ts` (`Config` + `cfg` 断言) | `src/dsh/config.ts` | 唯一定义 `Config` Schemastery Schema，并以 `Schemastery.TypeT<typeof Config>` 自动推导 `GatewayConfig` + `normalizeLogLevel`，消除 21 字段重复手写。 |
| **新建** | （`account-service.ts`/`log-service.ts` 重复逻辑） | `src/dsh/rpc.ts` | 统一 `/api` JSON-RPC 注册器：解析信封、校验 `method`、统一 `accountModeFor` loopback 守卫（`D-002`）、错误包装，并**追踪 `ctx.inject` fiber + route disposer 完整卸载**。 |
| **拆分** | `src/adapter.ts` (591 行) | `src/dsh/stream-assembler.ts` | 拆出 `toLlmError`、`assembleStreamChunks`（SSE → `StreamChunk` 状态机、`shouldStartNewBlock`、`replayState` 签名传播）。 |
| **重构/修复** | `src/adapter.ts` | `src/dsh/adapter.ts` | 导出 `AntigravityGatewayAdapter`（`src/index.ts` 保留 `@deprecated AntigravityBridgeAdapter`）；移除动态 `import('./models.js')`；`inputModalities` 随 `imageInput` 动态收口；`dumpRequestsTo` 改用异步非阻塞写盘（`node:fs/promises`）。 |
| **移动/修复** | `src/account-service.ts` (206 行) | `src/dsh/account-service.ts` | 清理未使用的 `logger` 字段；`registerAccountAccess` 复用 `src/dsh/rpc.ts` 完整回收 fiber。 |
| **移动/修复** | `src/log-service.ts` (226 行) | `src/dsh/log-service.ts` | `registerLogAccess` 复用 `src/dsh/rpc.ts`（完整回收 disposer + 按 `D-002` 挂载 loopback 守卫）；`stat` 直接复用 `logger.stat()` 避免重复读盘。 |
| **移动** | `src/commands.ts` (174 行) | `src/dsh/commands.ts` | 迁移至 `src/dsh/`。 |
| **移动** | `src/prompt-compat.ts` (89 行) | `src/dsh/prompt-compat.ts` | 迁移至 `src/dsh/`。 |
| **重构** | `src/index.ts` (284 行) | `src/index.ts` | 收敛为薄装配层：在 `ctx.effect` 中补充 `() => auth.cancelLogin()`；`registerModelDiscovery` 的 `inputModalities` 跟随 `cfg.imageInput`；按 `D-001` 收口根导出并保留 `@deprecated` `Bridge*` 兼容别名。 |

### 2.2 前端、测试与工程文件规划

| 文件 | 动作 | 说明 |
|---|---|---|
| `client.js` | 修改 | 顶部补齐 `// @ts-check` 与 JSDoc（`D-003`）；`<style id="agw-styles">` 去重；`LogPanel` 对齐 `loopback-required` 错误提示（`D-002`）。 |
| `package.json` | 修改 | 修复 `test` 脚本确保运行最新编译产物（区分 `test:only` 与 `test`，兼容 Windows/Linux）；新增 `typecheck:client` 并纳入 `typecheck`（`D-003`）；保持 `dependencies` 仅 `undici`、`exports`/`files`/`dsh` 契约不变。 |
| `tsconfig.client.json` | 新建 | 供 `tsc -p tsconfig.client.json --noEmit` 专检 `client.js`（`allowJs` + `checkJs` + `noEmit`）。 |
| `tests/*.test.mjs`（原有 11 个） | 修改/扩展 | 导入路径随分层同步更新；按 `D-001` 更新命名并补充并发、排序、有界池、SSE abort 耗时、原子写盘、导入/metadata 等回归测试。 |
| `tests/prompt-compat.test.mjs` | 新建 | Phase 2 特征测试（`P2-001` 先行建立）。 |
| `tests/commands.test.mjs` | 新建 | Phase 2 特征测试（`P2-001` 先行建立）。 |
| `tests/log-service.test.mjs` | 新建 | Phase 2 特征测试（`P2-001` 先行建立），Phase 3 补充 loopback 与 disposer 校验。 |
| `tests/index.test.mjs` | 新建 | Phase 2 特征测试（`P2-001` 先行建立），Phase 3 补充 `cancelLogin()` 卸载验证。 |
| `tests/architecture.test.mjs` | 新建 | Phase 2 静态扫描 `src/` 导入图，强制校验第 1.2 节五条依赖红线与无循环依赖。 |
| `tests/client-contract.test.mjs` | 新建 | Phase 3 验证 `client.js` 加载健壮性（mock `window.__ModuleLoader__` + mock `React`）与 `rpc-contracts.ts` 100% 一致性。 |
| `.editorconfig`、`.github/ISSUE_TEMPLATE/*`、`.github/PULL_REQUEST_TEMPLATE.md`、`CONTRIBUTING.md`、`SECURITY.md` | 新建 | Phase 4 GitHub 开源协作基建（轻量、贴合本项目体量）。 |
| `.github/workflows/ci.yml` / `release.yml` | 审查/微调 | Phase 4 加固（不触发真实发布，补充 client typecheck / pack 校验等，遵循最小权限）。 |
| `TECHNICAL.md`、`TECHNICAL.us.md`、`README.md`、`README.us.md`、`AGENTS.md` | 修改 | 按 `D-005` 修正失效相对路径、测试数量（106+）、四层模块映射、3 类变更 Playbooks 及收敛 `AGENTS.md`。 |

---

## 3. 分阶段实施任务表（P2 ~ P5）

> 注：Phase 0 (`P0-001`~`P0-004`) 已 `DONE`；Phase 1 (`P1-001`, `P1-002`) 已 `DONE`，当前处于 `P1-003` 审批门禁。
> 获批后建议创建独立分支 `refactor/modular-architecture`，按任务粒度小批次提交；每步完成后必须跑通对应验证并更新 `PROGRESS.md`。

| ID | 目标 | 依赖 | 涉及文件 | 验收标准 | 验证命令 | 回滚方式 |
|---|---|---|---|---|---|---|
| **P2-001** | 修复测试脚本并建立 0 覆盖模块特征测试 | P1-003 | `package.json`, `tests/{prompt-compat,commands,log-service,index}.test.mjs` | 默认 `npm test` 不会静默运行旧 `lib/`；4 个零覆盖模块建立基于当前行为的特征测试并全部通过 | `npm run typecheck && npm test` | `git revert <sha>` |
| **P2-002** | 建立 `src/shared/` 共享层 | P2-001 | `src/shared/{errors,guards,fs-atomic,rpc-contracts}.ts` | `shared` 零内部/宿主依赖；`Bridge*` 别名按 `D-001` 保留 | `npm run typecheck && npm run build && npm test` | `git revert <sha>` |
| **P2-003** | 迁移并拆分 `src/protocol/` 纯协议层 | P2-002 | `src/protocol/*.ts` | `protocol` 零 `@deepseek-ai/*`/`undici`/`fs`/`http`/`child_process` 依赖；消除 `buildRequestMetadata` 重复 `resolveRoute` | `npm run typecheck && npm run build && npm test` | `git revert <sha>` |
| **P2-004** | 新增 CI 架构守卫测试 | P2-003 | `tests/architecture.test.mjs` | 静态扫描 `src/` 所有模块导入边，拦截违背依赖红线与环依赖 | `npm test` | `git revert <sha>` |
| **P2-005** | 迁移并拆解 `src/core/` 核心服务层 | P2-004 | `src/core/transport/*.ts`, `src/core/{credentials,oauth,auth,catalog,logger}.ts`, `tests/{oauth,auth,catalog}.test.mjs` | `core` 零 `@deepseek-ai/*` 依赖；补齐 `importFromAntigravityAuth` 与 `discoverAccountMetadata` 单测 | `npm run typecheck && npm run build && npm test` | `git revert <sha>` |
| **P2-006** | 建立 `src/dsh/` 适配层、薄入口 `src/index.ts` 并删除旧扁平文件 | P2-005 | `src/dsh/*.ts`, `src/index.ts`, 删除旧 `src/*.ts`（除 `index.ts`）, 更新 `tests/*.test.mjs` | 旧扁平文件无残留引用；`architecture.test.mjs` 全绿；100% 既有特征与单测通过 | `npm run typecheck && npm run build && npm test` | `git revert <sha>` |
| **P3-001** | P0 缺陷闭环（生命周期、RPC 安全与 disposer、刷新取消解耦） | P2-006 | `src/index.ts`, `src/dsh/{rpc,account-service,log-service}.ts`, `src/core/auth.ts`, `tests/{index,log-service,account-service,auth}.test.mjs` | 插件卸载自动 `cancelLogin()`；`registerLogAccess`/`registerAccountAccess` 完整释放 fiber 与路由；`log-service` 按 `D-002` 守卫；`getCredential` 并发 caller 取消互不干扰；全配回归测试 | `npm run typecheck && npm run build && npm test` | `git revert <sha>` |
| **P3-002** | P1 缺陷闭环（Catalog 单飞/保序、Transport 有界池、SSE abort 立即返回、原子写盘） | P3-001 | `src/core/catalog.ts`, `src/core/transport/{http-client,sse}.ts`, `src/core/credentials.ts`, `tests/{catalog,transport,credentials}.test.mjs` | `fetchLiveState` single-flight；缓存/磁盘恢复严格保留 `agentOrder` 顺序无签名抖动；`Dispatcher` 池切换/关闭零泄漏；`iterateSse` abort 毫秒级退出；并发写盘无 `.tmp` 竞争 | `npm run typecheck && npm run build && npm test` | `git revert <sha>` |
| **P3-003** | P2 细节与流式边界加固 | P3-002 | `src/dsh/{adapter,stream-assembler}.ts`, `src/index.ts`, `tests/adapter.test.mjs` | 清理动态 `import('./models.js')`；`inputModalities` 随 `imageInput` 收口；`dumpRequestsTo` 异步非阻塞；补充流式错误事件、中断、503 退避、部分输出不重试、多轮工具与思考签名回放集成测试 | `npm run typecheck && npm run build && npm test` | `git revert <sha>` |
| **P3-004** | `client.js` 治理与前后端契约测试 | P3-001 | `client.js`, `tsconfig.client.json`, `package.json`, `tests/client-contract.test.mjs` | 按 `D-003` 通过 `typecheck:client`；`<style id="agw-styles">` 去重；`LogPanel` 处理 `loopback-required`；契约测试验证安全加载与 100% RPC 对齐 | `npm run typecheck && npm test` | `git revert <sha>` |
| **P4-001** | 工具链与质量门禁统一 | P3-004 | `package.json`, `.gitignore` | `typecheck` 含 `client.js`；`test` 与 `test:only` 明确；确认 `.npm-cache/` 与 `lib/` 不入打包产物 | `npm run typecheck && npm run build && npm test` | `git revert <sha>` |
| **P4-002** | CI/CD 工作流审查与加固 | P4-001 | `.github/workflows/{ci,release}.yml` | 锁 `npm ci`、最小权限、clean-tree 检查、打包产物验证（含 `typecheck` 与 `release-check`）；不触碰正式 Release 触发 | YAML 语法检查与本地脚本干跑 | `git revert <sha>` |
| **P4-003** | GitHub 开源治理基建 | P4-001 | `.editorconfig`, `.github/{ISSUE_TEMPLATE/*,PULL_REQUEST_TEMPLATE.md}`, `CONTRIBUTING.md`, `SECURITY.md` | 轻量实用，无噪音配置；不改版本号/LICENSE | 人工审查文件完整性 | `git revert <sha>` |
| **P4-004** | 按 `D-005` 同步更新项目文档 | P4-001 | `TECHNICAL.md`, `TECHNICAL.us.md`, `README.md`, `README.us.md` | 修复 `../src/` 失效链接与测试计数；同步四层结构、3 类变更 Playbooks、兼容性说明与脱敏排查指引 | 链接与路径校验脚本 + `release-check.mjs --tag v0.1.0` | `git revert <sha>` |
| **P4-005** | 收敛根目录 `AGENTS.md` | P4-004 | `AGENTS.md` | 保留面向长期维护的精简章节（环境、四层规则、命令、落点、红线、Git 约定），并在 Phase 5 归档临时重构指令 | 核对所有内部链接真实存在 | `git revert <sha>` |
| **P5-001** | 全量验证与本地打包干跑 | P4-005 | （无源码改动；清理临时 `.tgz`） | `typecheck`、`build`、`test`（含架构/契约/集成）、`pack:local` + `release-check.mjs` 全绿，工作树干净 | `npm run typecheck && npm run build && npm test && npm run pack:local` | 删除临时 `.tgz` |
| **P5-002** | 兼容性与安全红线逐项复核 | P5-001 | `docs/refactoring/REPORT.md` | 确认线缆协议、DSH 插件契约、凭据/配置格式、脱敏日志、loopback 守卫全部满足 | 人工核查 diff + 架构/契约测试 | — |
| **P5-003** | 交付 `REPORT.md` 与终态更新 | P5-002 | `docs/refactoring/REPORT.md`, `docs/refactoring/PROGRESS.md`, `AGENTS.md` | 完整交付报告、人工真实环境 E2E 清单与残余风险披露 | `git status` 检查 | — |

---

## 4. 兼容性、安全与跨平台测试保障策略

1. **线缆协议零漂移**：`constants.ts`、`models.ts`、`payload.ts`、`response.ts` 迁移期间，除消除 `buildRequestMetadata` 重复 `resolveRoute` 外不修改任何序列化字段序、枚举、Sentinel 或 PKCE 参数；通过 `tests/{models,payload,schema,response,adapter}.test.mjs` 逐字段锁定。
2. **凭据与配置向后兼容**：`CredentialStore` 保持记录键 `dsh-antigravity-gateway/google-account` 与 `credential.json` 形状不变（`D-004`）；`Config` 字段名、默认值及 `cordis.patch.yml` 保持 100% 不变；`src/index.ts` 在 `0.x` 保留 `@deprecated Bridge*` 导出别名（`D-001`）。
3. **跨平台构建与测试脚本注意事项**：
   - `package.json` 的 `npm test` 需先确保编译最新 `lib/`（例如 `"test": "npm run build && npm run test:only"`，其中 `"test:only": "node --test tests/*.test.mjs"` 或跨平台测试列举），兼容 Windows `cmd.exe` 与 Linux `bash`。
   - 受限于 DSH Windows `workspace-write` 沙箱对 `node --test` 子进程管道的 `spawn EPERM` 策略限制，本地代理在该受限环境中执行 `npm test` 时按沙箱规则申请一次权限或使用不改变 CI 行为的方式校验；CI 保持标准 `npm test`。
4. **回滚控制**：每项任务完成后独立提交至重构分支，发现任何回归立即以 `git revert` 精确回退该批次；严禁未授权执行 `git reset --hard`、`git clean -fd` 或修改 `package.json` 版本号。
