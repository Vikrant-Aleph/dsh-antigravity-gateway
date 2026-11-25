# dsh-antigravity-gateway — Agent 开发与维护指南

> 本项目已完成基于四层单向依赖的模块化重构（详见归档验收报告 [REPORT.md](docs/refactoring/REPORT.md)）。后续开发、修 Bug 与协议跟进请严格遵守以下常驻规范。

---

## 1. 项目定位、运行环境与核心约束

- **定位**：将 Google Antigravity（Cloud Code Assist）模型接入 DeepSeek Harness（DSH）的插件；包名 `dsh-antigravity-gateway`，插件行 ID `dsh-antigravity-gateway`（[cordis.patch.yml](cordis.patch.yml)）。
- **运行环境**：Node.js `>=20.18.1`（CI 覆盖 Node 22/24 × Ubuntu/Windows），TypeScript ESM（`strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`），内置 `node:test`。
- **核心硬约束**：
  - `dependencies` 仅保留 `undici`（零额外运行时依赖）；不做过度工程化。
  - [client.js](client.js) 保持零 bundler 交付形态与 `window.__ModuleLoader__.load` 契约，且 `apply()` 永不抛异常；由 [tsconfig.client.json](tsconfig.client.json) 与 [client-contract.test.mjs](tests/client-contract.test.mjs) 护卫。
  - 不改变 Antigravity 线缆协议语义、DSH 插件契约或凭据/配置存储格式。
  - 详细协议观测、演进剧本与排障见 [TECHNICAL.md](TECHNICAL.md) / [TECHNICAL.us.md](TECHNICAL.us.md)（按 `D-005` 作为唯一双语技术文档，不在 `docs/` 重复维护副本）。

---

## 2. 四层目录职责与单向依赖规则（强制守卫）

由 [architecture.test.mjs](tests/architecture.test.mjs) 通过 TypeScript AST 静态校验，**不可违背**：

```
src/shared/  ◀── src/protocol/  ◀── src/core/  ◀── src/dsh/  ◀── src/index.ts
```

| 层级 | 路径 | 职责与严格依赖边界 |
|---|---|---|
| **共享层** | `src/shared/` | 错误模型（`errors.ts`）、运行时守卫与 `raceWithAbort`（`guards.ts`）、跨平台原子写盘（`fs-atomic.ts`）、前后端共享 RPC 契约（`rpc-contracts.ts`）。**零内部/宿主依赖**。 |
| **协议层** | `src/protocol/` | 常量（`constants.ts`）、模型路由表（`models.ts`）、FNV-1a 会话元数据（`session-metadata.ts`）、Schema 清洗（`schema-sanitizer.ts`）、Payload 组装（`payload.ts`）、SSE 解析（`response.ts`）、目录/配额纯解析（`catalog-parser.ts`）。**严禁**导入 `@deepseek-ai/*`、`undici`、`node:fs`、`node:http`、`node:net`、`node:child_process` 或 `fs-atomic.ts`。 |
| **核心层** | `src/core/` | `transport/{proxy,http-client,sse,index}.ts`、凭据存储（`credentials.ts`）、OAuth PKCE（`oauth.ts`）、Auth 状态机（`auth.ts`）、Catalog 缓存（`catalog.ts`）、脱敏轮转日志（`logger.ts`）。**严禁**导入 `@deepseek-ai/*` 或 `src/dsh/`。 |
| **宿主层** | `src/dsh/` | **唯一**允许导入 `@deepseek-ai/*` 的目录。包含 `types.ts`、`config.ts`、`rpc.ts`、`stream-assembler.ts`、`adapter.ts`、`account-service.ts`、`log-service.ts`、`commands.ts`、`prompt-compat.ts`。 |
| **薄入口** | [src/index.ts](src/index.ts) | 仅做依赖注入、`ctx.effect` 生命周期绑定（含卸载调用 `auth.cancelLogin()`）与受控对外导出。 |

---

## 3. 标准开发与验证命令

```sh
npm ci                                        # 按锁文件安装依赖
npm run typecheck                             # 检查 src/**/*.ts 与 client.js
npm run build                                 # 清理 lib/ 并编译 TypeScript
npm test                                      # 先 build 再跑全部离线测试（绝不请求 Google）
npm run test:only                             # 仅运行 tests/*.test.mjs（须确保 lib/ 已最新）
npm run verify                                # 推荐提交前全量门禁：typecheck + build + test:only
npm run pack:local                            # 构建并打包本地 .tgz（测试完记得清理临时 .tgz）
node scripts/release-check.mjs --tag v0.2.0   # 校验包版本、CHANGELOG、README 与打包白名单
```

---

## 4. 常见变更落点指南

- **新增/下线模型或调整档位/枚举**：修改 [src/protocol/models.ts](src/protocol/models.ts) + [tests/models.test.mjs](tests/models.test.mjs)。
- **Antigravity 上游协议漂移**（UA、字段序、labels、Schema 关键词、SSE 结构）：修改 `src/protocol/` 与 `src/core/transport/` + 对应单测及 [TECHNICAL.md](TECHNICAL.md) / [TECHNICAL.us.md](TECHNICAL.us.md)。
- **DSH 宿主 SDK / Cordis 接口升级**：修改 `src/dsh/` 与 [client.js](client.js) + [tests/client-contract.test.mjs](tests/client-contract.test.mjs)。
- **新增或修改前后端 `/api` RPC**：先更新 [src/shared/rpc-contracts.ts](src/shared/rpc-contracts.ts)，再同步 `src/dsh/rpc.ts` 挂载方与 [client.js](client.js)，由契约测试自动校验一致性。

---

## 5. 安全、质量与 Git 红线

- **修改前先读代码**：严格先读目标文件与现有测试；不凭猜测重构。
- **修 Bug 必补离线回归测试**：禁止在测试中发起真实 Google/外网调用。
- **日志与文档脱敏**：严禁把真实 Token、Cookie、授权 URL、个人本地路径或未脱敏报文写入日志或仓库文档。
- **安全边界**：账号与诊断日志 RPC 经 [src/dsh/rpc.ts](src/dsh/rpc.ts) 统一挂载 `127.0.0.1` loopback 守卫；文件写入统一使用 [fs-atomic.ts](src/shared/fs-atomic.ts)。
- **文档同步与交付清洁**：改架构/协议/RPC 必须同步更新 [TECHNICAL.md](TECHNICAL.md) / [TECHNICAL.us.md](TECHNICAL.us.md)；提交前确认 `npm run verify` 全绿且工作区无 `.npm-cache/`、`*.tgz` 或临时文件污染。
- **Git 约定**：轻量 GitHub Flow + Conventional Commits（`feat:`、`fix:`、`refactor:`、`test:`、`docs:`、`chore:`）；禁止擅自 `git push`、改版本号、发 Release 或执行破坏性 Git 命令。
