# dsh-antigravity-gateway 全量新需求与 `v0.2.0` 发布前独立验收报告（REVIEW）

> **审查角色**：独立软件架构审查者 / 代码审查者 / 质量验收工程师  
> **审查基准**：`main` @ `3bc93a1`（`tag: v0.2.0`，涵盖四层架构重构、多账号与额度可视化、`client.js` 抛光及 OAuth 公开客户端 Base64 编码与 Git 历史清洗）  
> **审查时间**：2026-11-26  
> **历史修复追踪**：历次修复与验证台账见 [FIXES.md](FIXES.md) 与 [PROGRESS.md](PROGRESS.md)。

---

## 1. 验收结论与发布前条件评估

- **最终结论**：**满足发布前工程与质量条件（Ready for Release / 通过验收）**。
- **核心判断**：
  1. **全部新需求完整落地且符合预期**：
     - **多账号管理与并发故障转移**（[quota-multi-account/SPEC.md](../features/quota-multi-account/SPEC.md)、[account-ui-multi-fix/SPEC.md](../features/account-ui-multi-fix/SPEC.md)）：`CredentialVault` v2（单账号向后兼容 v1）、`aicode-consumers` 共享项目 ID 去重隔离、`id_token` JWT 邮箱兜底、按 `accountKey` 隔离的 `catalog-cache.json` v2、预检与 `429`/流内 `RESOURCE_EXHAUSTED` 并发 CAS 自动切号（保持原模型与思考档位）、`/agw accounts` / `switch` / `logout [all]` 命令与 `switch` RPC 均已实现。
     - **额度可视化与聊天框指示器**（[ui-quota-polish/SPEC.md](../features/ui-quota-polish/SPEC.md)）：设置页账号/模型卡片层次优化、双池进度条与重置倒计时、`conversation.input.right` 紧凑无框 `5h | XX%`（非 `5h` 回退 `quota | XX%`）指示器、`document.body` Portal 悬停浮层（支持 `Escape` 关闭与全量登出即时清空缓存）均已落实。
     - **OAuth 公开客户端标识 Base64 编码与 Git 历史清洗**（[oauth-client-externalization/SPEC.md](../features/oauth-client-externalization/SPEC.md)）：`src/protocol/constants.ts` 改用 Base64 运行时解码（零新增导入），`src/core/oauth.ts` 支持成对环境变量覆盖并保持零配置一键登录，`src/core/logger.ts` 增加客户端密钥与 `client_secret=` 脱敏，全量 Git 历史经 `git log --all -S` 验证零明文残留。
  2. **独立验证全绿**：在当前工作区独立执行 `npm run verify`（`tsc` + `checkJs` + `build` + **18 个文件 / 157 项离线测试**）、`npm run pack:local`、`node scripts/release-check.mjs --tag v0.2.0 --archive-dir .` 与 `node scripts/release-notes.mjs 0.2.0` **全部通过**（`v0.2.0` 发布包 `188.1 kB` / 133 文件，工作区干净）。
  3. **未发现 P0 或 P1 缺陷**，仅记录 **3 项不影响运行与发版的 P2 文档/防御性细节建议**。
- **发布前说明**：
  - 所有自动化测试均为离线确定性测试（Mock DSH 宿主与本地伪 HTTP 端点）；推送 `main` 与 `v0.2.0` 触发 `release.yml` 前，请确认已在真实 **DSH Desktop** 环境中完成第 5 节人工 E2E 核验清单。

---

## 2. 独立复跑验证结果（实测证据）

| 验证项目 | 执行命令 | 环境与条件 | 实际结果 | 备注 |
|---|---|---|---|---|
| **TypeScript & Client 类型检查** | `npm run typecheck` | Windows 11 · Node `v24.18.0` | **PASS (`exit 0`)** | `tsconfig.json` 与 `tsconfig.client.json`（`checkJs` + `strict`）零错误 |
| **清理并编译** | `npm run build` | 同上 | **PASS (`exit 0`)** | `scripts/clean.mjs` + `tsc -p tsconfig.json` |
| **全量离线测试** | `npm run verify` | 同上 | **PASS (`exit 0`)** | **18 文件 / 157 用例全部通过**（~524ms），含防明文泄漏扫描与架构守卫 |
| **本地打包与发布身份校验** | `npm run pack:local` + `node scripts/release-check.mjs --tag v0.2.0 --archive-dir .` | 同上 | **PASS (`exit 0`)** | 产出 `188.1 kB` / 133 文件 `.tgz`，`release-check: v0.2.0 identity verified`，随后已清理临时 `.tgz` |
| **Release Notes 提取校验** | `node scripts/release-notes.mjs 0.2.0 --out <tmp>` | 同上 | **PASS (`exit 0`)** | 从 `CHANGELOG.md` 精确提取 3,507 字符 `0.2.0` 发布说明 |
| **Git 全历史明文残留扫描** | `git log --all -S <secret/id prefix>` | `main` @ `3bc93a1` (`tag: v0.2.0`) | **PASS（0 匹配）** | 全分支历史提交均无明文 OAuth client secret 或完整 client ID |
| **代码规模与工作区核对** | `git status` / 行数统计 | `main` @ `3bc93a1` | **干净** | `src/` 30 文件 6,671 行、`tests/` 18 文件 4,665 行、`client.js` 1,326 行；无未提交修改 |

