# Refactoring Progress

## Current State
- 当前阶段：Phase 2（基线护网与渐进式分层重构）
- 授权状态：方案已批准（用户于 2026-11-26 正式批准 `PLAN.md` 及 `D-001`~`D-006`，授权执行 Phase 2–5）
- 当前任务：P2-006（建立 `src/dsh/` 适配层、收敛 `src/index.ts` 薄入口并清理旧文件）
- 基准提交：`aedfa19f7bafd5f6a70c40a00c57b4f7fc5536f8`
- 当前分支与 HEAD：`refactor/modular-architecture`
- 最近更新时间：2026-11-26 01:26 +08:00

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
| P2-006 | 建立 `src/dsh/` 适配层、收敛 `src/index.ts` 薄入口并清理旧文件 | P2-005 | IN_PROGRESS | 进行中 |
| P3-001 | P0 缺陷闭环（卸载取消登录、统一 RPC/完整 dispose/守卫、刷新取消解耦） | P2-006 | TODO | 等待 Phase 2/3 授权 |
| P3-002 | P1 缺陷闭环（Catalog 单飞与保序、Transport 有界池、SSE 中止挂起、原子写盘测试） | P3-001 | TODO | 等待 Phase 2/3 授权 |
| P3-003 | P2 细节清理与流式/工具/签名/超时集成测试加固 | P3-002 | TODO | 等待 Phase 2/3 授权 |
| P3-004 | `client.js` 类型检查、样式去重、`LogPanel` 对齐与前后端契约测试 | P3-001 | TODO | 等待 Phase 2/3 授权 |
| P4-001 | 工具链与质量门禁统一（`typecheck`、`test`、`.gitignore`/`files` 校验） | P3-004 | TODO | 等待 Phase 2/4 授权 |
| P4-002 | CI/CD 工作流审查与加固（`ci.yml` / `release.yml`） | P4-001 | TODO | 等待 Phase 2/4 授权 |
| P4-003 | GitHub 开源治理基建（`.editorconfig`、Templates、`CONTRIBUTING.md`、`SECURITY.md`） | P4-001 | TODO | 等待 Phase 2/4 授权 |
| P4-004 | 按 `D-005` 同步更新项目文档与 3 类变更 Playbooks | P4-001 | TODO | 等待 Phase 2/4 授权 |
| P4-005 | 收敛根目录 `AGENTS.md` 为长期维护指南 | P4-004 | TODO | 等待 Phase 2/4 授权 |
| P5-001 | 全量验证与本地打包干跑（`npm run pack:local` + `release-check.mjs`） | P4-005 | TODO | 等待 Phase 2/5 授权 |
| P5-002 | 对照基线逐项核查功能、数据兼容与安全红线 | P5-001 | TODO | 等待 Phase 2/5 授权 |
| P5-003 | 生成 `docs/refactoring/REPORT.md`、更新终态与人工 E2E 清单 | P5-002 | TODO | 等待 Phase 2/5 授权 |

## Completed Work
- `P0-001`：核查 `git status`、`git branch -a`、`git log`、`git check-ignore`。工作区无任何已修改的 tracked 文件；`docs/refactoring/REQUIREMENTS.md` 为未跟踪需求基准；`.npm-cache/` 与 `lib/` 均正常被 `.gitignore` 忽略。
- `P0-002`：完整阅读 `src/` 全部 17 个 TypeScript 文件（合计 5,256 行）、`client.js`（651 行）、`tests/` 全部 11 个测试文件（106 个测试）、`scripts/` 4 个脚本、`.github/workflows/` 2 个工作流、`cordis.patch.yml`、`package.json`、`tsconfig.json`、`locale/*.json` 与全部 Markdown 文档。
- `P0-003`：运行并记录全部基线验证命令（见 Verification Results）。
- `P0-004`：创建根目录 `AGENTS.md`、`docs/refactoring/DECISIONS.md`、`docs/refactoring/PROGRESS.md`。
- `P1-001`：完成 `docs/refactoring/AUDIT.md`。
- `P1-003`：向用户汇报审计与方案；用户于 2026-11-26 正式批准 `PLAN.md` 与 `D-001`~`D-006`，已切换至独立重构分支 `refactor/modular-architecture`。
- `P1-002`：完成 `docs/refactoring/PLAN.md`。
- `P1-003`：向用户汇报审计与方案；用户于 2026-11-26 正式批准 `PLAN.md` 与 `D-001`~`D-006`，已切换至独立重构分支 `refactor/modular-architecture`。
- `P2-001`：修复 `package.json`（新增 `test:only: node --test "tests/*.test.mjs"`，`test` 改为 `npm run build && npm run test:only`），补齐 4 个 0 覆盖模块特征测试 `tests/{prompt-compat,commands,log-service,index}.test.mjs`，全量 119/119 离线测试通过。
- `P2-002`：新增 `src/shared/{errors,guards,fs-atomic,rpc-contracts}.ts`（零内部/宿主依赖，`GatewayError` 与 `@deprecated BridgeError` 别名就位）；`src/errors.ts` 暂改为重导出过渡；`npm run typecheck` 与 `npm test`（119/119）通过。
- `P2-003`：建立 `src/protocol/{constants,models,session-metadata,schema-sanitizer,payload,response,catalog-parser}.ts` 纯协议层（零宿主/网络/FS 依赖；`buildRequestMetadata` 支持直接复用已解析的 `ResolvedRoute`）；旧根文件暂保留过渡重导出；`npm run typecheck` 与 `npm test`（119/119）通过。
- `P2-004`：新增 `tests/architecture.test.mjs`（基于 TypeScript AST 静态检查四层单向依赖、禁止 `protocol` 导入 I/O 标准库/宿主/`undici`/`fs-atomic`、以及无循环依赖）；`npm test`（120/120）通过。
- `P2-005`：迁移并拆解 `src/core/`（`transport/{proxy,http-client,sse,index}.ts`、`credentials.ts`、`oauth.ts`、`auth.ts`、`catalog.ts`、`logger.ts`）；接入 `writeFileAtomicSync` 与 `ANTIGRAVITY_ENDPOINT_FALLBACKS`；新增 `tests/auth.test.mjs` 覆盖 `importFromAntigravityAuth` 与 `discoverAccountMetadata`；`npm run typecheck` 与 `npm test`（122/122）通过。

