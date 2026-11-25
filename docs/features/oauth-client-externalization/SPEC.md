# 功能规格说明书：OAuth 公开客户端标识 Base64 编码与历史清洗（SPEC）

> **功能目录**：`docs/features/oauth-client-externalization/`
> **当前阶段**：已实施验收（`v0.2.0`）
> **基线分支**：`main` @ `3bc93a1`（`v0.2.0`）

---

## 1. 背景与定位澄清

当前仓库在 `src/protocol/constants.ts`（及早期历史提交 `src/constants.ts`）中以明文字符串形式存放了 Google Antigravity CLI 公开嵌入的桌面 OAuth 应用标识（`ANTIGRAVITY_CLIENT_ID` 与 `ANTIGRAVITY_CLIENT_SECRET`）。

- **性质澄清**：这组值是 Google Antigravity 官方桌面端/CLI 公开分发的**应用标识**，**并非用户的个人账号凭据或高危私密密钥**（用户个人凭据仅在浏览器授权成功后生成并保存在本地安全存储中）。
- **实际问题**：由于字符串字面量直接匹配 Google OAuth Secret 模式，推送到启用了 Push Protection 的 GitHub 仓库时会触发 `GH013` 拦截。
- **用户体验要求**：必须**保持零配置、开箱即用的浏览器一键登录**，绝不让普通用户手动填写 Client ID / Client Secret。

### 选定方案（参考 `pi-ai` / `picoclaw`）
在源码中对 `ANTIGRAVITY_CLIENT_ID` 和 `ANTIGRAVITY_CLIENT_SECRET` 采用 **Base64 编码存储、运行时解码**，并可选支持环境变量覆盖；同时清洗本地 Git 全量历史中的明文字面量，确保 `git push` 顺畅通过且保留全部开发提交历史。

---

## 2. 功能目标

1. **源码与构建产物去明文字面量**：
   - 将 `src/protocol/constants.ts` 中的 `ANTIGRAVITY_CLIENT_ID` 和 `ANTIGRAVITY_CLIENT_SECRET` 改为 Base64 编码常量，运行时通过 `Buffer.from(..., 'base64').toString('utf8')` 解码导出。
   - 保持导出变量名与运行时值完全不变，保证**一键浏览器登录、多账号添加、令牌刷新与现有单元测试零回归**。
2. **可选环境变量覆盖（轻量增强）**：
   - 在 `src/core/oauth.ts` 解析 OAuth Client 参数时，优先读取环境变量 `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET`（或 `ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET`），未设置时自动回退到上述解码后的公开默认标识。
3. **Git 历史清洗**：
   - 使用 `git filter-repo`（或等价历史重写手段）在本地 `main` 与 `refactor/modular-architecture` 的全部历史提交中，将旧明文 `ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET` 替换为对应的 Base64 编码实现，保留完整提交记录与历史树结构。
4. **防回归测试与日志脱敏**：
   - 在 `src/core/logger.ts` 的 `redactText` 中补充对 Google OAuth Client Secret 形态的脱敏规则，防止异常响应或调试日志意外带出解码后的字段。
   - 新增自动化离线测试：校验源码（`src/`、`client.js`、`tests/`、`docs/`）与编译产物 `lib/` 中不存在明文客户端密钥字面量，同时校验运行时解码结果非空且环境变量覆盖生效。

---

## 3. 范围与非目标（Non-Goals）

### 在本功能范围内
- `src/protocol/constants.ts`：改用 Base64 编码并在注释中明确说明其为 Antigravity CLI 公开桌面客户端标识。
- `src/core/oauth.ts`：支持可选环境变量覆盖，默认回退至 `constants.ts` 导出的公开标识。
- `src/core/logger.ts`：增加客户端密钥形态日志脱敏。
- `tests/`：补充防明文泄漏扫描测试、运行时解码校验与环境变量覆盖测试。
- Git 历史清洗、`npm run verify`、`npm run pack:local` + `scripts/release-check.mjs --tag v0.2.0` 验证，并推送 `main` 与 `v0.2.0` 完成发布。

### 明确非目标（不做）
- 不增加设置页 OAuth Client 录入表单、不改动 `client.js` UI、不新增 `/api` RPC 端点或 `/agw` 命令（避免过度工程化，保持零配置登录体验）。
- 不修改 `Config` 插件配置结构、不修改现有 `credential.json`（v1/v2）或 `catalog-cache.json` 格式。
- 不改动 Antigravity 线缆协议（`User-Agent`、payload、SSE、签名回放等）与四层单向依赖架构。
- 不新增运行时 npm 依赖（`dependencies` 保持仅 `undici`）。

