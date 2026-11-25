# dsh-antigravity-gateway 新功能全面验收与独立审查报告（REVIEW）

> **审查角色**：独立软件架构审查者 / 代码审查者 / 质量验收工程师  
> **审查分支**：`refactor/modular-architecture` @ `1c93221`（覆盖新功能提交 `7e38a6f` ~ `1c93221`，基准重构提交 `b428f8a`，原始主干 `main` @ `aedfa19`）  
> **审查时间**：2026-11-26  
> **历史重构验收归档**：四层架构重构首轮与复审结论见 [REVIEW_ROUND2.md](REVIEW_ROUND2.md) 与 [FIXES.md](FIXES.md)。

---

## 1. 验收结论与发布前门槛评估

- **总体结论**：**有条件满足发布前条件（Conditional Go）**。
- **核心判断**：
  1. **新功能核心实现完整、架构边界清晰**：多账号安全凭据库（`CredentialVault` v2 与单账号 v1 向后兼容）、共享 `aicode-consumers` 项目 ID 隔离与 `id_token` 邮箱兜底、按 `accountKey` 隔离的内存/磁盘目录缓存（`catalog-cache.json` v2）、配额耗尽预检与并发 CAS 自动切号（严格保留原所选模型与思考档位）、`/agw accounts` / `/agw switch` / `/agw logout [all]` 命令、设置页账号/模型视觉升级与额度进度条、以及聊天框 `conversation.input.right` 紧凑 `5h | XX%` 指示器和 `document.body` Portal 悬停浮层均已完整落地。
  2. **独立验证全绿**：在无管道限制权限下独立复跑 `npm run verify`（`tsc` + `checkJs` + `build` + **18 个测试文件 / 154 项离线测试**）、`npm run pack:local` 与 `node scripts/release-check.mjs --tag v0.1.0 --archive-dir .` **全部通过**（总耗时 ~558ms，产出 `179.2 kB` / 133 文件 `.tgz`，不含 `.npm-cache/`、`node_modules/`、`docs/refactoring/` 或 `docs/features/`）。
  3. **未发现 P0 阻塞问题**，但独立审查发现 **2 项 P1 问题**（登出全部账号后聊天框 `ComposerQuotaBadge` 仍残留旧账号额度状态；`docs/features/quota-multi-account/PLAN.md` 写入了个人本地绝对路径）及 **4 项 P2 维护性/文档同步问题**。
- **发布前必要条件**：
  1. 修复 **P1-01**（全量登出 / `AUTH` 失败时清空 `sharedQuotaState.report`）与 **P1-02**（清除 `PLAN.md` 中的个人本地路径）；
  2. 同步 **P2-02**（补全 `TECHNICAL*.md` 中新功能章节并将测试计数更新为 `154`）；
  3. 若拟以新版本（如 `v0.2.0`）对外发版，发布前需将 [CHANGELOG.md](../../CHANGELOG.md) 中的 `## [Unreleased]` 转为对应版本小节并同步更新 `package.json` 与 `README*.md` 版本引用；同时在真实 **DSH Desktop** 环境中完成真机人工 E2E 核验（多账号 OAuth、`conversation.input.right` 渲染与悬停定位、`429` 自动切号）。

---

## 2. 独立复跑验证结果（实测证据）

