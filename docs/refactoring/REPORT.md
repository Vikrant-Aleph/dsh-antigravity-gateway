# dsh-antigravity-gateway 系统性重构验收报告（REPORT）

> **重构分支**：`refactor/modular-architecture`
> **基准提交**：`aedfa19f7bafd5f6a70c40a00c57b4f7fc5536f8`（`v0.1.0`）
> **完成时间**：2026-11-26 02:20 +08:00
> **授权与范围**：用户批准 [PLAN.md](PLAN.md) 与 [DECISIONS.md](DECISIONS.md)（`D-001`~`D-007`），完成 Phase 0 ~ Phase 5 全部任务。未修改版本号、未触碰 `LICENSE`、未执行任何远程推送或发布操作。

---

## 1. 执行摘要

本次系统性重构在 **100% 保留原有线缆协议、DSH 插件契约、凭据/配置数据格式及现有功能** 的前提下，将原扁平堆放的 17 个 `src/*.ts`（约 5,256 行）重构为四层单向依赖架构（`shared` ← `protocol` ← `core` ← `dsh` ← `index`），修复了审计确认的全部 P0/P1/P2 缺陷（含审计新发现的 `iterateSse` 中止挂起 3 分钟问题与 `release-check.mjs` 在 Windows `tar` CRLF 下的兼容问题），补齐了全部 0 覆盖模块的离线测试与架构/契约守卫测试，并完善了工具链、CI/CD、GitHub 开源协作配置与双语维护文档。

- **计划任务完成度**：Phase 0 ~ Phase 5 共 23 项任务（`P0-001`~`P5-003`）**全部 `DONE`**，无 `BLOCKED` 或 `DEFERRED` 项。
- **验证规模跃升**：离线测试由基线 **11 文件 / 106 用例（耗时 ~5,313ms）** 提升至 **18 文件 / 145 用例（经独立审查修复后全量通过，耗时 ~505ms）**；新增严格 `client.js` 类型检查（`tsconfig.client.json`）与本地 `npm pack` + `release-check.mjs` 跨平台产物校验。

> **独立审查修复记录**：[REVIEW.md](REVIEW.md) 提出的 `P1-01` 与 `P2-01`~`P2-08` 已全部核实并记录于 [FIXES.md](FIXES.md)（`FIX-001`~`FIX-009` 全部闭环，测试覆盖由 137 项增至 **145 项**）。

---

## 2. 架构演进与关键决策落地情况

### 2.1 四层架构对比

- **重构前**：17 个扁平文件堆放在 `src/` 下，协议构造（`payload.ts` 641 行）、目录解析与缓存（`catalog.ts` 745 行）、DSH 流状态机与适配器（`adapter.ts` 591 行）、传输与代理（`transport.ts` 431 行）职责交织；`src/index.ts` 全量 `export *` 并手写 21 字段重复配置类型。
- **重构后**：
  - `src/shared/`（4 文件）：零内部/宿主依赖——`errors.ts`、`guards.ts`、`fs-atomic.ts`、`rpc-contracts.ts`。
  - `src/protocol/`（7 文件）：纯协议层——`constants.ts`、`models.ts`、`session-metadata.ts`、`schema-sanitizer.ts`、`payload.ts`、`response.ts`、`catalog-parser.ts`（AST 强制禁止 `@deepseek-ai/*`、`undici`、`fs`/`http`/`net`/`child_process`/`fs-atomic`）。
  - `src/core/`（9 文件）：运行时核心——`transport/{proxy,http-client,sse,index}.ts`、`credentials.ts`、`oauth.ts`、`auth.ts`、`catalog.ts`、`logger.ts`（AST 强制禁止 `@deepseek-ai/*` 与 `src/dsh/`）。
  - `src/dsh/`（9 文件）：唯一允许导入 `@deepseek-ai/*` 的宿主适配层——`types.ts`、`config.ts`、`rpc.ts`、`stream-assembler.ts`、`adapter.ts`、`account-service.ts`、`log-service.ts`、`commands.ts`、`prompt-compat.ts`。
  - `src/index.ts`：薄装配入口（Config 绑定、`ctx.effect` 生命周期绑定、受控导出）。

