# dsh-antigravity-gateway 全量新需求与 `v0.2.0` 发布前独立验收报告（REVIEW）

> **审查角色**：独立软件架构审查者 / 代码审查者 / 质量验收工程师  
> **审查基准**：`main` @ `8ee2879`（`tag: v0.2.0`，涵盖四层架构重构、多账号与额度可视化、`client.js` 抛光、`FIX-016`~`FIX-018` 收敛，以及 OAuth 公开客户端 XOR 字节掩码编码与全量 Git 历史清洗）  
> **审查时间**：2026-11-26  
> **历史修复追踪**：历次修复与验证台账见 [FIXES.md](FIXES.md) 与 [PROGRESS.md](PROGRESS.md)。

---

## 1. 验收结论与发布前条件评估

- **最终结论**：**通过验收，完全满足发布前条件（Ready for Release）**。
- **核心判断**：
  1. **全部新需求完整落地且符合文档与契约**：
     - **多账号管理与并发故障转移**（[quota-multi-account/SPEC.md](../features/quota-multi-account/SPEC.md)、[account-ui-multi-fix/SPEC.md](../features/account-ui-multi-fix/SPEC.md)）：`CredentialVault` v2（单账号向后兼容 v1）、`aicode-consumers` 共享项目 ID 去重隔离、`id_token` JWT 邮箱兜底、按 `accountKey` 隔离的 `catalog-cache.json` v2、预检与 `429`/流内 `RESOURCE_EXHAUSTED` 并发 CAS 自动切号（保持原模型与思考档位）、`/agw accounts` / `switch` / `logout [all]` 命令与 `switch` RPC 均已实现。
     - **额度可视化与聊天框指示器**（[ui-quota-polish/SPEC.md](../features/ui-quota-polish/SPEC.md)）：设置页账号/模型卡片层次优化、双池进度条与重置倒计时、`conversation.input.right` 紧凑无框 `5h | XX%`（非 `5h` 回退 `quota | XX%`）指示器、`document.body` Portal 悬停浮层（支持 `Escape` 关闭与全量登出即时清空缓存）均已落实。
     - **OAuth 公开客户端 XOR 字节掩码编码与全历史清洗**（[oauth-client-externalization/SPEC.md](../features/oauth-client-externalization/SPEC.md)）：[src/protocol/constants.ts](../../src/protocol/constants.ts) 改用 `Uint8Array` + `TextDecoder` 对 XOR 掩码字节数组运行时解码（无明文、无单段 Base64、零违禁导入）；[src/core/oauth.ts](../../src/core/oauth.ts) 支持成对环境变量覆盖并保持零配置一键登录；[src/core/logger.ts](../../src/core/logger.ts) 与 [src/index.ts](../../src/index.ts) 放宽 secret 正则前置边界并将自定义 OAuth `clientSecret` 注入日志脱敏表；`git log --all -S` 实测全分支历史对明文与 Base64 特征均 **0 命中**。
  2. **独立验证全绿**：在当前工作区独立执行 `npm run verify`（`tsc` + `checkJs` + `build` + **18 个文件 / 158 项离线测试**）、`npm run pack:local`、`node scripts/release-check.mjs --tag v0.2.0 --archive-dir .`、`node scripts/release-notes.mjs 0.2.0` 与全仓链接检查 **全部通过**（`v0.2.0` 发布包 `188.7 kB` / 133 文件，断链 `0`）。
  3. **未发现 P0、P1 或未闭环 P2 缺陷**（上一轮 `FIX-016`~`FIX-018` 已全部实证关闭）。
- **发布前说明**：
  - 全部 158 项自动化测试均为离线确定性测试（Mock DSH 宿主与本地伪 HTTP 端点）；执行 `git push -u origin main && git push origin v0.2.0` 触发 `release.yml` 后，建议同步在真实 **DSH Desktop** 环境中完成第 5 节人工 E2E 核验。

---

## 2. 独立复跑验证结果（实测证据）

