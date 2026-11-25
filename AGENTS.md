# dsh-antigravity-gateway — Agent 开发与重构入口

> **当前状态**：处于**系统性重构实施期**（Phase 2–5 已获用户批准授权，分支 `refactor/modular-architecture`）。按 [PLAN.md](docs/refactoring/PLAN.md) 与 [DECISIONS.md](docs/refactoring/DECISIONS.md) 逐步实施，禁止擅自远程推送、修改版本号或触发发布。

---

## 1. 重构任务文档索引（Source of Truth）

所有任务进度、实证审计与架构决策均以仓库内以下文档为唯一真相源（不可依赖对话上下文或临时摘要）：

| 文档 | 职责 | 状态 |
|---|---|---|
| [REQUIREMENTS.md](docs/refactoring/REQUIREMENTS.md) | 原始重构需求、执行红线与验收基准（禁止改写） | 已锁定 |
| [PROGRESS.md](docs/refactoring/PROGRESS.md) | 实时任务状态、验证证据、阻塞项与跨会话交接说明 | 持续更新 |
| [DECISIONS.md](docs/refactoring/DECISIONS.md) | 关键架构/安全决策（`D-001`~`D-006`）、确认状态与偏离登记 | 已确认 |
| [AUDIT.md](docs/refactoring/AUDIT.md) | 现场实证审计、功能基线、符号行号证据与技术债清单 | Phase 1 完成 |
| [PLAN.md](docs/refactoring/PLAN.md) | 目标四层架构、文件级迁移表、任务依赖与回滚方案 | 已批准 |
| `docs/refactoring/REPORT.md` | 最终重构验收报告（Phase 5 交付，暂未创建） | 未开始 |

---

## 2. 跨会话与上下文压缩恢复协议（必须严格按序执行）

每次新会话开始、切换模型、Agent 交接、中断恢复或无法确信上下文完整时，**必须按顺序执行以下 7 步**：

1. 阅读本文件（`AGENTS.md`）。
2. 阅读 [REQUIREMENTS.md](docs/refactoring/REQUIREMENTS.md) 确认红线、Non-Goals 与阶段门禁。
3. 阅读 [PROGRESS.md](docs/refactoring/PROGRESS.md) 确认当前授权阶段与任务状态。
4. 阅读已生成的 [AUDIT.md](docs/refactoring/AUDIT.md)、[PLAN.md](docs/refactoring/PLAN.md)、[DECISIONS.md](docs/refactoring/DECISIONS.md) 中与当前任务相关的章节。
5. 运行 `git status`、`git branch --show-current`、`git rev-parse HEAD` 与 `git diff --stat`，核对工作区与文档记录一致，保护用户既有修改。
6. 核对最近一次验证结果，必要时重跑确认。
7. 仅从下一项**已获授权、前置依赖全部 `DONE` 且未受阻**的任务继续执行；禁止重复已完成任务或越权进入未授权阶段。

---

## 3. 项目当前基线与核心硬约束

- **仓库定位**：将 Google Antigravity（Cloud Code Assist）模型接入 DeepSeek Harness（DSH）的插件；包名 `dsh-antigravity-gateway`，插件行 ID `dsh-antigravity-gateway`（[cordis.patch.yml](cordis.patch.yml)）。
- **运行环境与工具链**：Node.js `>=20.18.1`（当前本地实测 `v24.18.0` / `npm 11.16.0`），TypeScript ESM（`strict` + `noUncheckedIndexedAccess`），运行时唯一依赖 `undici`，内置 `node:test`。
- **现有架构文档映射**：双语技术设计见 [TECHNICAL.md](TECHNICAL.md) / [TECHNICAL.us.md](TECHNICAL.us.md)（按 `D-005` 决定后续与 `docs/` 的最终组织方式）。
- **不可违背的红线**：
  - 不改变 Antigravity 线缆协议语义（`User-Agent`、`AGY_REQUEST_FIELD_ORDER`、FNV-1a 会话元数据、Claude `VALIDATED` 模式、思考签名回放、OAuth PKCE 参数）。
  - 不破坏 DSH 插件契约（`id: dsh-antigravity-gateway`、`package.json` 的 `dsh.bundle`/`dsh.client`、`client.js` 零打包器及 `window.__ModuleLoader__.load` + `apply()` 永不抛异常、现有凭据/配置格式兼容）。
  - 不引入额外运行时依赖（`dependencies` 保持仅 `undici`），不做过度工程化。
  - 禁止在单测中发起真实网络/Google 请求；禁止自动 `git push`、改版本/发 Release、覆盖用户修改或执行破坏性 Git 命令。
  - 所有文档与日志严禁写入真实 Token、Cookie、个人本地路径或未脱敏报文。

---

## 4. 常用验证命令（当前基线）

```sh
npm run typecheck                           # TypeScript 类型检查（目前仅覆盖 src/**/*.ts）
npm run build                               # 清理 lib/ 并编译 TypeScript
npm test                                    # 离线测试（当前直接跑 tests/*.test.mjs，导入 lib/，运行前须确保已 build）
node scripts/release-check.mjs --tag v0.1.0 # 校验包版本、CHANGELOG 与 README 一致性
```

> **Windows 受限沙箱提示**：在 DSH Windows `workspace-write` 沙箱下直接运行 `node --test` 默认进程隔离模式会因 piped stdio 触发 `spawn EPERM`；需完整权限运行 `npm test`，或在后续按 `P2-001` 检查跨平台测试脚本设计。