### 2.2 关键决策落地核查（`D-001` ~ `D-007`）

| 决策 ID | 议题 | 最终落地状态 |
|---|---|---|
| **D-001** | `Bridge*` 命名与导出收口 | 内部全面统一为 `Gateway*`（`GatewayError`、`AntigravityGatewayAdapter` 等），[src/index.ts](../../src/index.ts) 保留 `@deprecated` `Bridge*` 别名并收窄非公共符号导出；[tests/index.test.mjs](../../tests/index.test.mjs) 验证别名等价。 |
| **D-002** | 日志 RPC 安全策略 | `/api/antigravity-gateway-logs/*` 经 [src/dsh/rpc.ts](../../src/dsh/rpc.ts) 统一挂载 `127.0.0.1` loopback 守卫；[client.js](../../client.js) `LogPanel` 对齐 `loopback-required` 提示；[tests/log-service.test.mjs](../../tests/log-service.test.mjs) 回归验证通过。 |
| **D-003** | `client.js` 长期维护形态 | 保持零 bundler 交付，增加 `// @ts-check` + JSDoc 与 [tsconfig.client.json](../../tsconfig.client.json)（纳入 `npm run typecheck`），新增 `<style id="agw-styles">` 引用计数去重与 [tests/client-contract.test.mjs](../../tests/client-contract.test.mjs)。 |
| **D-004** | 多账号扩展边界 | 严格冻结多账号功能与 UI，凭据存储键与 `credential.json` 格式 100% 不变，所有管理器无全局单例。 |
| **D-005** | 技术文档布局 | 保持并更新双语 [TECHNICAL.md](../../TECHNICAL.md) / [TECHNICAL.us.md](../../TECHNICAL.us.md) 为唯一技术权威（修复全部失效 `../src/` 路径，补全四层架构、3 类演进剧本与排障）；不建重叠副本。 |
| **D-006** | `iterateSse` 中止挂起 | 在 [src/core/transport/sse.ts](../../src/core/transport/sse.ts) 让 `withIdleTimeout` 竞态监听 `AbortSignal`，中止响应从 `idleTimeoutMs`（180s）降至毫秒级（测试从 5007ms 降至 ~30ms）。 |
| **D-007** | Lint/格式化工具评估 | 不引入额外 npm 包与 `package-lock.json` 噪音，采用严格 `tsc` + `checkJs` + AST 架构测试 + `.editorconfig` 门禁。 |

---

## 3. 文件变更总览

- **新增源码（29 个模块化文件分布于四层）**：`src/shared/{errors,guards,fs-atomic,rpc-contracts}.ts`、`src/protocol/{constants,models,session-metadata,schema-sanitizer,payload,response,catalog-parser}.ts`、`src/core/{logger,credentials,oauth,auth,catalog}.ts`、`src/core/transport/{proxy,http-client,sse,index}.ts`、`src/dsh/{types,config,rpc,stream-assembler,adapter,account-service,log-service,commands,prompt-compat}.ts`；重构收敛 `src/index.ts`。
- **删除旧扁平文件（16 个）**：`src/{account-service,adapter,auth,catalog,commands,constants,credentials,errors,log-service,logger,models,oauth,payload,prompt-compat,response,transport}.ts`（已在 Git 中清理干净）。
- **新增测试文件（7 个）**：`tests/{prompt-compat,commands,log-service,index,architecture,auth,client-contract}.test.mjs`；更新并扩展原有 11 个测试文件。
- **工程与前端配置**：修改 `client.js`、`package.json`、`scripts/release-check.mjs`、`.github/workflows/{ci,release}.yml`；新增 `tsconfig.client.json`、`.editorconfig`、`.github/ISSUE_TEMPLATE/{config,bug_report,upstream_protocol_drift,compatibility}.yml`、`.github/PULL_REQUEST_TEMPLATE.md`、`CONTRIBUTING.md`、`SECURITY.md`。
- **文档**：更新 `AGENTS.md`、`TECHNICAL.md`、`TECHNICAL.us.md`、`README.md`、`README.us.md`；沉淀 `docs/refactoring/{AUDIT,PLAN,PROGRESS,DECISIONS,REPORT}.md`。

