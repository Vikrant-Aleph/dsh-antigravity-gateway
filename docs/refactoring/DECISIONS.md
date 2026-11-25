# Key Decisions Log

本文档记录 `dsh-antigravity-gateway` 重构过程中的关键架构、安全、兼容性与工程化决策。
标记为「待用户确认」的决策在用户批准前作为 `PLAN.md` 的推荐默认假设，**不会在未获授权前实施破坏性或安全边界变更**。

---

## D-001：历史 `Bridge*` 命名与 `src/index.ts` 导出收口

- **日期**：2026-11-26
- **背景**：项目已更名为 `dsh-antigravity-gateway`，但源码仍残留 `BridgeError`、`BridgeErrorCode`、`isBridgeError`、`BridgeCredential`、`BridgeLogger`、`AntigravityBridgeAdapter` 等命名；同时 `src/index.ts` 通过 `export *` 与内部函数导出暴露了大量仅测试或内部使用的符号（如 `fnv1a64Signed`、`proxyFromEnv`、`noProxyMatches`）。
- **关联任务**：`P2-002`、`P2-006`
- **原方案**：保留历史 `Bridge*` 命名并在根目录全量导出。
- **备选方案**：直接删除所有 `Bridge*` 导出与内部辅助函数导出（破坏性变更）。
- **推荐默认选择**：内部全面统一为 `Gateway*` 命名（`GatewayError`、`GatewayErrorCode`、`isGatewayError`、`GatewayCredential`、`GatewayLogger`、`AntigravityGatewayAdapter`）；在 `0.x` 期间于 `src/index.ts` 保留带 `@deprecated` JSDoc 的 `Bridge*` 别名（如 `AntigravityBridgeAdapter`、`BridgeError`、`isBridgeError`）以兼容外部引用，并收窄非公共内部符号导出；所有单元测试改为按职责子模块导入。
- **原因**：既消除长期维护中的命名割裂与过度暴露，又避免 `0.1.x` 阶段对潜在外部导入者造成无预警破坏。
- **影响范围**：`src/shared/errors.ts`、`src/core/credentials.ts`、`src/core/logger.ts`、`src/dsh/adapter.ts`、`src/index.ts`、`tests/*.test.mjs`、`TECHNICAL*.md`。
- **风险**：低；保留的 `@deprecated` 别名无运行时开销，可在未来 `0.2.0` / `1.0.0` 再统一移除。
- **回滚方式**：恢复原导出名或按单提交 `git revert`。
- **是否需用户确认**：**是**
- **确认状态**：已获用户批准（2026-11-26，按推荐默认方案执行）

---

## D-002：日志 RPC（`/api/antigravity-gateway-logs/*`）安全策略

- **日期**：2026-11-26
- **背景**：`src/account-service.ts` 对 `/api/antigravity-gateway-account/*` 挂载了 `accountModeFor(webServer)` 环回守卫（无 WebServer 或绑定 `127.0.0.1` 才放行，否则返回 `loopback-required` fail-closed）；而 `src/log-service.ts` 的 `/api/antigravity-gateway-logs/*`（`read`/`stat`/`clear`/`level`）目前没有任何访问守卫，在非本机 WebServer 下会暴露本地日志目录路径（`dir`）并允许远程清空日志或修改日志级别。
- **关联任务**：`P2-006`、`P3-001`、`P3-004`
- **原方案**：日志 RPC 端点无环回守卫，仅依赖日志内容已脱敏。
- **备选方案**：仅对写操作（`clear`/`level`）限制 loopback，允许远程只读 `read`/`stat`（需脱敏文件路径 `dir`）。
- **推荐默认选择**：与 `account-service` 完全对齐，通过 `src/dsh/rpc.ts` 对 `/api/antigravity-gateway-logs/*` 统一挂载 `accountModeFor(webServer)` loopback 守卫（非本机 WebServer 下 fail-closed 返回 `loopback-required`），并在 `client.js` 的 `LogPanel` 中同步识别 `loopback-required` 提示（与 `AccountPanel`/`ModelsPanel` 一致）。Agent 工具 `antigravity_gateway_log` 不受影响。
- **原因**：DSH RPC 通道目前不携带调用方权限凭据；将诊断日志面板的读取、路径暴露及清空/调级权限与账号面板保持同一安全边界，减少攻击面与策略分歧。
- **影响范围**：`src/dsh/rpc.ts`、`src/dsh/log-service.ts`、`client.js`、`tests/log-service.test.mjs`、`tests/client-contract.test.mjs`。
- **风险**：若用户刻意在非 `127.0.0.1` 绑定的远端 DSH WebServer 中查看设置页诊断日志，该面板将被拒绝访问（此时仍可通过 Agent 工具 `antigravity_gateway_log` 查看）。
- **回滚方式**：在 `src/dsh/log-service.ts` 传入 `requireLoopback: false` 或按提交回滚。
- **是否需用户确认**：**是**
- **确认状态**：已获用户批准（2026-11-26，按推荐默认方案执行）

