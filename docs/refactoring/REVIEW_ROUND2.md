# dsh-antigravity-gateway 独立复审与最终验收报告（Round 2）

> **复审角色**：独立软件架构审查者 / 代码审查者 / 质量验收工程师  
> **复审基准**：`refactor/modular-architecture` @ `b428f8a`（对比首轮审查基准 `e7fceeb` 与原始基线 `main` @ `aedfa19`）  
> **复审时间**：2026-11-26  
> **历史审查记录**：首轮审查报告保留于 [REVIEW.md](REVIEW.md)（未修改）；修复台账见 [FIXES.md](FIXES.md)。

---

## 1. 最终验收结论

- **最终结论**：**通过验收（Accepted）**
- **结论依据**：
  1. 首轮审查 [REVIEW.md](REVIEW.md) 指出的 **1 项 P1 问题（`P1-01`）与 8 项 P2 问题（`P2-01`~`P2-08`）已全部核实处置**，其中核心代码与测试修复均直击根本原因，未引入新缺陷、功能退化、安全风险或过度设计。
  2. 暂缓/保留未删的本地 `.npm-cache/` 项（`FIX-009`）具备合理依据：该目录创建于重构前（2026-11-22），已被 `.gitignore` 忽略且经 `tar -tzf` 与 `release-check.mjs` 实证不进入 Git 索引或 `.tgz` 发行产物。
  3. 独立复跑 `npm run verify`（`tsc` + `checkJs` + `build` + **18 个文件 / 145 项离线测试**）、`npm run pack:local` 与 `node scripts/release-check.mjs --tag v0.1.0 --archive-dir .` **全部通过**。
  4. 项目完整满足 [REQUIREMENTS.md](REQUIREMENTS.md) 的原始需求、四层单向依赖目标架构及交付门禁要求（区分「代码完成 + 离线测试全部通过」与「真实 DSH/Google 环境待人工 E2E 验证」）。

---

## 2. 独立复跑验证结果（实测证据）

| 验证项目 | 执行命令 | 环境与条件 | 实际结果 | 备注 |
|---|---|---|---|---|
| **类型检查（TS + Client）** | `npm run typecheck` | Windows 11 · Node `v24.18.0` | **PASS (`exit 0`)** | `tsconfig.json` 与 `tsconfig.client.json` 零错误 |
| **清理与编译** | `npm run build` | 同上 | **PASS (`exit 0`)** | `scripts/clean.mjs` + `tsc -p tsconfig.json` |
| **全量离线测试** | `npm run verify` | 同上（无管道限制权限） | **PASS (`exit 0`)** | **18 文件 / 145 用例全部通过**，耗时 ~520ms（较首轮 137 用例新增 8 项回归用例） |
| **本地打包与身份校验** | `npm run pack:local` + `node scripts/release-check.mjs --tag v0.1.0 --archive-dir .` | 同上 | **PASS (`exit 0`)** | `pack:local` 仅触发一次构建；生成 `157.4 kB` / 133 文件 `.tgz`，`release-check: v0.1.0 identity verified`，校验后已清理临时 `.tgz` |
| **工作区清洁度** | `git status` / `git diff e7fceeb..b428f8a --stat` | `refactor/modular-architecture` | **干净** | `b428f8a` 共变更 24 文件（+558 / -57），无未提交改动 |

---

## 3. 逐项修复复核台账（对照 `REVIEW.md` 与 `FIXES.md`）