| 验证项目 | 执行命令 | 环境与条件 | 实际结果 | 备注 |
|---|---|---|---|---|
| **TypeScript & Client 类型检查** | `npm run typecheck` | Windows 11 · Node `v24.18.0` | **PASS (`exit 0`)** | `tsconfig.json` 与 `tsconfig.client.json`（`checkJs` + `strict`）零报错 |
| **清理并编译** | `npm run build` | 同上 | **PASS (`exit 0`)** | `scripts/clean.mjs` + `tsc -p tsconfig.json` |
| **全量离线测试** | `npm run verify` | 同上（无管道限制权限） | **PASS (`exit 0`)** | **18 文件 / 154 用例全部通过**，总耗时 ~558ms |
| **本地打包与身份校验** | `npm run pack:local` + `node scripts/release-check.mjs --tag v0.1.0 --archive-dir .` | 同上 | **PASS (`exit 0`)** | 产出 `179.2 kB` / 133 文件 `.tgz`，`package.json#files` 精确收敛为 `docs/DETAIL.md`，已清理临时 `.tgz` |
| **工作区与代码规模核对** | `git status` / `git diff b428f8a..1c93221 --stat` | `refactor/modular-architecture` | **干净** | 30 个 `src/**/*.ts`（6,607 行）、18 个 `tests/*.test.mjs`（4,481 行）、`client.js`（1,302 行）；无未提交改动 |

---

## 3. 十四项审查维度逐项验收结论

| # | 审查维度 | 结论 | 实证摘要 |
|---|---|---|---|
| **1/2** | **功能规格、更新日志与技术文档符合度** | **功能符合 SPEC/CHANGELOG；TECHNICAL 滞后** | 新功能全部符合 [quota-multi-account/SPEC.md](../features/quota-multi-account/SPEC.md)、[ui-quota-polish/SPEC.md](../features/ui-quota-polish/SPEC.md)、[account-ui-multi-fix/SPEC.md](../features/account-ui-multi-fix/SPEC.md) 与 [CHANGELOG.md](../../CHANGELOG.md) `[Unreleased]`；但 `TECHNICAL.md` / `TECHNICAL.us.md` 尚未同步新功能细节且测试数写为 153（见 **P2-02**）。 |
| **3** | **功能退化或兼容性** | **基本兼容（存在 1 项 UI 退化/缺陷）** | 线缆协议、单账号 v1 `credential.json` 与 `catalog-cache.json` v1 向后兼容 100% 保留；DSH 真实宿主契约（`conversation.input.right`、`modelDirectories`、`ModelSelect.module.css` `.trigger` 尺寸字体）已核对一致；唯全量登出后 `ComposerQuotaBadge` 未清除旧账号缓存（见 **P1-01**）。 |
| **4** | **模块职责与依赖方向** | **满足** | `tests/architecture.test.mjs` 静态 AST 守卫通过，严守 `shared ← protocol ← core ← dsh ← index` 单向依赖与无环约束；纯配额匹配 `selectQuotaForModel` 与 `accountCacheKey` 收敛于 `src/protocol/catalog-parser.ts`。 |
| **5** | **DSH 与 Antigravity 隔离** | **满足** | `@deepseek-ai/*` 仅存于 `src/dsh/`；`src/core/` 与 `src/protocol/` 零宿主导入；`client.js` 将 `modelDirectories` 设为 `ctx.inject(['slots', 'modelDirectories'], ...)` 软依赖，不破坏无对话上下文场景。 |
| **6** | **过度工程化评估** | **克制合理** | 运行时仍仅依赖 `undici`；`client.js` 保持零 bundler；`CredentialVault` 与 `catalog-cache.json` v2 升级轻量且向后兼容。 |
| **7** | **安全性、凭据、并发与资源管理** | **整体可靠（有 1 项 P1 文档合规与 2 项 P2 边界）** | `CredentialStore` 所有写操作经 `withWriteLock` 串行化并原子写 `0600`；共享 `aicode-consumers` 项目 ID 不再合并不同账号；Account/Log RPC（含新增 `switch`）统一挂载动态 `127.0.0.1` loopback 守卫。但 `docs/features/quota-multi-account/PLAN.md` 残留本地用户名路径（见 **P1-02**）；`AuthManager.switchAccount` 递增 `authGeneration` 会误伤并发刷新的令牌（见 **P2-01**）。 |
| **8** | **流式响应、认证、错误处理、取消与超时** | **可靠** | `autoSwitchAccount` 仅在 `!hasEmitted.value && !signal?.aborted` 时触发故障转移，已输出部分块后绝不跨账号重放；每请求以 `triedAccountIds` 限每账号至多尝试 1 次，配合 `switchAccountIfCurrent` CAS 防并发连跳；全耗尽时透传带 `providerRetryAfterMs` 的 `RATE_LIMIT`；按 `accountId` 隔离 `refreshInFlightByAccount`。 |
| **9** | **测试真实有效性** | **扎实** | 新增多账号 `CredentialVault` v1→v2 迁移、同项目 ID `aicode-consumers` 隔离、`id_token` 邮箱解析、跨账号缓存/冷却隔离、429/预检/流内 `RESOURCE_EXHAUSTED` 并发 CAS 切号、`switch` RPC、`/agw accounts/switch/logout all`，以及 `client.js` 在状态化 React Hook + Portal mock 下对进度条、Account 卡片、Composer `5h \| 87%` 与非自有模型隐藏的完整验证。 |
| **10** | **CI/CD、构建与插件打包流程** | **合理可靠** | `ci.yml`/`release.yml` 与 `npm pack` 门禁正常，133 个打包文件精确排除测试与 `docs/features/`、`docs/refactoring/`；`release-check.mjs` 可顺手增补 `docs/features/` 防护（见 **P2-04**）。 |
| **11** | **文档与真实实现一致性** | **部分滞后** | `README*.md`、`CHANGELOG.md` 同步到位；但 `TECHNICAL*.md` 未同步新特性、`README*.md`/`TECHNICAL*.md` 测试计数为 153（实际 154），且 `PLAN.md` 含本地绝对路径。 |
| **12** | **废弃代码、临时文件与无用依赖** | **干净** | 零无用依赖、零临时 `.tgz` 或废弃源码文件；工作区根目录历史 `.npm-cache/`（2026-11-22）已被 `.gitignore` 忽略且不入 `.tgz`。 |
| **13** | **误标 `DONE` 的未完成任务** | **基本属实（有 2 项遗漏）** | `F-001`~`F-006` 及后续 polish 均已落地代码并配齐测试；仅 `F-006` 所宣称的“已同步 `TECHNICAL*.md`”仅改了测试数而遗漏正文新特性，且 `PLAN.md` 提到的按 `Escape` 键关闭浮层未在 `client.js` 实现（见 **P2-03**）。 |
| **14** | **长期维护与扩展能力** | **良好** | 多账号数据结构、隔离缓存键与单向四层边界清晰，具备长期维护性与继续扩展多模型/新配额形状的能力。 |