---

## 4. 缺陷与技术债闭环表

| 审计编号 | 级别 | 问题描述 | 修复落地与位置 | 回归测试路径 |
|---|---|---|---|---|
| **AUD-P0-01** | P0 | `apply()` 卸载未调用 `auth.cancelLogin()` 泄漏 51121 端口 | [src/index.ts](../../src/index.ts) `ctx.effect(() => () => auth.cancelLogin())` | [tests/index.test.mjs](../../tests/index.test.mjs) |
| **AUD-P0-02** | P0 | `registerLogAccess` 丢弃 disposer/fiber 且无 loopback 守卫 | [src/dsh/rpc.ts](../../src/dsh/rpc.ts) + [src/dsh/log-service.ts](../../src/dsh/log-service.ts) 统一回收并启用 `requireLoopback: true` | [tests/log-service.test.mjs](../../tests/log-service.test.mjs) |
| **AUD-P0-03** | P0 | `AuthManager.getCredential(signal)` 并发取消耦合 | [src/core/auth.ts](../../src/core/auth.ts) 独立内部 refresh 生命周期 + `raceWithAbort` | [tests/auth.test.mjs](../../tests/auth.test.mjs) |
| **AUD-P1-01** | P1 | `iterateSse` 在阻塞读时忽略 `AbortSignal` 挂起 `idleTimeoutMs` | [src/core/transport/sse.ts](../../src/core/transport/sse.ts) `withIdleTimeout` 竞态监听 `signal` | [tests/transport.test.mjs](../../tests/transport.test.mjs) |
| **AUD-P1-02** | P1 | `ModelCatalog` 缺失 single-flight、缓存/磁盘恢复丢顺序、硬编码端点 | [src/core/catalog.ts](../../src/core/catalog.ts) `inFlightFetches` + 代数计数 + 保序映射 + `ANTIGRAVITY_ENDPOINT_FALLBACKS` | [tests/catalog.test.mjs](../../tests/catalog.test.mjs) |
| **AUD-P1-03** | P1 | `AgyTransport` 切换代理时未关闭旧 `Dispatcher` | [src/core/transport/http-client.ts](../../src/core/transport/http-client.ts) 有界 LRU `Map` 池 + 淘汰/卸载全量 `close()` | [tests/transport.test.mjs](../../tests/transport.test.mjs) |
| **AUD-P1-04** | P1 | `credentials`/`catalog` 固定 `.tmp` 写盘竞争 | [src/shared/fs-atomic.ts](../../src/shared/fs-atomic.ts) `writeFileAtomicSync`（PID+UUID 唯一临时文件与失败清理） | [tests/credentials.test.mjs](../../tests/credentials.test.mjs) |
| **AUD-P1-05** | P1 | `registerAccountAccess` 丢弃 `ctx.inject` fiber | [src/dsh/rpc.ts](../../src/dsh/rpc.ts) 追踪并调用 `fiber?.dispose?.()` | [tests/account-service.test.mjs](../../tests/account-service.test.mjs) |
| **AUD-P1-06** | P1 | `npm test` 静默测试过期 `lib/` | [package.json](../../package.json) 区分 `test:only` 与先构建的 `test`、`verify` | `npm test` 实测 |
| **AUD-P1-07** | P1 | 5 个模块零覆盖 + `auth` 导入/元数据缺测 | 新增 7 个测试文件 + 集成测试扩展 | `tests/*.test.mjs` |
| **AUD-P2-01..06** | P2 | 重复 `resolveRoute`/动态导入/`inputModalities`/配置类型手写/样式重复/文档链接失效 | 对应清理于 `session-metadata.ts`、`adapter.ts`、`config.ts`、`client.js`、`TECHNICAL*.md`、`release-check.mjs` | [tests/adapter.test.mjs](../../tests/adapter.test.mjs)、[tests/client-contract.test.mjs](../../tests/client-contract.test.mjs) |

