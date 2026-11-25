# Refactoring Progress

## Current State
- 当前阶段：审查问题修复阶段已完成（`FIX-001`~`FIX-009` 全部闭环，等待独立复审）
- 授权状态：方案已批准并已完成 Phase 0–5 及审查问题修复（[FIXES.md](FIXES.md)）
- 当前任务：等待独立复审（[REPORT.md](REPORT.md) 与 [FIXES.md](FIXES.md) 已交付）
- 基准提交：`aedfa19f7bafd5f6a70c40a00c57b4f7fc5536f8`
- 当前分支与 HEAD：`refactor/modular-architecture`
- 最近更新时间：2026-11-26 02:35 +08:00

## Task List
| ID | 任务 | 依赖 | 状态 | 验证证据 / 阻塞原因 |
|---|---|---|---|---|
| P0-001 | 检查 Git 状态、工具链版本并保护用户既有修改 | 无 | DONE | Node `v24.18.0`, npm `11.16.0`; `main @ aedfa19`; 无已修改 tracked 文件；`.npm-cache/` 与 `lib/` 已由 `.gitignore` 忽略 |
| P0-002 | 通读全部源码、manifest、脚本、CI/Release 工作流、文档与现有测试 | P0-001 | DONE | 已完整阅读 `src/` 17 文件（5,256 行）、`client.js`（651 行）、`tests/` 11 文件、`scripts/` 4 文件、`.github/workflows/` 2 文件与全部文档 |
| P0-003 | 非破坏性执行现有验证基线并如实记录输出 | P0-001 | DONE | `npm run typecheck` (0, ~1.58s), `npm run build` (0, ~1.61s), `npm test` (106/106 pass, ~5.31s，见下方环境说明), `release-check.mjs --tag v0.1.0` (0) |
| P0-004 | 初始化 `PROGRESS.md`、`DECISIONS.md` 与根目录 `AGENTS.md` | P0-001 | DONE | 已落盘 `AGENTS.md`、`docs/refactoring/DECISIONS.md`、`docs/refactoring/PROGRESS.md` |
| P1-001 | 现场实证复核并输出 `docs/refactoring/AUDIT.md` | P0-002, P0-003 | DONE | 已逐项复核需求第 4 节并补充新发现缺陷，全部附带真实文件/行号证据 |
| P1-002 | 制定目标架构与文件级详细方案 `docs/refactoring/PLAN.md` | P1-001 | DONE | 已输出目标四层架构、新旧文件逐一映射表、`P2`~`P5` 任务与回滚方案 |
| P1-003 | 向用户汇报审计结论、实施方案与待决决策并等待批准 | P1-001, P1-002 | DONE | 用户于 2026-11-26 正式批准 `PLAN.md` 与 `D-001`~`D-006`，授权执行 Phase 2–5 |
| P2-001 | 修复 `package.json` 测试脚本隐患并补齐 0 覆盖模块特征测试 | P1-003 | DONE | `npm run typecheck` (0) + `npm test`（含 `build` + `test:only`，119/119 pass） |
| P2-002 | 建立 `src/shared/` 共享基础与契约层 | P2-001 | DONE | `npm run typecheck` (0) + `npm test`（119/119 pass） |
| P2-003 | 迁移并拆分 `src/protocol/` 纯协议层 | P2-002 | DONE | `npm run typecheck` (0) + `npm test`（119/119 pass） |
| P2-004 | 新增 `tests/architecture.test.mjs` 分层依赖守卫测试 | P2-003 | DONE | `npm test`（120/120 pass，含 AST 静态导入与无环检查） |
| P2-005 | 迁移并拆解 `src/core/` 运行时核心服务层 | P2-004 | DONE | `npm run typecheck` (0) + `npm test`（122/122 pass，含 `importFromAntigravityAuth`/`discoverAccountMetadata`） |
| P2-006 | 建立 `src/dsh/` 适配层、收敛 `src/index.ts` 薄入口并清理旧文件 | P2-005 | DONE | `npm run typecheck` (0) + `npm test`（122/122 pass，旧扁平文件已清空） |
| P3-001 | P0 缺陷闭环（卸载取消登录、统一 RPC/完整 dispose/守卫、刷新取消解耦） | P2-006 | DONE | `npm run typecheck` (0) + `npm test`（126/126 pass，含 4 项 P0 回归测试） |
| P3-002 | P1 缺陷闭环（Catalog 单飞与保序、Transport 有界池、SSE 中止挂起、原子写盘测试） | P3-001 | DONE | `npm run typecheck` (0) + `npm test`（129/129 pass，总耗时 ~412ms） |
| P3-003 | P2 细节清理与流式/工具/签名/超时集成测试加固 | P3-002 | DONE | `npm run typecheck` (0) + `npm test`（134/134 pass） |
| P3-004 | `client.js` 类型检查、样式去重、`LogPanel` 对齐与前后端契约测试 | P3-001 | DONE | `npm run typecheck` (含 `typecheck:client`, 0) + `npm test`（137/137 pass） |
| P4-001 | 工具链与质量门禁统一（`typecheck`、`test`、`.gitignore`/`files` 校验） | P3-004 | DONE | `npm run verify` 通过；新增 `D-007`；`package.json#files` 精确为 `docs/DETAIL.md` |
| P4-002 | CI/CD 工作流审查与加固（`ci.yml` / `release.yml`） | P4-001 | DONE | `ci.yml` 与 `release.yml` 补充 `typecheck` 与 `npm pack` 产物校验；`release-check.mjs` 禁止打入 `docs/refactoring/` |
| P4-003 | GitHub 开源治理基建（`.editorconfig`、Templates、`CONTRIBUTING.md`、`SECURITY.md`） | P4-001 | DONE | 已新增 `.editorconfig`、3 类 Issue 表单、PR 模板、`CONTRIBUTING.md`、`SECURITY.md` |
| P4-004 | 按 `D-005` 同步更新项目文档与 3 类变更 Playbooks | P4-001 | DONE | 已更新 `TECHNICAL.md`、`TECHNICAL.us.md`、`README.md`、`README.us.md`（修复全部 `../` 链接、同步 137 测试与 3 类 Playbooks） |
| P4-005 | 收敛根目录 `AGENTS.md` 为长期维护指南 | P4-004 | DONE | 已更新 `AGENTS.md` 为常驻维护指南（含四层职责、命令、变更落点与安全红线） |
| P5-001 | 全量验证与本地打包干跑（`npm run pack:local` + `release-check.mjs`） | P4-005 | DONE | `npm run verify` (137/137 pass)、`pack:local` + `release-check.mjs --archive-dir .` (0；顺带修复 Windows `tar` CRLF 校验兼容) |
| P5-002 | 对照基线逐项核查功能、数据兼容与安全红线 | P5-001 | DONE | 线缆协议、DSH 契约、凭据格式、`undici` 单依赖、loopback 守卫全部复核通过 |
| P5-003 | 生成 `docs/refactoring/REPORT.md`、更新终态与人工 E2E 清单 | P5-002 | DONE | `REPORT.md`、`PROGRESS.md`、`AGENTS.md` 已落盘并收敛 |