---

## 4. 分级问题清单

> 本轮全面验收**未发现 P0 级严重问题**。以下列出独立审查确认的 **2 项 P1 问题**与 **4 项 P2 优化建议**。

### P1：重要问题（建议在发布前修复）

#### [P1-01] 全部账号登出后，聊天框额度指示器 `ComposerQuotaBadge` 未清除旧账号缓存状态
- **代码位置**：[client.js:620-630, 697-699, 1046-1065](../../client.js#L620-L630)
- **问题原因**：`AccountPanel.act` 在 `logout` 成功后触发 `void fetchModelsReport(rpc, false)`（`client.js:698`）。当用户登出最后一个账号（或执行 `/agw logout all` 触发 `llm/models-updated`）时，后端 `AccountService.models()` 调用 `catalog.getAvailabilityReport()` 会因无凭据抛出 `AUTH` 错误，导致 `rpcCall` 返回 `{ ok: false, error: ... }`。而 `fetchModelsReport()` 仅在 `res.ok && res.value` 时调用 `publishSharedQuota`（`client.js:623`），从未在登出后或 `AUTH` 失败时清理 `sharedQuotaState.report`。
- **影响范围**：用户退出全部账号后，只要当前对话仍保留着本插件的模型选择（DSH `ModelDirectory` 设计上会保留已选模型），聊天框底部仍会继续显示已登出账号的 `5h | XX%`，且悬停浮层仍展示旧账号邮箱与旧配额进度条，造成严重的状态误导。
- **修复建议**：
  1. 在 [client.js](../../client.js) 增加 `clearSharedQuota()`（将 `sharedQuotaState.report = null` 并通知 `listeners`）；
  2. 在 `fetchModelsReport()` 遇到 `models` 请求失败（尤其是未登录错误，或 `AccountPanel` 执行 `logout` 后 `status().loggedIn === false`）时调用 `clearSharedQuota()`；
  3. 在 [tests/client-contract.test.mjs](../../tests/client-contract.test.mjs) 补充登出后 `ComposerQuotaBadge` 回退为 `5h | --` 且浮层不展示旧账号邮箱的回归断言。

#### [P1-02] `docs/features/quota-multi-account/PLAN.md` 提交了包含个人本地绝对路径的链接
- **代码位置**：[docs/features/quota-multi-account/PLAN.md:11, 15](../features/quota-multi-account/PLAN.md#L11-L15)
- **问题原因**：调研章节中的 Markdown 链接直接写入了本机路径 `C:\Users\Vikrant\AppData\Local\Programs\DeepSeek%20Harness\resources\app.asar\dsh\...`，违反了 [AGENTS.md §5](../../AGENTS.md#L65)「严禁把个人本地路径写入日志或仓库文档」的安全红线，且在跨机器与 GitHub 上构成死链。
- **影响范围**：虽然 `docs/features/` 不会打入 `.tgz` 发行包，但已进入 Git 版本库历史；若公开推送至 GitHub 会暴露本地系统用户名与绝对目录路径。
- **修复建议**：将两处链接改为包相对描述（如 `@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/InputBar.tsx` 与 `src/client/contract/slots.ts` 的纯文本引用），不保留 `C:\Users\...` 本地路径。

---

### P2：一般维护性问题（可后续或顺手优化）

#### [P2-01] `AuthManager.switchAccount` / `switchAccountIfCurrent` 递增 `authGeneration` 会误中断并发刷新的令牌请求
- **代码位置**：[src/core/auth.ts:154-191, 312-331](../../src/core/auth.ts#L168-L191)
- **问题原因**：`switchAccount()` 与 `switchAccountIfCurrent()` 执行了 `this.authGeneration += 1` 和 `this.refreshInFlightByAccount.clear()`，而 `refresh()` 在拿到新令牌后校验 `if (this.authGeneration !== gen) throw GatewayError(..., 'ABORTED')`。
- **影响范围**：当并发请求或后台 `getCredentialForAccount(accountId)` 正在进行 ~200ms 的令牌刷新请求时，若同一瞬间发生手动或自动切号（账号本身并未被登出删除），正在刷新的请求会被误判为 `ABORTED` 并丢弃刚拿到的新令牌。
- **修复建议**：将防登出写回的代数改为按 `accountId` 隔离（`accountGenerations: Map<string, number>`），仅在 `logout()` / `addAccount()` / `importFromAntigravityAuth()` 变更该账号记录时递增对应 `accountId` 的代数；`switchAccount` / `switchAccountIfCurrent` 仅切换指针，无需递增代数或清空其他账号的 `refreshInFlightByAccount`。

#### [P2-02] `TECHNICAL.md` / `TECHNICAL.us.md` 未同步新功能架构细节，且双语文档测试计数滞后
- **代码位置**：
  - [TECHNICAL.md](../../TECHNICAL.md)（§3.2、§6.1–6.3、§8、§10 L413）与 [TECHNICAL.us.md](../../TECHNICAL.us.md)（同章节、§10 L467）；
  - [README.md:155](../../README.md#L155)、[README.us.md:168](../../README.us.md#L168)。
- **问题原因**：`F-006` 仅同步了 `CHANGELOG.md`、`README*.md` 的功能表与 `TECHNICAL*.md` 的测试数字（且停留在 `153`，未随 `1c93221` 新增测试同步至 `154`），`TECHNICAL*.md` 正文仍缺 `autoSwitchAccount` 配置、`accounts`/`switch` 命令、`switch` RPC、`CredentialVault` v2、`SHARED_PROJECT_IDS`、`catalog-cache.json` v2 与 `conversation.input.right` 聊天框指示器说明。
- **影响范围**：违反 [AGENTS.md §5](../../AGENTS.md#L67)「改架构/协议/RPC 必须同步更新 `TECHNICAL*.md`」，增加后续维护者理解偏离风险。
- **修复建议**：同步更新 `TECHNICAL.md` / `TECHNICAL.us.md` 对应章节，并将四份文档中的测试数量统一更新为 `154`。

#### [P2-03] `client.js` 聊天框徽标在无 `5h` 分组时文案固定显示 `5h |` 且缺少 `Escape` 关闭快捷键
- **代码位置**：[client.js:1065-1067, 1134-1149](../../client.js#L1065-L1067)
- **问题原因**：
  1. 当 `selectCompactQuota` 命中无 `5h` bucket 的单模型配额回退（`window: 'model'`，如 `gpt-oss-120b-medium`）时，L1067 仍硬编码拼接 `` `5h | ${pct}%` ``；
  2. [quota-multi-account/PLAN.md §2.5](../features/quota-multi-account/PLAN.md#L87) 约定浮层支持“鼠标移出或按 `Escape` 关闭”，当前实现了悬停与失焦（`onBlur`）关闭，尚未绑定 `Escape` 键处理。
- **修复建议**：当 `compact.window === 'model'` 时可显示 `quota | ${pct}%`（或统一提示语义），并在按钮 `onKeyDown` 中补充 `Escape` 关闭逻辑。

#### [P2-04] `deriveAccountId` 对无邮箱共享项目 ID 的防御与 `release-check.mjs` 黑名单增强
- **代码位置**：[src/core/credentials.ts:71-81, 305-308](../../src/core/credentials.ts#L71-L81)、[scripts/release-check.mjs:72-78](../../scripts/release-check.mjs#L72-L78)
- **问题原因**：
  1. `deriveAccountId` 在缺少 `email` 时未跳过 `SHARED_PROJECT_IDS`（`aicode-consumers` 等），使多个无邮箱账号先派生相同 ID 再依赖 `addAccount` 的 `${id}-${existing.accounts.length + 1}` 去重（若中间账号被删后再新增存在重号隐患）；
  2. `release-check.mjs` 已检查 `package/docs/refactoring/`，建议顺手加入 `package/docs/features/` 作为纵深防护（当前 `package.json#files` 已正确排除）。
- **修复建议**：在 `deriveAccountId` 中增加 `!SHARED_PROJECT_IDS.has(credential.projectId)` 判断，并在 `addAccount` 去重循环中递增后缀直到不冲突；`release-check.mjs` 增加 `package/docs/features/` 校验。

---

## 5. 真实环境人工 E2E 核验补充清单

自动化测试已充分验证离线协议、缓存隔离与并发切号逻辑，发布前仍须在真实 **DSH Desktop** 环境中补充验证以下新功能路径：
1. 安装打包产物 `.tgz` 覆盖旧版单账号环境，确认既有 `credential.json` 平滑保留且无需重新登录；
2. 登录第 2 个同属 `aicode-consumers` 的 Google 账号，确认设置 → 账号 tab 正确列出 2 个账号且不互相覆盖，可正常切换与单独移除；
3. 设置 → 模型 tab 验证 `5h` / `weekly` 配额卡片、进度条颜色、重置倒计时及可折叠不可用模型列表；
4. 在聊天框选择本插件模型，确认模型名左侧 `5h | XX%` 与模型名对齐且无边框、悬停浮层不被容器裁剪且正常显示双池配额，切换到 DeepSeek 等其他模型后徽标立即隐藏；
5. 触发或模拟主账号 `429` 配额耗尽，验证自动切至备用账号并保持原所选模型继续输出。
