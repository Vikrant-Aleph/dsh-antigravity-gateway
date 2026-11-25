# 技术方案与实施计划：OAuth 公开客户端标识 Base64 编码与历史清洗（PLAN）

> **关联需求**：[SPEC.md](SPEC.md)
> **当前基线**：`main` @ `51a7772`（`v0.2.0`，本地共 22 个提交，尚无 `origin/*` 远程跟踪分支）
> **架构约束**：严格维持 `src/shared/` ← `src/protocol/` ← `src/core/` ← `src/dsh/` ← `src/index.ts` 四层单向依赖及零额外运行时依赖（仅 `undici`）。

---

## 1. 现状与影响评估（实证核查）

1. **明文出现位置（全仓 `grep` 与 Git 历史 `git log --all -S` 核实）**：
   - 当前工作树仅在 [src/protocol/constants.ts](../../../src/protocol/constants.ts#L12-L16) 存在完整的公开 `ANTIGRAVITY_CLIENT_ID` 与 `ANTIGRAVITY_CLIENT_SECRET` 明文字面量。
   - [TECHNICAL.md](../../../TECHNICAL.md#L105) 与 [TECHNICAL.us.md](../../../TECHNICAL.us.md#L112) 仅含脱敏前缀 `1071006060591-…apps.googleusercontent.com`（不含完整 ID 或 secret）。
   - [SPEC.md](SPEC.md#L89) 验收条款文本此前包含 Google Client Secret 明文前缀字面量，已改为安全描述以避免触发最严格的前缀扫描。
   - Git 全量历史（共 22 个提交，横跨 `main` 与 `refactor/modular-architecture`）中，`aedfa19` 在 `src/constants.ts` 引入该字面量，`0977c3c` 迁移至 `src/protocol/constants.ts`，`c5fa893` 删除旧 `src/constants.ts`。
2. **工具链现状**：
   - 本机具备 Node.js `v24.18.0`、Python `3.12.10` 与 `git-filter-branch`（Git for Windows 内置），未安装 `git-filter-repo`。因全仓库仅 22 个提交，使用 `git filter-branch --tree-filter` 配合纯 Node 脚本即可快速、确定性地完成历史重写。
3. **架构、兼容性与安全评估**：
   - `src/protocol/constants.ts` 仅使用 Node 内置全局 `Buffer` 进行 Base64 解码，不引入任何 `node:fs` / `node:http` / `undici` / `@deepseek-ai/*` 导入，完全符合 [tests/architecture.test.mjs](../../../tests/architecture.test.mjs)。
   - 运行时导出的 `ANTIGRAVITY_CLIENT_ID` 与 `ANTIGRAVITY_CLIENT_SECRET` 字符串值与原值字节级一致；零配置一键浏览器登录、多账号 Vault、`catalog-cache` 及 `Config` Schema 100% 不受影响。
   - 对用户无感知：普通用户仍无需配置任何环境变量；有定制需求的高级用户可通过环境变量成对覆盖。

---

## 2. 文件级修改计划

| 模块 / 文件 | 改动内容 |
|---|---|
| [src/protocol/constants.ts](../../../src/protocol/constants.ts) | 新增私有 `decodeBase64(encoded)`，将 `ANTIGRAVITY_CLIENT_ID` 与 `ANTIGRAVITY_CLIENT_SECRET` 改为 `decodeBase64('...')`，保留公开桌面客户端说明注释，无任何明文字面量。 |
| [src/core/oauth.ts](../../../src/core/oauth.ts) | 新增 `resolveOAuthClient()`：优先读取 `ANTIGRAVITY_OAUTH_CLIENT_ID` + `ANTIGRAVITY_OAUTH_CLIENT_SECRET`，其次 `ANTIGRAVITY_CLIENT_ID` + `ANTIGRAVITY_CLIENT_SECRET`（均须非空成对提供，避免 ID/Secret 错配），未配置时回退默认导出常量；在 `buildAuthorizationUrl`、`exchangeCode`、`refreshAccessToken` 中使用。 |
| [src/core/logger.ts](../../../src/core/logger.ts) | 在 `PluginLogger.redact()` 增加 Google OAuth Client Secret 形态（通过字符串拼接构造正则，不在源码出现字面量前缀）及 `client_secret=...` 表单值脱敏。 |
| [docs/features/oauth-client-externalization/SPEC.md](SPEC.md) | 清理第 89 行带前缀的字面量写法，改用文字描述“Google OAuth Client Secret 前缀/完整字面量”，确保全仓扫描测试可通过。 |
| [tests/oauth.test.mjs](../../../tests/oauth.test.mjs) | 新增 3 项离线测试：<br>1）运行时解码校验（与预期格式匹配且非空）；<br>2）环境变量成对覆盖与优先级测试（含单边设置自动回退保护）；<br>3）全仓防明文泄漏扫描（检查 `src/`、`lib/`、`client.js`、`tests/`、`docs/`、`README*.md`、`TECHNICAL*.md`）。 |
| [tests/logger.test.mjs](../../../tests/logger.test.mjs) | 补充 Google OAuth Client Secret 形态与 `client_secret=...` 脱敏回归测试。 |
| [CHANGELOG.md](../../../CHANGELOG.md)、[TECHNICAL.md](../../../TECHNICAL.md)、[TECHNICAL.us.md](../../../TECHNICAL.us.md) | 在 `TECHNICAL*.md` §2.2/§8 补充说明公开客户端标识编码与可选环境变量覆盖（不含任何明文/完整标识）；`CHANGELOG.md` 在 `## [0.2.0]`（或按发布确认）同步记录。 |

---

## 3. Git 历史清洗与发版执行计划（需用户授权）

1. **实施代码修改并提交**：
   - 在 `main` 分支按第 2 节完成代码、脱敏与测试改动并本地验证通过（`npm run verify` 全绿）。
2. **本地历史备份与重写（破坏性历史重写，须确认）**：
   - 重写前先导出完整 `git bundle` 备份至系统临时目录以便异常时一键恢复；
   - 使用 `git filter-branch --force --tree-filter ... --tag-name-filter cat -- --all` 遍历全部提交，将历史上所有 `src/constants.ts` 与 `src/protocol/constants.ts` 中的明文 OAuth Client ID / Secret 替换为对应 Base64 解码形式（不留任何明文）；
   - 清理 `refs/original/`、过期 reflog 并运行 `git gc --prune=now --aggressive`；
   - 使用 `git log --all -S` 校验整个仓库历史零明文残留。
3. **最终验证与发版确认**：
   - 更新 `v0.2.0` 标签指向清洗并验证后的最新 `main` 提交；
   - 运行 `npm run verify`、`npm run pack:local`、`node scripts/release-check.mjs --tag v0.2.0 --archive-dir .`，随后清理临时 `.tgz`；
   - **远程推送（须确认）**：待用户明确授权后执行 `git push -u origin main && git push origin v0.2.0`（或由用户自行推送）。

---

## 4. 任务拆分与里程碑

| ID | 任务 | 依赖 | 状态 |
|---|---|---|---|
| O-001 | 分析 `SPEC.md`、源码与 Git 历史分布，制定 `PLAN.md` 与 `PROGRESS.md` | 无 | `DONE` |
| O-002 | 等待用户确认实施授权（含 Git 历史重写与是否代为推送 `origin`） | O-001 | `WAITING` |
| O-003 | 实现 Base64 编码常量、环境变量覆盖与日志脱敏 | O-002 | `TODO` |
| O-004 | 补充防泄漏扫描、环境变量覆盖与脱敏单测并通过 `npm run verify` | O-003 | `TODO` |
| O-005 | 执行全分支 Git 历史清洗、`gc` 清理与全历史零残留校验 | O-004 | `TODO` |
| O-006 | 重指 `v0.2.0` 标签、全量构建打包校验（`release-check`）并按授权决定是否 `git push` | O-005 | `TODO` |