---

## 3. 十四项审查维度逐项验收结论

| # | 审查维度 | 结论 | 实证摘要 |
|---|---|---|---|
| **1/2** | **功能需求、更新日志与技术文档符合度** | **满足** | [CHANGELOG.md](../../CHANGELOG.md) 已将变更整理为 `## [0.2.0] - 2026-11-26`，`package.json`/`package-lock.json`/`README*.md`/`TECHNICAL*.md` 版本与 `157` 测试数一致；新功能均满足对应 `SPEC.md`。 |
| **3** | **功能退化或兼容性** | **无退化** | 单账号 v1 `credential.json`、`catalog-cache.json` v1、Antigravity 线缆协议（Base64 运行时解码值与原值一致）、零配置浏览器登录及 `@deprecated Bridge*` 导出保持向后兼容；此前发现的 `slots.register` `this` 丢失与全量登出残留配额均已闭环修复。 |
| **4** | **模块职责与依赖方向** | **满足** | `tests/architecture.test.mjs` 通过，`src/protocol/constants.ts` 仅使用全局 `Buffer` 进行 Base64 解码，未引入违禁依赖，严守 `shared ← protocol ← core ← dsh ← index` 单向边。 |
| **5** | **DSH 与 Antigravity 隔离** | **满足** | `@deepseek-ai/*` 仅位于 `src/dsh/`；`client.js` 通过 `ctx.inject(['slots', 'modelDirectories'], ...)` 软依赖隔离聊天框插槽。 |
| **6** | **过度工程化评估** | **克制合理** | `dependencies` 仅保留 `undici`；未因 OAuth 外部化引入设置页表单、Config 字段或新 RPC，保持零配置开箱即用体验。 |
| **7** | **安全性、凭据、并发与资源管理** | **可靠** | `CredentialStore` 通过 `withWriteLock` 与 `writeFileAtomicSync`（`0600`）串行写盘；`AuthManager` 按 `accountId` 隔离 `refreshInFlightByAccount` 与 `accountGenerations`；Account/Log RPC 动态挂载 `127.0.0.1` loopback 守卫；`PluginLogger` 增加 Google OAuth client secret 与 `client_secret=` 脱敏；全仓与 Git 历史零明文客户端密钥与个人本地路径。 |
| **8** | **流式响应、认证、错误处理、取消与超时** | **可靠** | `iterateSse` 与 `readBoundedText` 均竞态监听 `AbortSignal`；`getCredential` 解除 caller abort 耦合；`autoSwitchAccount` 仅在 `!hasEmitted.value && !signal?.aborted` 时通过 CAS 切号重试并限制每账号单次尝试。 |
| **9** | **测试真实有效性** | **扎实** | 18 个测试文件 / 157 项离线测试全面覆盖协议、并发切号、v1→v2 迁移、`aicode-consumers` 隔离、`id_token` 兜底、环境变量覆盖、防明文泄漏全仓扫描、日志脱敏与 `client.js` 状态化 Hook + Portal 行为。 |
| **10** | **CI/CD、构建与插件打包流程** | **合理可靠** | `ci.yml` 与 `release.yml` 门禁严谨，`npm run pack:local` + `release-check.mjs --tag v0.2.0` 实测通过且拦截 `docs/refactoring/` 与 `docs/features/` 进入发行产物。 |
| **11** | **文档与真实实现一致性** | **基本一致（有 2 项微小状态文本滞后）** | 主文档（`README*.md`、`TECHNICAL*.md`、`CHANGELOG.md`）与源码及 `157` 测试完全同步；仅 `oauth-client-externalization/SPEC.md`/`PLAN.md` 头部阶段文本及 `AGENTS.md` 示例 tag 仍为旧状态（见 **P2-01**、**P2-02**）。 |
| **12** | **废弃代码、临时文件与无用依赖** | **干净** | 无废弃文件、无多余依赖、无未清理的 `.tgz`；工作区根目录 `.npm-cache/` 系 2026-11-22 遗留缓存，已被 `.gitignore` 忽略且不入打包产物。 |
| **13** | **误标 `DONE` 的未完成任务** | **无** | `PROGRESS.md` 与 `docs/features/*/PROGRESS.md` 中所有标记 `DONE` 的任务均可在真实代码与测试输出中独立印证。 |
| **14** | **长期维护与扩展能力** | **良好** | 四层架构、AST 守卫、前后端 RPC 契约测试、全仓防泄漏扫描与双语演进手册完备，支持长期稳定演进。 |