| 验证项目 | 执行命令 | 环境与条件 | 实际结果 | 备注 |
|---|---|---|---|---|
| **TypeScript & Client 类型检查** | `npm run typecheck` | Windows 11 · Node `v24.18.0` | **PASS (`exit 0`)** | `tsconfig.json` 与 `tsconfig.client.json`（`checkJs` + `strict`）零错误 |
| **清理并编译** | `npm run build` | 同上 | **PASS (`exit 0`)** | `scripts/clean.mjs` + `tsc -p tsconfig.json` |
| **全量离线测试** | `npm run verify` | 同上 | **PASS (`exit 0`)** | **18 文件 / 158 用例全部通过**（~505ms），含明文与单段 Base64 双重防泄漏扫描及 AST 架构守卫 |
| **本地打包与发布身份校验** | `npm run pack:local` + `node scripts/release-check.mjs --tag v0.2.0 --archive-dir .` | 同上 | **PASS (`exit 0`)** | 产出 `188.7 kB` / 133 文件 `.tgz`，`release-check: v0.2.0 identity verified`，随后已清理临时 `.tgz` |
| **Release Notes 提取校验** | `node scripts/release-notes.mjs 0.2.0 --out <tmp>` | 同上 | **PASS (`exit 0`)** | 从 `CHANGELOG.md` 精确提取 3,588 字符 `0.2.0` 发布说明 |
| **Git 全历史与运行时解码校验** | `git log --all -S` + 运行时常量校验 | `main` @ `8ee2879` (`tag: v0.2.0`) | **PASS（0 残留）** | 全分支历史明文特征及 Base64 前缀均 **0 命中**；解码后 Client ID（73 字符 `.apps.googleusercontent.com`）与 Secret（35 字符）格式完整一致 |
| **全仓 Markdown 断链与代码规模核对** | 脚本扫描 + `git status` | `main` @ `8ee2879` | **PASS（0 断链）** | `src/` 30 文件 6,687 行、`tests/` 18 文件 4,709 行、`client.js` 1,326 行；除本 `REVIEW.md` 外工作树干净 |

---

## 3. 十四项审查维度逐项验收结论

