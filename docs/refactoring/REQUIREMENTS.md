# dsh-antigravity-gateway 项目重构任务

> **文档性质**：原始任务需求、架构基准与执行约束（Source of Truth）
>
> **存放路径**：`docs/refactoring/REQUIREMENTS.md`
>
> **初始授权范围**：仅限 **Phase 0（基线保护）** 与 **Phase 1（实证审计复核与文件级规划）**；在用户明确批准 `PLAN.md` 与待定决策前，**严禁**开展大规模源码重构、升级版本号或修改发布状态。
>
> **适用对象**：负责本次重构任务的 Coding Agent、协助审查的开发者及项目维护者。

## 1. 项目背景、现状基线与重构目标

`dsh-antigravity-gateway` 是将 Google Antigravity（Cloud Code Assist）模型接入 DeepSeek Harness（DSH）的插件，同时也是一个需要长期演进的开源 GitHub 项目。当前核心功能已可用，但仍处于早期阶段；本次任务旨在趁历史包袱较轻时完成系统性重构，让重构后的项目在架构、测试、工程治理和文档上更适合长期维护。

### 1.1 静态快照摘要（Agent 须在 Phase 0/1 实证复核）

以下基于项目 `0.1.0` 版本的预审快照列出，**不替代 Agent 对当前工作区与 Git HEAD 的现场核查**；如与最新代码存在出入，以真实仓库为准并在 `AUDIT.md` 中更正：

* **技术栈与形态**：Node.js `>=20.18.1`、TypeScript ESM（`strict` + `noUncheckedIndexedAccess`）、运行时单依赖 `undici`、内置 `node:test`（约 11 个测试文件 / 106 个离线测试）；前端设置面板为无打包器的 `client.js`（约 651 行，手写 `React.createElement`，入口 `window.__ModuleLoader__.load`）。

* **核心契约**：`cordis.patch.yml` 插件标识 `id: dsh-antigravity-gateway`；`package.json` 暴露 `exports`、`files`、`dsh.bundle`、`dsh.client`；配套 `scripts/release-check.mjs` 与 `.github/workflows/{ci,release}.yml`。

* **主要结构性问题**：

  1. `src/` 下 17 个文件（约 5,257 行）扁平堆放，大文件职责混杂（如 `catalog.ts`、`payload.ts`、`adapter.ts`、`transport.ts`、`auth.ts`），Antigravity 私有协议细节、运行时 I/O 状态与 DSH 宿主适配交织。

  2. 存在已定位的生命周期泄漏、并发竞争、排序震荡、连接池管理与 RPC 安全缺口（详见第 4 节）。

  3. 测试与契约存在盲区（`index.ts`、`commands.ts`、`log-service.ts`、`prompt-compat.ts`、`client.js` 无测试；`npm test` 直接跑 `lib/` 易测到过期编译产物）。

  4. 历史更名残留 `Bridge*` 命名，`src/index.ts` 导出面过宽；工程治理与面向后续维护的文档体系尚未完善。

### 1.2 核心目标（按优先级）

* **P0（底线）**：保留现有全部可用功能、插件契约、模型 ID 兼容与用户凭据/配置数据，防止回归；修复已确认的生命周期、并发与安全缺陷。

* **P0（架构核心）**：严格隔离 **Antigravity 上游协议层**、**运行时核心层** 与 **DSH 宿主适配层**，降低私有协议漂移或 DSH SDK 升级带来的维护成本。

* **P1（工程质量）**：建立清晰的模块边界、单向依赖与 CI 架构守卫测试；统一可重复的构建、类型检查、测试与打包流程。

* **P1（长期可维护性）**：完善 GitHub 开源工程治理、项目文档体系与根目录 `AGENTS.md`，使重构后的项目支持跨会话、多 Agent 与外部贡献者低成本维护。

* **P2（克制演进）**：在接口边界上保持无全局单例与清晰扩展点，但不预先实现当前不需要的功能。

**首要原则：重构不得以牺牲现有可用功能为代价。优先简洁、稳定、安全与可维护，坚决避免过度工程化。**

### 1.3 严格非目标（Non-Goals）

* **不改变线缆协议语义**：除非明确修 Bug 并记录决策，不得改动 `User-Agent`、`AGY_REQUEST_FIELD_ORDER`、FNV-1a 会话元数据格式、Claude `VALIDATED` 模式、思考签名回放逻辑或 OAuth PKCE 参数。

* **不破坏 DSH 插件与数据契约**：不得更改插件 `id: dsh-antigravity-gateway`、`package.json` 的 `dsh.bundle`/`dsh.client` 入口、`client.js` 的 `window.__ModuleLoader__.load` 契约及“`apply()` 永不抛异常”原则；未经批准不改变现有凭据和配置存储格式。

* **不做过度架构**：不引入通用多提供商平台、独立 HTTP 网关服务、微服务、数据库、DI 容器、Monorepo 或重量级运行时依赖（`dependencies` 保持仅 `undici`）。

* **不混入无关新功能**：冻结新特性（如多账号切换 UI、配额可视化等）；已知 Bug 修复与纯结构重构必须分清边界、单独验证并明确记录行为变化。