---

## 4. 分级审查发现

> 本轮独立验收**未发现 P0 或 P1 问题**。以下仅列出 3 项不影响发布与运行时的 P2 优化建议：

### P0：严重问题（必须修复）
- **无**。

### P1：重要问题（建议在发布前修复）
- **无**。

### P2：一般维护性问题（可后续顺手优化）

#### [P2-01] `oauth-client-externalization` 设计文档的阶段标记未随 `PROGRESS.md` 同步收敛
- **代码位置**：[docs/features/oauth-client-externalization/SPEC.md:4-5](../features/oauth-client-externalization/SPEC.md#L4-L5)、[docs/features/oauth-client-externalization/PLAN.md:4, 60-64](../features/oauth-client-externalization/PLAN.md#L60-L64)
- **问题原因**：功能已全部实施并合并至 `main`（`O-001`~`O-006` 在 `PROGRESS.md` 中均为 `DONE`），但 `SPEC.md` 头部仍标注「第一阶段（需求更新，待专人确认并实施）」，`PLAN.md` 任务表仍为 `WAITING`/`TODO`。
- **影响范围**：仅影响阅读过程文档时的状态直观性，不影响源码与发行包。
- **修复建议**：将 `SPEC.md` 头部更新为「已实施验收（`v0.2.0`）」，或将 `PLAN.md` 任务表同步为 `DONE`。

#### [P2-02] `AGENTS.md` 中的示例 `release-check.mjs` 命令仍沿用 `--tag v0.1.0`
- **代码位置**：[AGENTS.md:47](../../AGENTS.md#L47)
- **问题原因**：示例命令写为 `node scripts/release-check.mjs --tag v0.1.0`，当前包版本已升至 `0.2.0`。
- **影响范围**：仅作为命令行示例参考（CI/Release 工作流均自动读取 `package.json` 或 `$RELEASE_TAG`）。
- **修复建议**：后续更新文档时可改为 `--tag v0.2.0` 或 `--tag v<X.Y.Z>` 占位形式。

#### [P2-03] `PluginLogger` 对 OAuth Client Secret 形态正则使用前置词边界 `\b`
- **代码位置**：[src/core/logger.ts:45, 122-123](../../src/core/logger.ts#L45)
- **问题原因**：`GOOGLE_CLIENT_SECRET_PATTERN` 使用 `\b` 前置词边界，可覆盖空格、引号、`=`、`:` 等常见分隔符，但紧邻下划线 `_` 时 `\b` 不会触发；此外若通过环境变量 `ANTIGRAVITY_OAUTH_CLIENT_SECRET` 覆盖为非标准前缀密钥，仅依赖 `client_secret=` 表单脱敏规则。
- **影响范围**：极低概率边界情况（当前内部所有报错与日志均不直接打印客户端密钥）。
- **修复建议**：后续可将 `oauth.ts` 解析出的自定义环境变量密钥一并注入 `PluginLoggerOptions.secrets`，并将 `\b` 前置边界放宽为 `(?<![A-Za-z0-9-])`。

---

## 5. 发布前最终核验清单（人工 E2E 边界）

在执行 `git push origin main v0.2.0` 触发 GitHub Release 前，建议在真实 **DSH Desktop** 环境中确认以下事项：
1. 使用 `npm run pack:local` 生成 `dsh-antigravity-gateway-0.2.0.tgz` 安装/覆盖升级（测试后删除本地 `.tgz`），验证旧版 `credential.json` 平滑保留。
2. 验证零配置点击 **使用 Google 登录** 可正常拉起浏览器完成 OAuth 授权（`constants.ts` Base64 解码与回调流程无回归）。
3. 登录第 2 个共享 `aicode-consumers` 的 Google 账号，确认设置 → 账号列表独立保留、可切换/移除，且全部登出后聊天框徽标即时回退 `5h | --`。
4. 验证设置 → 模型配额进度条、聊天框模型名左侧 `5h | XX%` 对齐与 `Escape`/悬停浮层，以及配额耗尽时的自动切号行为。