| # | 审查维度 | 结论 | 实证摘要 |
|---|---|---|---|
| **1/2** | **功能需求、更新日志与技术文档符合度** | **满足** | [CHANGELOG.md](../../CHANGELOG.md) `## [0.2.0] - 2026-11-26`、[README.md](../../README.md)、[README.us.md](../../README.us.md)、[TECHNICAL.md](../../TECHNICAL.md)、[TECHNICAL.us.md](../../TECHNICAL.us.md)、[AGENTS.md](../../AGENTS.md) 与各功能 `SPEC.md` 均完整同步至 `v0.2.0` / `158` 测试与 XOR 掩码实现。 |
| **3** | **功能退化或兼容性** | **无退化** | 单账号 v1 `credential.json`、`catalog-cache.json` v1、Antigravity 线缆协议（XOR 运行时解码结果与原公开客户端字节级一致）、零配置一键浏览器登录及 `@deprecated Bridge*` 导出均保持向后兼容。 |
| **4** | **模块职责与依赖方向** | **满足** | `tests/architecture.test.mjs` 通过，`src/protocol/constants.ts` 仅使用 ES 标准 `Uint8Array` 与 `TextDecoder`，严守 `shared ← protocol ← core ← dsh ← index` 单向依赖。 |
| **5** | **DSH 与 Antigravity 隔离** | **满足** | `@deepseek-ai/*` 仅位于 `src/dsh/`；`client.js` 通过 `ctx.inject(['slots', 'modelDirectories'], ...)` 软依赖隔离聊天框插槽，不破坏无对话视图的设置页加载。 |
| **6** | **过度工程化评估** | **克制合理** | 运行时仅保留单依赖 `undici`；OAuth 客户端编码方案轻量无副作用，未引入多余配置项、UI 表单或外部构建工具。 |
| **7** | **安全性、凭据、并发与资源管理** | **可靠** | `CredentialStore` 通过 `withWriteLock` 与 `writeFileAtomicSync`（`0600`）串行落盘；`AuthManager` 按 `accountId` 隔离 `refreshInFlightByAccount` 与 `accountGenerations`；Account/Log RPC 动态挂载 `127.0.0.1` loopback 守卫；`PluginLogger` 采用 `(?<![A-Za-z0-9-])` 边界并注入 `resolveOAuthClient().clientSecret` 至 `secrets`；全仓与 Git 全历史零明文及单段 Base64 密钥残留、零个人本地路径。 |
| **8** | **流式响应、认证、错误处理、取消与超时** | **可靠** | `iterateSse` 与 `readBoundedText` 均竞态监听 `AbortSignal`；`getCredential` 解除 caller abort 耦合；`autoSwitchAccount` 仅在 `!hasEmitted.value && !signal?.aborted` 时通过 CAS 切号重试并限制每账号单次尝试。 |
| **9** | **测试真实有效性** | **扎实** | 18 个测试文件 / 158 项离线测试全面覆盖协议、并发切号、v1→v2 迁移、`aicode-consumers` 隔离、`id_token` 兜底、成对环境变量覆盖、明文与单段 Base64 双重防泄漏扫描、下划线/自定义密钥日志脱敏与 `client.js` 状态化 Hook + Portal 行为。 |
| **10** | **CI/CD、构建与插件打包流程** | **合理可靠** | `ci.yml` 与 `release.yml` 门禁严谨，`npm run pack:local` + `release-check.mjs --tag v0.2.0` + `release-notes.mjs 0.2.0` 全绿，且拦截 `docs/refactoring/` 与 `docs/features/` 进入发行产物。 |
| **11** | **文档与真实实现一致性** | **一致** | 全仓 Markdown 链接 `0` 断链，`TECHNICAL*.md`、`README*.md`、`CHANGELOG.md`、`AGENTS.md` 与 `oauth-client-externalization/{SPEC,PLAN,PROGRESS}.md` 全部与代码及 `v0.2.0` 状态对齐。 |
| **12** | **废弃代码、临时文件与无用依赖** | **干净** | 无废弃源码、无多余依赖、无未清理 `.tgz`；工作区根目录 `.npm-cache/` 系 2026-11-22 遗留缓存，已被 `.gitignore` 忽略且经打包检验不进入 `.tgz`。 |
| **13** | **误标 `DONE` 的未完成任务** | **无** | `PROGRESS.md`、`FIXES.md`（`FIX-001`~`FIX-018`）与 `docs/features/*/PROGRESS.md`（含 `O-007`~`O-011`）全部可在源码、Git 历史与测试中独立验证。 |
| **14** | **长期维护与扩展能力** | **良好** | 四层架构、AST 守卫、前后端 RPC 契约测试、防泄漏自动化扫描与双语演进手册完备，具备长期维护与低成本扩展能力。 |

---

## 4. 分级审查结果

### P0：严重问题（必须修复）
- **无**。

### P1：重要问题（建议在发布前修复）
- **无**。

### P2：一般维护性问题（可以后续优化）
- **无新增问题**（上一轮 [FIXES.md](FIXES.md) 中登记的 `P2-01`~`P2-03` 即 `FIX-016`~`FIX-018` 均已核实解决）。

---

## 5. 发布前人工 E2E 核验清单（真实 DSH Desktop 环境）

`main` @ `8ee2879` 与本地 `v0.2.0` 标签已通过全部离线工程门禁与 Git 历史防泄漏检查；建议在真实 **DSH Desktop** 环境中确认以下路径后执行远程推送（`git push -u origin main && git push origin v0.2.0`）：
1. 使用 `npm run pack:local` 生成 `dsh-antigravity-gateway-0.2.0.tgz` 安装/覆盖升级（测试后删除本地 `.tgz`），验证旧版 `credential.json` 平滑保留。
2. 验证零配置点击 **使用 Google 登录** 可正常拉起浏览器完成 OAuth 授权（验证 XOR 掩码运行时解码与回调流程）。
3. 登录第 2 个共享 `aicode-consumers` 的 Google 账号，确认设置 → 账号列表独立保留、可切换/移除，且全部登出后聊天框徽标即时回退 `5h | --`。
4. 验证设置 → 模型配额进度条、聊天框模型名左侧 `5h | XX%` 对齐与 `Escape`/悬停浮层，以及配额耗尽时的自动切号行为。