* **不越权执行外部或破坏性操作**：禁止在单测中发起真实网络/上游请求；禁止自动 `git push`、合并、打 Tag、发 Release、修改远程设置或覆盖用户已有修改。

## 2. 任务持久化、文档体系与跨会话恢复机制（必须首先执行）

本重构任务可能跨越多个会话、模型切换或 Agent 交接。**仓库内的任务文档是唯一可靠的进度真相源**，对话摘要和内部 Todo 不能替代落盘记录；代码、Git diff 与真实命令输出是事实证据，文档必须与之核对。

### 2.1 文档布局与唯一职责

```
AGENTS.md                         # 根目录 Agent 入口：重构期挂载任务索引，完成后收敛为项目开发指南
docs/
├── refactoring/                  # 本次重构任务过程文档（完成后可归档保留追溯）
│   ├── REQUIREMENTS.md           # 原始需求、约束与验收基准（本文档，禁止自行改写）
│   ├── AUDIT.md                  # 现场实证审计、功能基线、技术债与风险证据
│   ├── PLAN.md                   # 目标架构、文件级迁移表、任务清单、测试与回滚方案
│   ├── PROGRESS.md               # 实时任务状态、验证证据、阻塞项与交接说明
│   ├── DECISIONS.md              # 关键决策、用户确认记录与计划偏离登记
│   └── REPORT.md                 # 最终重构验收报告
├── adr/                          # 仅记录具有长期影响的架构决策（由 DECISIONS.md 必要时沉淀）
├── architecture.md               # 项目架构说明（见 D-005，与现有 TECHNICAL*.md 去重协调）
├── development.md                # 开发、测试、打包、加模型与跟进上游变更指南
├── compatibility.md              # 已验证运行环境与限制（禁止编造兼容性矩阵）
└── troubleshooting.md            # 典型错误与脱敏诊断指引

```

**去重约束**：

* 若仓库已有职责重叠的文档（如 `TECHNICAL.md`、`TECHNICAL.us.md`），不得维护两套互相漂移的副本；须在 `DECISIONS.md`（见 `D-005`）和 `AGENTS.md` 中登记真实路径映射或统一整合方案。

* 未进入对应阶段不要提前创建空文件。

* 严禁将真实 Token、Cookie、个人本地路径、真实对话或未脱敏上游报文写入任何任务或项目文档。

### 2.2 需求保护与优先级规则

1. `REQUIREMENTS.md` 为基准文件，Agent 不得自行删减、弱化或覆盖验收条件。

2. 任何经用户确认的需求调整、方案偏离或取舍，必须登记在 `DECISIONS.md`（记录原要求、新决定、确认情况与影响范围），并同步更新 `PLAN.md`。

3. 如发现本任务需求与最新源码、DSH 宿主机制或安全要求冲突，须列出代码证据与替代方案，重大冲突须暂停等待用户确认。

### 2.3 任务编号与状态定义

所有实施项在 `PLAN.md` 与 `PROGRESS.md` 中使用唯一 ID：`P<阶段>-<三位序号>`（如 `P0-001`、`P2-003`，此处 `P` 代表阶段而非缺陷严重度）。每个任务须定义：目标、前置依赖、涉及文件、验收标准、验证命令、回滚方式。

状态严格限定为五种：

* `TODO`：未开始。

* `IN_PROGRESS`：执行中（开始任务前即落盘标记）。

* `DONE`：代码完成且**实际运行通过**该任务的全部必要验证。

* `BLOCKED`：受阻，须写明原因、已尝试手段与解除条件。

* `DEFERRED`：明确暂缓，须写明原因、风险与后续触发条件，禁止冒充完成。

> 未运行的测试不得宣称通过；若因环境限制无法做真实环境 E2E，须明确区分「代码完成 + 离线测试通过」与「真实环境待人工验证」。

### 2.4 `PROGRESS.md` 标准模板

```
# Refactoring Progress

## Current State
- 当前阶段：Phase 0
- 授权状态：仅审计与规划 / 方案已批准 / 等待用户确认
- 当前任务：P0-001
- 基准提交：<git rev-parse HEAD>
- 当前分支与 HEAD：<branch> @ <sha>
- 最近更新时间：<YYYY-MM-DD HH:MM TZ>

## Task List
| ID | 任务 | 依赖 | 状态 | 验证证据 / 阻塞原因 |
|---|---|---|---|---|
| P0-001 | 检查 Git 状态、工具链版本并保护用户既有修改 | 无 | TODO | 未执行 |

## Completed Work
- `<任务 ID>`：修改摘要、涉及文件、提交哈希（如有）、验证命令与结果。

## Work in Progress
- 当前改动范围、未收尾事项、继续执行注意点。

## Verification Results
- 命令 | 执行时间 | 退出码/结果 | 关键输出摘要（脱敏）

## Known Issues and Blockers
- 问题、代码位置、影响、解除条件。

## Pending Decisions
- 关联 `DECISIONS.md` 中的 `D-xxx`。

## Next Actions
1. 下一项已获授权且未受阻的任务 ID、目标文件与验证命令。

## Handoff Notes
- 当前未提交变更、用户既有修改范围、跨会话恢复注意点。

```