## Completed Work
- `P0-001`：核查 `git status`、`git branch -a`、`git log`、`git check-ignore`。工作区无任何已修改的 tracked 文件；`docs/refactoring/REQUIREMENTS.md` 为未跟踪需求基准；`.npm-cache/` 与 `lib/` 均正常被 `.gitignore` 忽略。
- `P0-002`：完整阅读 `src/` 全部 17 个 TypeScript 文件（合计 5,256 行）、`client.js`（651 行）、`tests/` 全部 11 个测试文件（106 个测试）、`scripts/` 4 个脚本、`.github/workflows/` 2 个工作流、`cordis.patch.yml`、`package.json`、`tsconfig.json`、`locale/*.json` 与全部 Markdown 文档。
- `P0-003`：运行并记录全部基线验证命令（见 Verification Results）。
- `P0-004`：创建根目录 `AGENTS.md`、`docs/refactoring/DECISIONS.md`、`docs/refactoring/PROGRESS.md`。
- `P1-001`：完成 `docs/refactoring/AUDIT.md`。
- `P1-002`：完成 `docs/refactoring/PLAN.md`。
- `P1-003`：向用户汇报审计与方案；用户于 2026-11-26 正式批准 `PLAN.md` 与 `D-001`~`D-006`，已切换至独立重构分支 `refactor/modular-architecture`。
- `P2-001`：修复 `package.json`（新增 `test:only: node --test "tests/*.test.mjs"`，`test` 改为 `npm run build && npm run test:only`），补齐 4 个 0 覆盖模块特征测试 `tests/{prompt-compat,commands,log-service,index}.test.mjs`，全量 119/119 离线测试通过。
- `P2-002`：新增 `src/shared/{errors,guards,fs-atomic,rpc-contracts}.ts`（零内部/宿主依赖，`GatewayError` 与 `@deprecated BridgeError` 别名就位）；`src/errors.ts` 暂改为重导出过渡；`npm run typecheck` 与 `npm test`（119/119）通过。
- `P2-003`：建立 `src/protocol/{constants,models,session-metadata,schema-sanitizer,payload,response,catalog-parser}.ts` 纯协议层（零宿主/网络/FS 依赖；`buildRequestMetadata` 支持直接复用已解析的 `ResolvedRoute`）；旧根文件暂保留过渡重导出；`npm run typecheck` 与 `npm test`（119/119）通过。
- `P2-004`：新增 `tests/architecture.test.mjs`（基于 TypeScript AST 静态检查四层单向依赖、禁止 `protocol` 导入 I/O 标准库/宿主/`undici`/`fs-atomic`、以及无循环依赖）；`npm test`（120/120）通过。
- `P2-005`：迁移并拆解 `src/core/`（`transport/{proxy,http-client,sse,index}.ts`、`credentials.ts`、`oauth.ts`、`auth.ts`、`catalog.ts`、`logger.ts`）；接入 `writeFileAtomicSync` 与 `ANTIGRAVITY_ENDPOINT_FALLBACKS`；新增 `tests/auth.test.mjs` 覆盖 `importFromAntigravityAuth` 与 `discoverAccountMetadata`；`npm run typecheck` 与 `npm test`（122/122）通过。
- `P2-006`：建立 `src/dsh/{types,config,rpc,stream-assembler,adapter,account-service,log-service,commands,prompt-compat}.ts`，收敛 `src/index.ts` 为薄装配入口（含 `D-001` `@deprecated Bridge*` 别名），同步更新全部 `tests/*.test.mjs` 导入，删除全部 16 个旧扁平文件，收紧 `tests/architecture.test.mjs` 禁止残留旧文件并限定 `@deepseek-ai/*` 仅存在于 `src/dsh/`；`npm run typecheck` 与 `npm test`（122/122）通过。
- `P3-001`：修复 3 项 P0 缺陷——`apply()` 卸载调用 `auth.cancelLogin()` 释放回调端口、`registerLogAccess()` 启用 loopback 守卫并完整回收 fiber 与路由、`AuthManager.getCredential()` 解耦 caller `AbortSignal`；补充 4 项 P0 回归测试；`npm run typecheck` 与 `npm test`（126/126）通过。
- `P3-002`：修复 4 项 P1 缺陷——`ModelCatalog.fetchLiveState` single-flight 与代数防过期写入、`definitionsForReport`/`offlineReport` 严格保留 `agentOrder` 顺序；`AgyTransport` 有界 `Map` 连接池与完整 `close()`；`iterateSse` 立即响应 `AbortSignal`（单测耗时从 5007ms 降至 25ms）；补充并发原子写盘零残留 `.tmp` 回归测试；`npm test`（129/129，412ms）通过。
- `P3-003`：`registerModelDiscovery` 与 `adapter` 统一随 `imageInput` 收口 `inputModalities`；`dumpRequestsTo` 改异步 `appendFile`；补充 `imageInput: false`、503 容量退避恢复、流内错误/空响应、多轮工具+签名回放集成测试；`npm run typecheck` 与 `npm test`（134/134，548ms）通过。
- `P3-004`：为 `client.js` 增加 `// @ts-check` + JSDoc（新增 `tsconfig.client.json` 与 `typecheck:client` 纳入 `npm run typecheck`）、`<style id="agw-styles">` 引用计数去重、`LogPanel` 对齐 `loopback-required` 提示，并新增 `tests/client-contract.test.mjs` 校验加载安全性与 `src/shared/rpc-contracts.ts` 100% 一致；`npm run typecheck` 与 `npm test`（137/137）通过。
- `P4-001`~`P4-005`：统一 `npm run verify` 门禁并将 `package.json#files` 的 `docs` 精确为 `docs/DETAIL.md`；加固 `ci.yml`/`release.yml` 与 `release-check.mjs`；新增 `.editorconfig`、Issue/PR 模板、`CONTRIBUTING.md`、`SECURITY.md`；按 `D-005` 同步 `TECHNICAL*.md`/`README*.md`（修复失效 `../` 链接、同步 137 测试与 3 类维护 Playbooks）并收敛 `AGENTS.md`。
- `P5-001`~`P5-003`：全量运行 `npm run verify`、`npm run pack:local` 与 `release-check.mjs --tag v0.1.0 --archive-dir .`，交付 `docs/refactoring/REPORT.md` 并收敛 `AGENTS.md` 为常驻开发指南。
- `FIX-001`~`FIX-009`：核实并修复独立审查 [REVIEW.md](REVIEW.md) 指出的全部问题（`client.js` `slots.register` `this` 绑定、`resolveGatewayConfig` 真实应用 `Config` 默认值、`ModelCatalog` TTL 刷新重置 `cachedFullReport`、`readBoundedText` abort 竞态、`startCallbackServer` `closeAllConnections`、`AuthManager` `authGeneration` 竞态防写回、`rpc.ts` 动态 `webServer` 守卫、4 项边界测试以及文档/脚本修正），全量验证 `npm run verify`（18 文件 / 145 用例）通过。