---

## D-003：`client.js` 长期维护形态

- **日期**：2026-11-26
- **背景**：前端设置面板 `client.js`（651 行）直接通过 `package.json` 的 `exports["./client"]` 与 `dsh.client` 交付，手写 `React.createElement`，无类型检查，且与后端 RPC 命名空间/端点及 `<style>` 注入缺少契约护卫。
- **关联任务**：`P3-004`、`P4-001`
- **原方案**：纯 JS 手写维护，无静态类型检查与契约测试。
- **备选方案**：引入 `esbuild` 将 `src/client/*.tsx` 编译打包为带 `window.__ModuleLoader__.load` 包装的 `client.js`。
- **推荐默认选择**：保持零 bundler 的根目录 `client.js` 交付形态（不引入 `esbuild`），在顶部补齐 `// @ts-check` 与 JSDoc 类型注释（配置 `npm run typecheck:client` 纳入 `npm run typecheck` 与 CI），补齐 `<style id="agw-styles">` 去重与 `LogPanel` 的 `loopback-required` 处理，并新增 `tests/client-contract.test.mjs` 验证加载安全与前后端 RPC 契约一致性。
- **原因**：`client.js` 仅 651 行、3 个轻量 Tab、无第三方前端库依赖；保持零 bundler 可避免额外构建工具与 sourcemap 调试复杂性，同时通过 `// @ts-check` + 契约测试获得同等静态保障。
- **影响范围**：`client.js`、`package.json`（新增 `typecheck:client` 脚本）、`tsconfig.client.json`（或 CLI flags）、`tests/client-contract.test.mjs`、`.github/workflows/ci.yml`。
- **风险**：若未来面板 UI 复杂度大幅上升，手写 `React.createElement` 维护成本会增加；届时可平滑迁入 `esbuild` 而无需改动 `package.json` 导出契约。
- **回滚方式**：移除 `// @ts-check` 与对应校验脚本即可。
- **是否需用户确认**：**是**
- **确认状态**：已获用户批准（2026-11-26，按推荐默认方案执行）

---

## D-004：多账号能力扩展边界

- **日期**：2026-11-26
- **背景**：当前插件为单账号设计（`CREDENTIAL_OWNER/CREDENTIAL_ID` 固定键与 `credential.json` 单对象，目录缓存以 `accountKey` 区分）。
- **关联任务**：`P2-005`
- **原方案**：单账号模型与单账号存储格式。
- **备选方案**：本次直接把存储格式升级为多账号 map 并设计旧数据迁移。
- **推荐默认选择**：本次重构**严格冻结**多账号功能与 UI，不改变现有 `BridgeCredential`/`GatewayCredential` 存储格式与 key；同时确保 `CredentialStore`、`AuthManager`、`ModelCatalog` 保持无全局单例、依赖注入构造与清晰 `accountKey` 隔离，为后续演进留出低成本接口边界。
- **原因**：符合 `REQUIREMENTS.md` §1.3「不混入无关新功能」「未经批准不改变现有凭据和配置存储格式」原则，避免无收益的数据迁移风险。
- **影响范围**：`src/core/credentials.ts`、`src/core/auth.ts`、`src/core/catalog.ts`。
- **风险**：无额外风险；保持既有用户数据 100% 原位兼容。
- **回滚方式**：不涉及数据格式变更，无需迁移回滚。
- **是否需用户确认**：**是**
- **确认状态**：已获用户批准（2026-11-26，按推荐默认方案执行）

---

## D-005：架构与技术文档布局（避免双份维护）