| 审查编号 | 修复 ID | 源码/测试核查位置 | 是否真正解决 | 根因针对性与质量评估 |
|---|---|---|---|---|
| **`P1-01`** | `FIX-001` | [client.js:696-718](../../client.js#L696-L718)、[tests/client-contract.test.mjs:125-169](../../tests/client-contract.test.mjs#L125-L169) | **已解决** | 改用 `registerSlot.call(slots, ...)` 恢复 `this === slots` 接收器，并在 `slots.inject` 回调内包裹独立 `try/catch` 兜底异步异常；测试直接断言 `this === ctx.slots` 与延迟回调抛错隔离。直击根因，无副作用。 |
| **`P2-01`** | `FIX-002` | [src/dsh/config.ts:47-65](../../src/dsh/config.ts#L47-L65)、[tests/index.test.mjs:203-219](../../tests/index.test.mjs#L203-L219) | **已解决** | `dumpRequestsTo` 显式 `.required(false)`，剥离 `ObjectT` 索引签名以精确 `GatewayConfig` 类型，`resolveGatewayConfig(raw = {})` 实际调用 `Config(raw)` 应用 Schema 默认值；新增 `apply(host.ctx, {})` 回归测试。 |
| **`P2-02`** | `FIX-003` | [src/core/catalog.ts:320-322](../../src/core/catalog.ts#L320-L322)、[tests/catalog.test.mjs:288-321](../../tests/catalog.test.mjs#L288-L321) | **已解决** | `!includeTierAndQuota` 分支统一重置 `this.cachedFullReport = false`（不再限定 `force`），并由 TTL 过期后 `list()` → `getAvailabilityReport()` 回归测试实证配额刷新。 |
| **`P2-03`** | `FIX-004` | [src/core/transport/sse.ts:20-52](../../src/core/transport/sse.ts#L20-L52)、[tests/transport.test.mjs:73-93](../../tests/transport.test.mjs#L73-L93) | **已解决** | `readBoundedText` 入口检查 `signal?.aborted`，读取循环采用 `raceWithAbort(reader.read(), signal, ...)`，并在 `catch` 路径执行 `await reader.cancel().catch(() => {})` 确保取消或超限时释放流。复用既有 `raceWithAbort`，无冗余实现。 |
| **`P2-04`** | `FIX-005` | [src/core/oauth.ts:214-228](../../src/core/oauth.ts#L214-L228)、[tests/oauth.test.mjs:87-111](../../tests/oauth.test.mjs#L87-L111) | **已解决** | `close()` 补充 `server.closeAllConnections?.()`，`server.once('error')` 清理 `onAbort` 监听；新增 Keep-Alive 连接下的立即端口重绑测试验证。 |
| **`P2-05`** | `FIX-006` | [src/core/auth.ts:66, 116-135, 191-192, 230-231, 282-283](../../src/core/auth.ts#L116-L135)、[tests/auth.test.mjs:153-185](../../tests/auth.test.mjs#L153-L185) | **已解决** | 引入 `authGeneration` 代数并在 `logout()` / `importFromAntigravityAuth()` / `login()` 落盘时递增与清空 `refreshInFlight`；`refresh()` 在 `store.write()` 前校验代数一致且 `finally` 仅清理自身 flight。与 `ModelCatalog.generation` 模式一致，简洁可靠。 |
| **`P2-06`** | `FIX-007` | [src/dsh/rpc.ts:49-83](../../src/dsh/rpc.ts#L49-L83)、[tests/account-service.test.mjs:263-299](../../tests/account-service.test.mjs#L263-L299) | **已解决** | 在每个路由 `fetch` 处理器内动态读取 `ctxWithConnection.get?.('webServer')` 评估 `accountModeFor`，兼顾挂载时告警日志与晚挂载 fail-closed 保护。 |
| **`P2-07`** | `FIX-008` | [tests/adapter.test.mjs:632-701](../../tests/adapter.test.mjs#L632-L701)、[tests/transport.test.mjs:256-295](../../tests/transport.test.mjs#L256-L295) | **已解决** | 补齐流式中途 abort 毫秒级退出、`dumpRequestsTo` JSONL 落盘校验、流内部分输出后异常不重试，以及 `AgyTransport` 超出 `MAX_DISPATCHERS`（4）淘汰关闭旧池测试。 |
| **`P2-08`** | `FIX-009` | [REPORT.md](REPORT.md)、[PROGRESS.md](PROGRESS.md)、[package.json:37](../../package.json#L37)、[TECHNICAL.md](../../TECHNICAL.md#L378)、[TECHNICAL.us.md](../../TECHNICAL.us.md#L420) | **已解决 / 保留项合理** | `REPORT.md` 与双语文档已同步至 **18 文件 / 145 用例**与 `GatewayError` 主命名；`PROGRESS.md` 清理重复与过期 Phase 1 段落；`pack:local` 简化为 `npm pack` 消除重复编译；不删除宿主工作区原有的 `.npm-cache/` 合理且经打包检验无泄露。 |

---

## 4. 新增改动回归与风险核查

1. **架构边界与依赖方向**：`tests/architecture.test.mjs` 通过，所有改动严格遵守 `shared ← protocol ← core ← dsh ← index` 单向依赖与 `undici` 单运行时依赖约束。
2. **安全与并发**：所有修复均未引入凭据明文输出、TLS 放行或新并发竞争；`AuthManager` 与 `ModelCatalog` 均采用轻量代数计数消除登出/失效期间的过期写回风险；`rpc.ts` 动态 `webServer` 校验进一步收紧晚挂载场景下的安全边界。
3. **可选观察项（非阻塞、无需继续扩张修复）**：
   - [tests/adapter.test.mjs:680](../../tests/adapter.test.mjs#L680) 注释提及“even on AUTH error”，实际用例构造的是非法 JSON 触发 `MALFORMED_RESPONSE`（已充分验证流内部分输出后出错不重放路径，无需额外返工）。
   - [REVIEW.md:16](REVIEW.md#L16) 历史文档中 `` `[client.js](client.js)` `` 相对路径未带 `../../`（按保留历史审查记录原则保持原样不改）。

---

## 5. 剩余风险与发布前人工核验说明

- **剩余风险（环境边界，离线不可验证）**：
  1. 本仓库全部 145 项自动化测试基于本地伪 HTTP 端点与 Mock DSH 上下文运行，未连接真实 Google OAuth / Cloud Code Assist 上游或真实 DSH Desktop 进程。
  2. 本地工作区 `.npm-cache/`（2026-11-22 历史缓存）虽不影响 Git 与 `.tgz` 打包，本地提交/归档前按习惯可自行决定是否清理。
- **发布前建议**：
  在合并 `refactor/modular-architecture` 至 `main` 或打 `v*` 标签触发自动发布前，按 [REPORT.md §6.2](REPORT.md) 在真实 **DSH Desktop** 环境中完成 6 项人工 E2E 核验（`.tgz` 覆盖升级与旧凭据保留、Settings 面板 3 Tab 与 `127.0.0.1` / 非环回提示、真实 OAuth 登录/取消/导入、Claude/Gemini 对话与思考签名/图片附件、插件热卸载释放端口与路由、Windows 系统代理连通性）。