## Work in Progress
- 无进行中代码任务，等待独立复审。

## Verification Results
| 命令 | 执行时间 | 退出码 / 结果 | 关键输出摘要（脱敏） |
|---|---|---|---|
| `npm run verify`（`typecheck:ts` + `typecheck:client` + `build` + `test:only`） | 2026-11-26 02:35 +08:00 | 退出码 `0`（测试 ~505ms） | **18 个文件 / 145 个离线测试全部通过**，TS 与 `client.js` 零类型错误 |
| `npm run pack:local` + `node scripts/release-check.mjs --tag v0.1.0 --archive-dir .` | 2026-11-26 02:35 +08:00 | 退出码 `0` | 打包 `.tgz` 校验通过（不含 `.npm-cache/`、`node_modules/`、`docs/refactoring/`），临时 `.tgz` 已清理 |

## Known Issues and Blockers
- **环境说明**：在受限 Windows `workspace-write` 沙箱内运行 `node --test` 默认进程隔离模式会触发 `spawn EPERM`（因为底层禁止捕获子进程 piped stdio）；CI（Ubuntu/Windows 标准 runner）及常规终端环境下运行正常。
- **待人工核验项**：真实 Google 上游接口及真实 DSH Desktop 环境运行时加载/UI 交互需人工按 [REPORT.md §6.2](REPORT.md) 核验。

## Pending Decisions
- 无待决项（`D-001`~`D-007` 已全部确认并落地）。

## Next Actions
1. 由维护者在真实 DSH Desktop 环境中执行 [REPORT.md §6.2](REPORT.md) 列出的 6 项人工 E2E 核验。
2. 人工核验无误后，再决定合并 `refactor/modular-architecture` 至 `main`。

## Handoff Notes
- `refactor/modular-architecture` 工作树干净，未改动 `main` 分支（`aedfa19`），未提升版本号，未执行任何远程推送或发布操作。
- `.npm-cache/` 存在于工作区根目录，已被 `.gitignore` 忽略且未进入 Git 索引与 `.tgz` 打包产物。