- **日期**：2026-11-26
- **背景**：`REQUIREMENTS.md` §2.1 建议布局中列出了 `docs/{architecture,development,compatibility,troubleshooting}.md`，同时要求「若仓库已有职责重叠的文档（如 `TECHNICAL.md`、`TECHNICAL.us.md`），不得维护两套互相漂移的副本」。现场核查发现，仓库根目录已有非常完整的双语文档 `TECHNICAL.md`（407 行）和 `TECHNICAL.us.md`（465 行），且它们已列入 `package.json#files` 并被 `README.md`/`README.us.md` 链接（仅存在 `../src/*.ts` 相对路径链接失效与 `102` 测试数漂移两个小问题）。
- **关联任务**：`P4-004`、`P4-005`
- **原方案**：同时维护 `TECHNICAL*.md` 与拆分的 `docs/*.md`。
- **备选方案 A（推荐）**：保留 `TECHNICAL.md` 与 `TECHNICAL.us.md` 作为项目的核心双语技术架构、协议观测、开发/演进剧本（3 类变更 Playbooks）、兼容性与故障排查权威文档（同步修复其失效的 `../src/` 链接、过时模块表和测试数量），并在 `AGENTS.md` 与 `README*.md` 中直接映射；**不额外创建**内容重叠的 `docs/architecture.md`、`docs/development.md`、`docs/compatibility.md`、`docs/troubleshooting.md`，`docs/` 下仅保留 `DETAIL.md`、`refactoring/` 及确有长期沉淀价值的 `adr/`。
- **备选方案 B**：将 `TECHNICAL.md`/`TECHNICAL.us.md` 拆分迁入 `docs/{architecture,development,compatibility,troubleshooting}.md`，并将根目录 `TECHNICAL*.md` 改为精简跳转页（或同步调整 `package.json#files`）。
- **推荐默认选择**：**备选方案 A**。理由：仓库已有双语且结构良好的 `TECHNICAL.md`/`TECHNICAL.us.md` 并随包发布；直接将其与重构后四层源码对齐并补全 3 类维护剧本，可做到零文档重复、零旧链接失效、最小目录噪音。
- **影响范围**：`TECHNICAL.md`、`TECHNICAL.us.md`、`README.md`、`README.us.md`、`AGENTS.md`、`docs/`。
- **风险**：低；若用户更偏好按主题拆分为 `docs/*.md`，可在 Phase 4 前按备选方案 B 执行。
- **回滚方式**：文档改动可直接通过 `git revert` 恢复。
- **是否需用户确认**：**是**
- **确认状态**：已获用户批准（2026-11-26，按推荐默认方案执行）

---

## D-006（审计新增）：修复 `iterateSse` 在流阻塞时忽略 `AbortSignal` 导致挂起 `idleTimeoutMs` 的缺陷

- **日期**：2026-11-26
- **背景**：在 Phase 0 实测 `npm test` 时发现 `tests/transport.test.mjs` 的 `iterateSse stops on abort` 耗时 **5007ms**（占全部 106 个测试 5313ms 总耗时的 94%）。审计 `src/transport.ts:366-373, 417-431` 证实：`withIdleTimeout(reader.read(), idleTimeoutMs)` 未监听 `options.signal` 的 `abort` 事件；当流挂起且外部取消请求时，协程会死等完整个 `idleTimeoutMs`（测试为 5s，生产默认 **180s = 3 分钟**）后才抛出 `ABORTED`。
- **关联任务**：`P3-002`（或 `P3-003`）
- **原方案**：仅在 `for (;;)` 循环顶部及超时 catch 块检查 `options.signal?.aborted`。
- **推荐选择**：在 `iterateSse` 的 `reader.read()` 等待上直接竞态监听 `options.signal`（abort 时立即拒绝并取消 `reader`），并补充毫秒级中止耗时断言，避免生产取消请求挂起 3 分钟。
- **影响范围**：`src/core/transport/sse.ts`、`tests/transport.test.mjs`。
- **风险**：极低，纯 Bug 修复，符合用户取消请求的预期行为。
- **回滚方式**：恢复 `withIdleTimeout` 原逻辑。
- **是否需用户确认**：随方案整体确认
- **确认状态**：已获用户批准（2026-11-26，按推荐默认方案执行）

---

## D-007（Phase 4 工程化评估）：不额外引入 ESLint / Biome，以严格 TS + `checkJs` + `.editorconfig` 作为零负担门禁

- **日期**：2026-11-26
- **背景**：`P4-001` 要求评估是否引入轻量格式化/Lint 工具（如 `biome` 或 `eslint`）。
- **关联任务**：`P4-001`
- **评估与最终选择**：不额外引入 `eslint` 或 `biome` npm 包，保持 `package-lock.json` 零额外依赖；通过 `tsc -p tsconfig.json --noEmit`（`strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`）、`tsc -p tsconfig.client.json --noEmit`（`checkJs` + `strict`）、`tests/architecture.test.mjs`、`tests/client-contract.test.mjs` 与 `.editorconfig` 实现零维护噪音的质量门禁。
- **原因**：当前项目仅 ~5.3k 行，严格 TypeScript + AST 架构测试 + `client.js` 契约测试已覆盖静态正确性与风格一致性；引入新第三方 Lint 包会增大 `package-lock.json` 体积并带来规则升级噪音。
- **回滚方式**：如后续团队确需统一格式器，可在 `devDependencies` 中按需增补 `biome`（单包零传递依赖）。