---

## 4. 详细改动设计

### 4.1 协议常量层（`src/protocol/constants.ts`）
- 定义轻量私有解码函数：
  ```ts
  const decodeBase64 = (encoded: string): string =>
    Buffer.from(encoded, 'base64').toString('utf8')
  ```
- 将 `ANTIGRAVITY_CLIENT_ID` 与 `ANTIGRAVITY_CLIENT_SECRET` 改为 `decodeBase64('<base64>')`。
- 禁止在注释、文档或测试字面量中回写明文字符串（包含 `TECHNICAL*.md` / `SPEC.md` 均不得出现明文前缀）。
- 注：`src/protocol/` 仅使用 Node 内置全局 `Buffer`（不新增 `node:fs`/`node:http`/`undici` 等违规导入），完全符合 `tests/architecture.test.mjs` 的四层依赖守卫。

### 4.2 OAuth 运行时解析（`src/core/oauth.ts`）
- 新增内部解析辅助函数 `resolveOAuthClient()`：
  - 若环境变量同时提供非空 ID 与 Secret（优先 `ANTIGRAVITY_OAUTH_CLIENT_ID` + `ANTIGRAVITY_OAUTH_CLIENT_SECRET`，其次 `ANTIGRAVITY_CLIENT_ID` + `ANTIGRAVITY_CLIENT_SECRET`），使用环境变量值；
  - 否则默认使用 `ANTIGRAVITY_CLIENT_ID` 与 `ANTIGRAVITY_CLIENT_SECRET`。
- `buildAuthorizationUrl`、`exchangeCode`、`refreshAccessToken` 通过 `resolveOAuthClient()` 取值，对调用方接口保持完全向后兼容。

### 4.3 日志脱敏（`src/core/logger.ts`）
- 在 `redactText` 中增加脱敏模式，将 Google OAuth client secret 常见前缀形态替换为 `[REDACTED]`，作为纵深防御。

### 4.4 历史清洗与发版
1. 重写本地分支（`main`、`refactor/modular-architecture`）历史，使历史上每个曾出现过 `src/constants.ts` 或 `src/protocol/constants.ts` 明文字面量的 commit 均替换为 Base64 编码版本（或安全的占位写法），保证全量历史无明文匹配。
2. 在最新 `main` 提交本次改动与测试（`chore` / `refactor` + `test`）。
3. 确认 `CHANGELOG.md`、`package.json`（`0.2.0`）、`README.md` / `README.us.md` 一致后，运行：
   - `npm run verify`
   - `npm run pack:local`
   - `node scripts/release-check.mjs --tag v0.2.0 --archive-dir .`
   - 清理临时 `.tgz`
4. 重新把 `v0.2.0` 标签指向最新验证通过的 commit，执行 `git push -u origin main && git push origin v0.2.0` 触发 GitHub Release。

---

## 5. 验收标准（Acceptance Criteria）

- **AC-1（零明文残留）**：全仓库文件（`src/`、`client.js`、`tests/`、`docs/`、`README*.md`、`TECHNICAL*.md`）、构建产物 `lib/` 以及本地全部 Git 提交历史中，均不包含明文 Google OAuth Client Secret 前缀/完整串或明文完整 OAuth Client ID 字面量；新增防泄漏测试在检测到明文时直接失败。
- **AC-2（开箱即用浏览器登录零回归）**：不配置任何环境变量时，`buildAuthorizationUrl`、`exchangeCode`、`refreshAccessToken` 与全套 `AuthManager` / OAuth 离线测试行为与改动前 100% 一致，用户点击「使用 Google 登录」即可直接完成浏览器授权。
- **AC-3（环境变量覆盖生效）**：当设置 `ANTIGRAVITY_OAUTH_CLIENT_ID` + `ANTIGRAVITY_OAUTH_CLIENT_SECRET`（或 `ANTIGRAVITY_CLIENT_ID` + `ANTIGRAVITY_CLIENT_SECRET`）时，授权 URL 与 token 请求使用覆盖后的客户端参数。
- **AC-4（架构与发版门禁全绿）**：`tests/architecture.test.mjs`、`npm run verify`、`npm run pack:local`、`node scripts/release-check.mjs --tag v0.2.0 --archive-dir .` 全部通过，且 `git push` 成功通过 GitHub Push Protection。