### 2.5 `DECISIONS.md` 维护要求

重要架构与工程决策使用唯一 ID（`D-001` 起），记录：日期、背景、关联任务、原方案、备选方案、最终选择、原因、影响范围、风险、回滚方式、是否需用户确认及确认状态。常规变量命名或局部实现细节无需逐条登记。

### 2.6 跨会话与上下文压缩恢复协议

每次新会话开始、切换模型、Agent 交接、中断恢复或无法确信上下文完整时，**必须按顺序执行**：

1. 阅读根目录 `AGENTS.md`（及可能存在的子目录 Agent 规范）。

2. 阅读 `docs/refactoring/REQUIREMENTS.md` 确认红线与验收基准。

3. 阅读 `docs/refactoring/PROGRESS.md` 确认当前阶段授权与任务状态。

4. 阅读已生成的 `AUDIT.md`、`PLAN.md`、`DECISIONS.md` 中与当前任务相关的章节。

5. 运行 `git status`、`git branch --show-current`、`git rev-parse HEAD` 与 `git diff --stat`，核对实际工作区与文档一致，并保护用户既有修改。

6. 核对最近一次验证结果，必要时重跑确认。

7. 仅从下一项**已获授权、前置依赖全部 `DONE` 且未受阻**的任务继续执行；禁止重复已完成任务或越权进入下一授权阶段。

## 3. 目标整体架构与目录设计

### 3.1 分层架构与单向依赖

针对本项目约 5k 行代码规模，采用 **四层轻量化模块架构**（避免按教科书硬拆 8–10 个碎片目录造成空层），通过单向依赖彻底隔离「Antigravity 协议」与「DSH 宿主」：

```
flowchart TD
    Host[DSH Host / WebServer / Agent] --> Entry[src/index.ts 薄装配入口]
    Entry --> DSH[src/dsh/ DSH 宿主适配层]
    Entry --> Core[src/core/ 运行时核心服务层]
    DSH --> Core
    DSH --> Proto[src/protocol/ 纯协议层]
    DSH --> Shared[src/shared/ 共享基础与契约]
    Core --> Proto
    Core --> Shared
    Proto --> Shared
    Core --> Upstream[Google OAuth / Cloud Code Assist 上游]
    Client[client.js 前端面板] -. JSON-RPC 契约校验 .-> Shared

```

#### 强依赖红线（须在 Phase 2 通过架构测试自动校验）

1. `src/shared/`：零内部模块依赖，不放具体业务逻辑，只放通用错误模型、基础守卫、原子文件工具与前后端共享 RPC 契约定义。

2. `src/protocol/`：**纯协议层**。仅允许依赖 `src/shared/` 与无 I/O 标准库（如 `node:crypto`）。**严禁**导入 `@deepseek-ai/*`、`undici`、`node:fs`、`node:http`、`node:child_process`。所有 Antigravity 私有协议常量、模型表、Payload 构造、Schema 清洗、SSE/配额解析收敛于此。

3. `src/core/`：**运行时核心服务层**。负责 HTTP 传输与代理、SSE 读取、OAuth PKCE 与凭据存储、Auth 状态机、Catalog 缓存与日志。仅允许依赖 `src/shared/`、`src/protocol/`、`undici` 与 Node 标准库。**严禁**直接导入 `@deepseek-ai/*`（宿主存储/服务通过轻量结构化接口注入）。

4. `src/dsh/`：**DSH 宿主适配层**。**唯一**允许导入 `@deepseek-ai/*` 的目录。负责配置 Schema、共享 RPC 路由注册、LLM Adapter、流式 Chunk 组装、账号/日志服务、斜杠命令与 Prompt 兼容钩子。

5. `src/index.ts`：**薄入口 / 装配层**。仅做依赖注入、生命周期绑定（`ctx.effect`）与受控对外导出，不承载业务逻辑。

### 3.2 目标目录与文件级映射参考

> 实际拆分可在 `PLAN.md` 中结合现场代码微调，严禁为追求形式完美机械按行数切割或制造无意义空文件。