---

## 5. 真实验证记录

| 验证项 | 命令 | 环境 | 退出码 / 结果 |
|---|---|---|---|
| 类型检查（TS + client.js） | `npm run typecheck` | Windows 11 · Node `v24.18.0` | `0`（`tsconfig.json` + `tsconfig.client.json` 零报错） |
| 清理并编译 | `npm run build` | Windows 11 · Node `v24.18.0` | `0`（输出 `lib/`） |
| 全量离线测试 | `npm test` / `npm run verify` | Windows 11 · Node `v24.18.0` | `0`（**18 文件 / 145 用例全部通过**，总耗时 ~505ms） |
| 本地打包与发布身份校验 | `npm run pack:local` + `node scripts/release-check.mjs --tag v0.1.0 --archive-dir .` | Windows 11 · Node `v24.18.0` | `0`（生成 `156.9 kB` / 133 文件的 `.tgz`，`release-check: v0.1.0 identity verified`，随后已清理临时 `.tgz`） |

---

## 6. 兼容性、安全与残余风险

### 6.1 兼容性与安全红线复核
- **协议与数据兼容**：`User-Agent`、`AGY_REQUEST_FIELD_ORDER`、FNV-1a 会话元数据、Claude `VALIDATED`、思考签名回放、OAuth PKCE、`dsh-antigravity-gateway/google-account` 凭据键、`credential.json` / `catalog-cache.json` 格式、`cordis.patch.yml` 及 `Config` 默认值 **100% 保持兼容**；`dependencies` 仍仅含 `undici`。
- **安全边界**：`AccountService` 与 `LogService` 的 `/api` RPC 全部启用 `127.0.0.1` loopback 守卫；日志保持五级脱敏；`client.js` 保持 `apply()` 永不抛错；无 TLS 校验关闭或敏感信息落盘。

### 6.2 未能离线覆盖的项目与人工真实环境 E2E 清单

所有自动化验证均使用本地伪 HTTP 端点与 Mock DSH 上下文完成。发布前或合并至 `main` 后，请在**真实 DSH Desktop 环境**中手工核对以下 6 项：
1. 使用 `npm run pack:local` 生成 `.tgz` 并通过 `dsh plugin --profile desktop add ./dsh-antigravity-gateway-0.1.0.tgz` 安装/覆盖升级，验证现有 `credential.json` 与插件配置平滑保留（无需重新登录）。
2. 在 **Settings → Antigravity Gateway** 验证三个 Tab 渲染、主题样式、中英语言切换，以及 **Diagnostic log** 面板在绑定 `127.0.0.1` 时的读写/清空与非环回绑定下的 `loopback-required` 提示。
3. 执行真实 Google OAuth 登录（及中途取消登录 `/agw cancel`）与 `/agw import`（若装有 `dsh-antigravity-auth`）。
4. 在模型选择器验证可用模型与配额徽标展示，并与至少一个 Claude（含工具调用）及 Gemini 模型完成多轮对话（含思考签名回放与图片附件）。
5. 触发插件重载/禁用，验证 `51121` 回调端口、`antigravity_gateway_log` 工具与 RPC 路由正常释放，再次启用不报错。
6. 检查真机 Windows 系统代理开启与关闭时的请求连通性。

---

## 7. 回滚指引与发布前建议

- **提交粒度与回滚**：`refactor/modular-architecture` 上自 `aedfa19` 起共有按任务拆分的小批次提交（`P2-001` ~ `P5-003`）。若需回退任意单步，可执行 `git revert <commit-sha>`；若需整体放弃本次重构分支，直接切回 `main`（`aedfa19` 保持完全未动）。
- **合并前建议**：按人工 E2E 清单核验无误后，再由维护者决定何时合并至 `main`、提升版本号（如需）及打 Tag 触发 GitHub Release。