## Work in Progress
- `P1-003`：等待向用户汇报审计结论、目标架构、实施计划及 `D-001`~`D-006` 决策确认。

## Verification Results
| 命令 | 执行时间 | 退出码 / 结果 | 关键输出摘要（脱敏） |
|---|---|---|---|
| `npm run typecheck` | 2026-11-26 00:46 +08:00 | 退出码 `0`（~1.58s） | `tsc -p tsconfig.json --noEmit` 零报错通过 |
| `npm run build` | 2026-11-26 00:46 +08:00 | 退出码 `0`（~1.61s） | 清理 `lib/` 并完成 `tsc` 编译 |
| `npm test`（Windows 受限沙箱） | 2026-11-26 00:46 +08:00 | 退出码 `1`（环境限制） | `node --test tests/*.test.mjs` 默认以 piped stdio 派生子进程，被 Windows 沙箱拦截报 11×`spawn EPERM` |
| `npm test`（完整权限） | 2026-11-26 00:53 +08:00 | 退出码 `0`（~5.31s） | 11 个文件 / **106** 个离线测试全部通过（其中 `iterateSse stops on abort` 耗时 5007ms，揭示 abort 挂起 bug） |
| `node scripts/release-check.mjs --tag v0.1.0` | 2026-11-26 00:55 +08:00 | 退出码 `0` | `release-check: v0.1.0 identity verified` |

## Known Issues and Blockers
- **门禁阻断（按流程设计）**：当前授权仅限 Phase 0 与 Phase 1，必须等用户明确批准 `PLAN.md` 与 `DECISIONS.md` 后才能启动 Phase 2。
- **环境说明**：在 DSH Windows `workspace-write` 沙箱内运行 `node --test` 默认进程隔离模式会触发 `spawn EPERM`（因为底层禁止捕获子进程 piped stdio）；需以完整权限执行 `npm test`（或在不依赖 `spawn` 的情况下评估 `--test-isolation=none` 作为本地受限环境辅助命令，CI 中仍保持标准 `node --test`）。

## Pending Decisions
- `D-001`：历史 `Bridge*` 命名与 `src/index.ts` 导出收口
- `D-002`：日志 RPC (`/api/antigravity-gateway-logs/*`) 安全策略
- `D-003`：`client.js` 长期维护形态
- `D-004`：多账号能力扩展边界
- `D-005`：架构与技术文档布局（避免双份维护）
- `D-006`：`iterateSse` 在流挂起时忽略 `AbortSignal` 缺陷修复

## Next Actions
1. 等待用户确认 `docs/refactoring/PLAN.md` 与 `docs/refactoring/DECISIONS.md`（`D-001`~`D-006`）。
2. 获得批准后：按要求建议新建独立重构分支（如 `refactor/modular-architecture`），启动 `P2-001`（测试脚本修复与 0 覆盖模块特征测试）。

## Handoff Notes
- 当前未提交变更仅包含新增的 `AGENTS.md` 与 `docs/refactoring/{PROGRESS,DECISIONS,AUDIT,PLAN}.md`（以及用户原有的 `docs/refactoring/REQUIREMENTS.md`）；`src/`、`tests/`、`client.js`、`package.json` 等源码与配置文件**一字未动**。
- `.npm-cache/` 存在于工作区根目录，已被 `.gitignore` 忽略且未进入 Git 索引，请勿误删或提交。