```
src/
├── index.ts                      # 薄入口：装配、生命周期管理、受控导出
├── shared/
│   ├── errors.ts                 # 统一错误分类、HTTP 状态映射、Retry-After 解析、文本脱敏
│   ├── guards.ts                 # 通用运行时校验/类型守卫 (isRecord, boundedString 等)
│   ├── fs-atomic.ts              # 跨平台原子写盘（唯一临时文件名 + 权限设置 + 失败清理）
│   └── rpc-contracts.ts          # 账号/日志 JSON-RPC 命名空间、方法名与 DTO 契约
├── protocol/                     # 纯协议层（零宿主依赖、零网络/磁盘副作用）
│   ├── constants.ts              # OAuth 常量、端点列表、路径、CLI UA、系统指令常量
│   ├── models.ts                 # 模型定义表、别名、resolveRoute、canonicalModelId
│   ├── session-metadata.ts       # FNV-1a 64-bit、RequestSessionStore、trajectory/cascade 标签
│   ├── schema-sanitizer.ts       # JSON Schema 投影清洗、const→enum、空 schema 处理
│   ├── payload.ts                # 消息/工具/generationConfig/请求信封组装
│   ├── response.ts               # SSE payload 解析、thoughtSignature 提取、finishReason 映射
│   └── catalog-parser.ts         # fetchAvailableModels / quota 纯解析与有序报告构建
├── core/                         # 运行时核心层（I/O、状态机、缓存、传输）
│   ├── transport/
│   │   ├── index.ts              # 聚合导出
│   │   ├── proxy.ts              # 环境变量代理、NO_PROXY、Windows 系统代理读取与缓存
│   │   ├── http-client.ts        # AgyTransport（有界 Dispatcher 池、超时/取消、安全 close）
│   │   └── sse.ts                # iterateSse、readBoundedText、cancelResponse
│   ├── credentials.ts            # CredentialStore（宿主 credentials 注入 + 文件镜像迁移）
│   ├── oauth.ts                  # PKCE URL 构建、token 交换/刷新、loopback 回调服务
│   ├── auth.ts                   # AuthManager（登录、信号解耦 single-flight 刷新、导入、元数据发现）
│   ├── catalog.ts                # ModelCatalog（single-flight 拉取、TTL/冷却、有序磁盘缓存）
│   └── logger.ts                 # PluginLogger（分级、脱敏、轮转、内存回退）
└── dsh/                          # DSH 宿主适配层（唯一依赖 @deepseek-ai/*）
    ├── types.ts                  # HostContext、CredentialsServiceLike、AttachmentsServiceLike 等
    ├── config.ts                 # Config Schema 定义 + 单一真相源推导 GatewayConfig 与归一化
    ├── rpc.ts                    # 统一 /api JSON-RPC 注册器（解包、错误处理、loopback 守卫、完整 dispose）
    ├── stream-assembler.ts       # ProviderEvent → DSH StreamChunk 与 replayState 状态机
    ├── adapter.ts                # LlmAdapter 实现、认证/重试/降级调度与错误映射
    ├── account-service.ts        # AccountService + registerAccountAccess
    ├── log-service.ts            # LogService + registerLogAccess + antigravity_gateway_log 工具
    ├── commands.ts               # /antigravity-gateway (/agw) 命令与渲染
    └── prompt-compat.ts          # system-prompt/assemble 兼容钩子

```

## 4. 已识别的技术债务与缺陷清单（Phase 1 须现场复核并补充行号证据）

以下问题须明确区分为 **Bug 修复（行为修正）** 与 **纯结构重构**，每项缺陷修复必须配套独立回归测试：

| 级别 | 类别 | 问题与现状摘要 | 重构修复要求 |
| ----- | ----- | ----- | ----- |
| **P0** | 生命周期泄漏 | `src/index.ts` 的 `apply()` 未在 `ctx.effect` 清理中调用 `auth.cancelLogin()`，登录期间重载插件会泄漏 51121 回调端口。 | 在 `apply()` 中绑定 `() => auth.cancelLogin()` 并在卸载测试中验证端口释放。 |
| **P0** | 安全与资源泄漏 | `src/log-service.ts` 的 `registerLogAccess()` 丢弃了 `ctx.inject(['connection'], ...)` disposer，重复实现了 RPC 解包，且缺少与 `account-service.ts` 一致的 loopback 访问守卫。 | 抽取 `src/dsh/rpc.ts` 统一注册与 dispose（追踪 fiber 与 route disposer），按 `D-002` 落实日志 RPC 安全策略。 |
| **P0** | 并发取消耦合 | `src/auth.ts` 的 `getCredential(signal)` 直接把首个 caller 的 `AbortSignal` 传入共享 `refreshInFlight`，单个请求取消会连带打断其他并发请求。 | 底层 refresh 使用独立内部生命周期/超时；每个 caller 仅对自身等待执行 `raceWithAbort(refreshPromise, callerSignal)`。 |
| **P1** | 并发与状态抖动 | `src/catalog.ts` 的 `fetchLiveState()` 缺少 single-flight；缓存命中时 `definitionsForReport()` 与磁盘恢复退回静态 `MODEL_DEFINITIONS` 顺序，与上游 `agentOrder` 冲突导致 `notifyIfChanged()` 签名抖动；构造器硬编码默认端点。 | 按 `accountKey` 加入 single-flight 去重；缓存命中与磁盘恢复严格保留 `report.available` 顺序；复用 `ANTIGRAVITY_ENDPOINT_FALLBACKS`。 |
| **P1** | 连接池泄漏 | `src/transport.ts` 的 `dispatcherFor()` 在 `dispatcherKey` 变化（如 `NO_PROXY` 命中或代理切换）时直接覆盖 `this.dispatcher`，未关闭旧连接池且频繁重建。 | 改为有界 `Map<string, Dispatcher>` 缓存（如保留 `direct` 与当前代理），淘汰或 `transport.close()` 时安全关闭全部实例。 |
| **P1** | 写盘竞争 | `credentials.ts` 与 `catalog.ts` 使用固定 `${file}.tmp` 执行写盘，并发写存在竞争损坏风险。 | 统一使用 `src/shared/fs-atomic.ts` 生成唯一临时文件名写入并原子重命名，异常时清理临时文件。 |
| **P1** | 测试脚本隐患 | `package.json` 的 `npm test` 直接运行 `lib/*.js`，本地改完 `src/` 忘记 `build` 会静默跑旧产物。 | 区分 `test:only` 与 `test`（确保默认 `npm test` 先构建或明确校验，同时注意 Windows/Linux 跨平台 `node --test` 路径写法）。 |
| **P1** | 测试与契约盲区 | `index.ts`、`commands.ts`、`log-service.ts`、`prompt-compat.ts`、`client.js` 零覆盖；`client.js` 样式标签重复注入且与后端 RPC 靠手工对齐。 | 先补齐特征测试再重构；为 `client.js` 增加样式去重、类型检查（见 `D-003`）与前后端 RPC 契约测试。 |
| **P2** | 冗余与维护债 | `payload.ts` 重复解析 `wireModel`；`adapter.ts` 的 `listModels()` 动态导入已静态导入的 `models.js`；`dumpRequestsTo` 热路径动态导入/同步 I/O；`inputModalities` 未随 `imageInput === false` 动态收口；`index.ts` 手写 21 字段 `cfg` 断言与 Schema 重复；历史 `Bridge*` 命名与全量导出；工作区 `.npm-cache/` 污染风险。 | 清理冗余导入与重复解析；从 `src/dsh/config.ts` 单一推导配置类型；按 `D-001` 治理命名与导出；核查 `.gitignore` 与打包产物白名单。 |

## 5. 待用户确认的关键决策（写入 `DECISIONS.md`）

Agent 在 Phase 1 汇报时须显式列出以下决策并请用户确认；**在用户未另行修改前，规划按“推荐默认方案”起草，但涉及破坏性变更或安全边界的选项须获得明确确认后方可实施**：

| ID | 决策议题 | 推荐默认方案 | 备选方案 | 影响范围 |
| ----- | ----- | ----- | ----- | ----- |
| **D-001** | 历史 `Bridge*` 命名与 `src/index.ts` 导出收口 | 内部统一为 `Gateway*`（`GatewayError`、`AntigravityGatewayAdapter` 等），在 `0.x` 于 `src/index.ts` 保留 `@deprecated` 别名以兼容外部引用，并收窄非公共内部符号导出；单测改为按子模块导入。 | 直接移除所有 `Bridge*` 导出（破坏性变更，需明确记录）。 | 公共 API、测试 import、`TECHNICAL*.md` |
| **D-002** | 日志 RPC (`/api/antigravity-gateway-logs/*`) 安全策略 | 与 `account-service` 对齐，经 `src/dsh/rpc.ts` 统一挂载 loopback 守卫（非本机 WebServer 下 fail-closed）。 | 仅对写操作（`clear`/`level`）限制 loopback，允许远程只读 `read`/`stat`（需脱敏文件路径）。 | 安全性、`log-service.ts`、`client.js` |
| **D-003** | `client.js` 长期维护形态 | 保持零 bundler 的 `client.js` 交付形态，补齐顶部 `// @ts-check` + JSDoc 类型注释（纳入 `npm run typecheck:client`）及前后端 RPC 契约测试。 | 引入 `esbuild` 将 `src/client/*.tsx` 编译打包为带 `window.__ModuleLoader__.load` 包装的 `client.js`。 | 构建链、CI、`package.json`、前端开发体验 |
| **D-004** | 多账号能力扩展边界 | 本次**不实现**多账号功能与 UI，但确保 `CredentialStore` 与 `AuthManager` 无全局单例、key 结构清晰，保留低成本演进空间。 | 在本次重构中把存储格式直接升级为多账号 map（需设计旧数据迁移与回滚方案）。 | `credentials.ts`、`auth.ts`、用户数据兼容性 |
| **D-005** | 架构与技术文档布局（避免双份维护） | 评估现有 `TECHNICAL.md` / `TECHNICAL.us.md` 内容后，决定将其直接作为架构文档（在 `AGENTS.md` 中映射）或拆分迁入 `docs/{architecture,development,compatibility,troubleshooting}.md` 并保留精简跳转，确保零重复维护。 | 仅维护中/英单一语言技术文档（需用户确认是否放弃双语同步）。 | `docs/`、`TECHNICAL*.md`、`README*.md` |

## 6. 分阶段实施路线图与阶段门禁

### Phase 0：基线保护与环境核查（初始授权）

* **P0-001**：检查 `git status`、当前分支、基准提交、Node/npm 版本与工作区未跟踪文件（重点核查 `.npm-cache/` 等本地缓存是否被错误跟踪）；记录用户既有修改，严禁覆盖或执行破坏性 Git 命令。

* **P0-002**：阅读真实源码、manifest（`cordis.patch.yml`、`package.json`）、构建/校验脚本、CI/Release 工作流与全部现有测试，梳理完整功能基线（安装加载、模型发现、OAuth 登录/刷新/导入、流式与非流式调用、工具调用、推理思考签名、图像输入、配置、斜杠命令、日志与面板）。

* **P0-003**：以非破坏方式执行现有验证（`npm run typecheck`、`npm run build`、`npm test`），如实记录退出码、耗时、已有失败或环境限制。

* **P0-004**：初始化 `docs/refactoring/PROGRESS.md`、`docs/refactoring/DECISIONS.md` 与根目录 `AGENTS.md`（若已存在则增量追加任务索引与恢复协议）。

### Phase 1：实证审计与文件级详细规划（初始授权；完成后强制停止等待批准）

* **P1-001**：输出 `docs/refactoring/AUDIT.md`——基于真实代码逐项核实第 4 节问题并补充实际符号、行号、调用链与额外发现的技术债；明确区分「已确认问题」「合理风险」与「待验证假设」。

* **P1-002**：输出 `docs/refactoring/PLAN.md`——给出当前/目标架构对比、精确到每个旧文件与新文件的迁移清单（保留/修改/移动/拆分/新建/删除）、分阶段任务表（含前置依赖、验证命令、回滚方法）、兼容性与安全控制方案。

* **P1-003**：向用户汇报审计结论、核心架构设计、待确认决策（`D-001`~`D-005`）及残余风险。**等待用户明确批准后再进入 Phase 2**，批准后在 `PROGRESS.md` 与 `DECISIONS.md` 记录授权版本与范围。

### Phase 2：特征测试护网与渐进式分层重构（方案批准后）

> 每完成一个子任务，必须运行对应测试与全量构建检查，并以小批次可回滚方式推进。

* **P2-001（基线护网）**：先修复 `package.json` 测试脚本（保证默认 `npm test` 不会跑过期 `lib/`，且兼容 Windows/Linux 的 `node --test` 目录发现机制），在改动业务代码前为当前 0 覆盖模块补齐特征测试：`tests/prompt-compat.test.mjs`、`tests/commands.test.mjs`、`tests/log-service.test.mjs`、`tests/index.test.mjs`。

* **P2-002（共享层）**：建立 `src/shared/`（`errors.ts`、`guards.ts`、`fs-atomic.ts`、`rpc-contracts.ts`），消除跨模块重复基础逻辑。

* **P2-003（纯协议层）**：拆分并迁移 `src/protocol/`（`constants.ts`、`models.ts`、`session-metadata.ts`、`schema-sanitizer.ts`、`payload.ts`、`response.ts`、`catalog-parser.ts`），同步清理 `buildRequestMetadata()` 重复解析。

* **P2-004（架构守卫测试）**：新增 `tests/architecture.test.mjs`，静态扫描 `src/` 各层 import，强制校验第 3.1 节依赖方向（例如 `src/protocol/` 零宿主/网络/FS 依赖、`src/core/` 零 `@deepseek-ai/*` 依赖、无循环依赖）。

* **P2-005（核心服务层）**：拆解 `src/core/transport/`（`proxy.ts`、`http-client.ts`、`sse.ts`）并迁移 `credentials.ts`、`oauth.ts`、`auth.ts`、`catalog.ts`、`logger.ts`；补齐 `importFromAntigravityAuth` 与 `discoverAccountMetadata` 单测。

* **P2-006（DSH 适配层与薄入口）**：建立 `src/dsh/`（`types.ts`、`config.ts`、`rpc.ts`、`stream-assembler.ts`、`adapter.ts`、`account-service.ts`、`log-service.ts`、`commands.ts`、`prompt-compat.ts`），将 `src/index.ts` 收敛为薄装配层，按 `D-001` 治理命名与导出，并删除确认无引用的旧扁平文件。

### Phase 3：稳定性、安全性、缺陷修复与 `client.js` 契约治理（方案批准后）

* **P3-001（P0 缺陷闭环）**：落地并回归测试——`apply()` 卸载调用 `auth.cancelLogin()`；`registerLogAccess()` 统一走 `src/dsh/rpc.ts` 完整释放 disposer 并按 `D-002` 挂载安全守卫；`AuthManager.getCredential()` 解除 caller abort 耦合。

* **P3-002（P1 缺陷闭环）**：落地并回归测试——`ModelCatalog` single-flight + 缓存/磁盘保序 + 复用默认端点；`AgyTransport` 有界 Dispatcher 池与资源回收；原子写盘并发安全测试。

* **P3-003（P2 细节与流式边界）**：清理 `adapter.ts` 动态导入与 `dumpRequestsTo` 异步化；`inputModalities` 随 `imageInput` 动态调整；补充流式中断、取消、超时、错误映射、多轮工具回传与思考签名回放集成测试。

* **P3-004（`client.js` 治理与契约测试）**：按 `D-003` 为 `client.js` 增加类型检查（或轻量构建）与固定 `<style id="agw-styles">` 去重；新增 `tests/client-contract.test.mjs`，在 mock `window.__ModuleLoader__` + mock `React` 环境下验证加载安全、缺省上下文不抛异常，并断言前后端 RPC 命名空间/端点 100% 一致。

### Phase 4：工程化、CI/CD、GitHub 开源治理与配套文档（方案批准后）

* **P4-001（工具链与质量门禁）**：统一并文档化 `typecheck`（含 `client.js`）、`build`、`test`、`pack:local`、`release-check` 命令；评估是否引入轻量零负担的格式化/Lint（如 `biome` 或 `eslint`，不增加运行时依赖、不制造噪音）；确保 `.gitignore` 与 `package.json#files` 杜绝 `.npm-cache/` 等脏文件进入仓库或 tarball。

* **P4-002（CI/CD 加固）**：审查并完善 `.github/workflows/ci.yml` 与 `release.yml`——锁定依赖安装（`npm ci`）、最小权限（`permissions`）、稳定版本 Actions、不可信 PR 密钥隔离、构建后工作区干净检查、产物打包校验；确保修改工作流不会意外触发正式发布。

* **P4-003（GitHub 开源协作基建）**：按项目真实体量轻量完善 `.editorconfig`、`.github/ISSUE_TEMPLATE/`（Bug 反馈 / 上游协议变更 / 兼容性问题）、`.github/PULL_REQUEST_TEMPLATE.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`（保留历史版本、不擅自改版本号或 LICENSE），按需评估 Dependabot 配置（避免机器人泛滥）。

* **P4-004（项目文档同步）**：按 `D-005` 同步更新 `README*.md`、架构文档、开发指南（含「如何添加/更新模型」「如何跟进 Antigravity 上游协议漂移」「如何适配 DSH 宿主升级」）、兼容性说明与故障排查文档，按实际需要沉淀 `docs/adr/`。

* **P4-005（根目录 `AGENTS.md` 收敛）**：基于重构后的真实代码更新 `AGENTS.md`（要求见第 7.3 节）。

### Phase 5：最终全量验收、兼容性核对与 `REPORT.md` 交付（方案批准后）

* **P5-001**：全量运行类型检查、Lint（如启用）、单元测试、集成测试、架构守卫测试、契约测试、构建与本地打包干跑（`npm run pack:local` + `node scripts/release-check.mjs`，完成后清理临时 `.tgz`）。

* **P5-002**：逐项对照 Phase 0 基线检查功能兼容、外部接口、配置/凭据迁移与安全红线（无 TLS 关闭、无凭据/敏感报文泄漏、无未释放资源）。

* **P5-003**：生成 `docs/refactoring/REPORT.md`，更新 `PROGRESS.md` 终态，整理 `AGENTS.md`（归档本次重构的临时恢复指令，保留面向后续开发的常驻指引），如实披露未验证项、人工 E2E 清单与残余风险。

## 7. 测试、文档与 `AGENTS.md` 交付要求（支撑后续维护）

### 7.1 自动化测试分层（100% 离线、跨平台）

复用 Node 内置 `node:test`（避免无收益的测试框架迁移），所有自动化测试必须离线确定性运行，兼容 Linux 与 Windows CI：

* **单元测试**：覆盖 `src/protocol/`（Payload、Schema 清洗、SSE/配额解析、模型路由、FNV-1a 会话元数据）、`src/shared/`（错误分类、脱敏、原子写盘）、`src/core/`（代理匹配、PKCE、凭据迁移、刷新并发控制、Catalog 排序与缓存）、`src/dsh/`（配置归一化、Prompt 改写、命令与日志工具）。

* **契约与架构测试**：`tests/architecture.test.mjs`（分层依赖红线守护）、`tests/client-contract.test.mjs`（`client.js` 加载健壮性与前后端 RPC 契约一致性）。

* **集成测试（Fake 上游 & Mock 宿主）**：验证完整请求生命周期——普通/流式响应、多轮工具调用、思考签名回放、取消与超时、401 刷新重试、429/5xx 有限退避且产生部分输出后不盲目重试、插件重载清理。

* **打包校验**：使用真实 `npm pack` 产物通过 `scripts/release-check.mjs` 校验，而不只校验 `src/`。

* **真实环境人工验证清单（与 CI 分离）**：在 `REPORT.md` 中列出待用户在真实 DSH 中手工确认的步骤（安装/升级 `.tgz`、保留旧凭据与配置、OAuth 登录、设置页加载与日志面板、实际对话与工具调用、卸载重载）。

### 7.2 面向后续演进的开发文档重点

除了常规 README 与架构说明，本次重构交付的开发指南必须明确记录本项目最常发生的**三类变更剧本（Playbooks）**：

1. **新增或下线 Antigravity 模型**：只需修改哪些文件（`src/protocol/models.ts` + 对应单测），以及模型能力的证据来源要求。

2. **应对 Antigravity 上游协议漂移**：UA、端点、请求字段顺序、Schema 规则或 SSE 事件变动时的定位路径（集中在 `src/protocol/`）与回归测试方法。

3. **应对 DSH 宿主版本升级**：宿主上下文、RPC 注册、Model Adapter 或 `client.js` 模块加载接口变动时的修改边界（集中在 `src/dsh/` 与 `client.js`）。

### 7.3 根目录 `AGENTS.md` 更新要求

`AGENTS.md` 保持简洁、可执行，用链接指向 `docs/` 而非复制大段内容：

* **重构进行期间**：包含本次重构文档路径映射、当前授权阶段提示、跨会话恢复 7 步流程。

* **重构完成后**：移除过期的临时重构指令，保留以下常驻章节以方便后续维护：

  1. 项目定位、运行环境与核心约束（零额外运行时依赖、`client.js` 零打包器契约等）。

  2. 目录结构职责表与不可违背的单向依赖规则（`shared` ← `protocol` ← `core` ← `dsh` ← `index`）。

  3. 标准开发与验证命令（安装、类型检查、构建、测试、打包校验）。

  4. 常见变更落点指南（协议变化改哪、DSH 适配改哪、加模型改哪、加 RPC 改哪）。

  5. 安全与质量红线（脱敏日志、loopback 守卫、修改前先读代码、修 Bug 必补回归测试、改架构必同步文档、提交前必须工作区干净且全量验证通过）。

  6. Git 约定（轻量 GitHub Flow + Conventional Commits，如 `refactor:`、`fix:`、`test:`、`docs:`、`chore:`）。

## 8. 阶段验收、回滚机制与交付标准

### 8.1 阶段验收矩阵

| 阶段 | 完成条件 | 授权要求 |
| ----- | ----- | ----- |
| **Phase 0** | Git 状态与既有修改已保护、功能基线清晰、现有验证结果已如实记录、任务文档已初始化 | 初始授权 |
| **Phase 1** | `AUDIT.md` 证据充分、`PLAN.md` 精确到文件/任务/回滚、`DECISIONS.md` 列出全部待决项 | 初始授权；**完成后暂停等待批准** |
| **Phase 2** | 特征测试先行建立、四层目录与依赖边界落地、架构守卫测试通过、无功能回归 | 需用户批准方案 |
| **Phase 3** | 第 4 节全部 P0/P1 缺陷修复并配回归测试、`client.js` 契约测试通过 | 需用户批准方案 |
| **Phase 4** | 工具链、CI/CD、开源协作配置、项目文档与 `AGENTS.md` 完成并与真实代码一致 | 需用户批准方案 |
| **Phase 5** | 全量验证与打包干跑通过、差异与安全审查完成、`REPORT.md` 交付且披露未验证项 | 需用户批准方案 |

### 8.2 回滚与 Git 安全规范

* 在获批实施后，优先采用独立重构分支（如 `refactor/modular-architecture`）与按任务粒度划分的小批次提交；每个任务在 `PLAN.md` 中注明回滚方式（如按单提交 `git revert`）。

* 发现回归立即停止扩大改动面，优先定位修复或撤销当前批次改动。

* **绝对禁止**未经用户明确授权执行 `git reset --hard`、`git clean -fd`、自动 `git stash`、变基改写历史、强制推送、合并主干、修改版本号或触发远程发布。

### 8.3 `REPORT.md` 必填交付内容

1. **执行摘要**：原始目标、实际完成范围与未完成/暂缓项（若有）。

2. **架构演进与关键决策**：重构前后结构对比及 `D-001`~`D-005`（及新增决策）最终落地情况。

3. **文件变更总览**：主要新增、移动、拆分、修改、删除的文件及理由。

4. **缺陷与技术债闭环表**：逐项关联任务 ID、`AUDIT.md` 证据、修复方式与新增回归测试路径。

5. **真实验证记录**：所有执行命令、环境信息、通过/失败/未执行状态与打包校验（`release-check.mjs`）结果。

6. **兼容性、安全与残余风险**：接口/数据兼容核查、脱敏与安全审计结论、已知限制及需要人工在真实 DSH 环境中验证的步骤清单。

7. **回滚指引与发布前建议**：说明是否满足发布前质量门槛（不代表自动发布）。

## 9. Coding Agent 首轮启动指令

收到本任务需求后，立即按以下顺序执行第一轮工作：

1. 确认本文件位于 `docs/refactoring/REQUIREMENTS.md`（或已登记的等价路径），完整保留内容，不得删改约束。

2. 执行 **Phase 0**：检查 Git 工作区、分支、基准提交、本地缓存（如 `.npm-cache/`）与工具链版本；运行现有非破坏性验证命令并记录真实输出；初始化 `PROGRESS.md`、`DECISIONS.md` 与 `AGENTS.md` 任务索引。

3. 执行 **Phase 1**：通读真实源码核实第 4 节问题并补充完整证据，生成 `docs/refactoring/AUDIT.md` 与精确到文件级和任务 ID 的 `docs/refactoring/PLAN.md`。

4. **停止在 Phase 1 门禁处**：向用户简明汇报审计发现、目标文件级方案、风险/阻塞以及需要确认的 `D-001`~`D-005`，等待用户明确批准后再启动 Phase 2。