# 功能规格说明书：模型额度可视化、聊天框额度指示器与多账号自动切换（SPEC）

> **功能目录**：`docs/features/quota-multi-account/`
> **当前阶段**：第一阶段（需求分析与方案设计，待用户确认后进入实施）
> **基线分支**：`refactor/modular-architecture` @ `b428f8a`

---

## 1. 功能目标

1. **设置页额度与重置时间可视化**：
   - 在 **设置 → Antigravity Gateway → 模型** 面板中，将上游返回的模型/配额组剩余额度与重置时间（`resetTime`）以**进度条 + 百分比 + 重置倒计时/本地时间**的方式直观展示。
2. **聊天框模型名左侧简略额度与完整悬停浮层**：
   - 当用户在当前对话选择了本插件提供的模型（如 `antigravity-gateway` 下的模型）时，在聊天框底部工具栏的模型名称左侧展示简略 5 小时额度标签（例如 `5h | 87%`）。
   - 未选择本插件模型时，该指示器完全隐藏，不占聊天框空间。
   - 鼠标悬停（或键盘聚焦）在该额度标签上时，弹出完整额度信息浮层（当前账号、所选模型剩余额度与重置时间、全部配额分组的 5h / 周额度进度条与重置时间、以及可用多账号数提示）。
3. **多账号管理与额度耗尽自动切换**：
   - 支持在同一插件中登录/导入并持久化多个 Google Antigravity 账号，支持在设置页与 `/agw` 命令中查看账号列表、手动切换当前激活账号、单独登出某一账号。
   - 当当前激活账号在调用某个模型遇到额度耗尽（如上游返回 `429` / 流内 `RESOURCE_EXHAUSTED` 或预检已知 `remainingFraction === 0`）时，自动切换到另一个未耗尽且支持该模型的账号，并**继续使用用户原选择的模型与思考档位**完成本次请求（同时通知前端刷新额度展示）。

---

## 2. 范围与非目标（Non-Goals）

### 在本功能范围内
- 多账号凭据安全存储（兼容升级既有单账号 `credential.json` 与 DSH `credentials` 记录，绝不丢失已有登录）。
- 按 `accountKey` 隔离的内存与磁盘目录缓存（`catalog-cache.json` 支持多账号隔离快照）。
- `AccountService`、`/agw` 命令族及 `client.js` 设置页的多账号增删切与进度条 UI。
- `client.js` 基于 DSH 真实客户端插槽 `conversation.input.right` 与 `modelDirectories` 的聊天框额度指示器及 `document.body` Portal 悬停详情卡片。
- `AntigravityGatewayAdapter.stream()` 中面向配额耗尽的并发安全自动故障转移（保留原 `model` 与 `reasoningEffort`）。

### 明确非目标（不做）
- 不改动 Antigravity 线缆协议请求头、`AGY_REQUEST_FIELD_ORDER`、FNV-1a 会话元数据或签名回放语义。
- 不在多账号轮询中改变用户选择的模型 ID 或偷偷降级到其他模型（严格保持“选择原来的模型”）。
- 不为聊天框小组件引入额外前端构建工具（`client.js` 保持零 bundler + `// @ts-check`）。
- 不修改插件 ID（`dsh-antigravity-gateway`）、依赖列表（保持仅 `undici`）或现有插件版本号。
- 不在自动化测试中连接真实 Google 接口；全部通过本地伪端点与 Mock DSH 上下文验证。

---

## 3. 验收标准（Acceptance Criteria）

### AC-1：设置页额度进度条与重置时间
- **AC-1.1**：设置页「模型」tab 中的每个 `quotaGroups` bucket 均渲染可视化进度条（`role="progressbar"`、`aria-valuenow` 0–100）、百分比文本及基于 `resetTime` 的重置倒计时与本地时间。
- **AC-1.2**：可用模型列表中的每个携带 `remainingFraction` 的模型行均显示进度条、百分比与 `resetTime` 信息；颜色随余量分级（充裕 >25%、预警 1–25%、耗尽 0%）。
- **AC-1.3**：无 `resetTime` 或未返回 `quotaGroups` 时优雅降级（不崩溃、不显示 `Invalid Date` 或 `NaN%`）。

### AC-2：聊天框左侧 `5h | XX%` 指示器与悬停完整额度
- **AC-2.1**：基于 DSH 真实插槽契约注册 `conversation.input.right`（`kind: 'list', scope: 'session'`，紧邻 `conversation.input.model` 左侧，不与 `conversation.input.model.label` 单占插槽冲突）。
- **AC-2.2**：仅当会话当前选中的模型所属 `provider` 属于本插件配置的 `providers` 时渲染 `5h | XX%`；切换到其他 provider 模型时立即隐藏（返回 `null`）。
- **AC-2.3**：5 小时额度优先匹配所选模型家族（Claude / Gemini / GPT）的 `5h` bucket，缺失时回退到该模型自身的 `remainingFraction`；格式形如 `5h | 87%`。
- **AC-2.4**：鼠标悬停或键盘聚焦该指示器时，通过 `document.body` Portal（无 `react-dom` 时自动降级定位）展示完整额度浮层，包含当前账号信息、当前模型额度与重置时间、全部 `quotaGroups` 的 5h/周进度条与重置时间。
- **AC-2.5**：在缺失 `modelDirectories` 或局部异常的宿主环境下，`client.js` 的 `apply()` 依然永不抛异常，不影响设置页与主聊天框运行。

### AC-3：多账号存储、管理与向后兼容
- **AC-3.1**：现有单账号用户升级后无需重新登录；只有 1 个账号时保持与 v0.1.0 兼容的凭据数据结构，添加第 2 个账号时无缝升级为多账号结构（`version: 2`），并在 DSH `credentials` 服务与 `0600` 文件镜像同步保存。
- **AC-3.2**：支持通过设置页「账号」tab 或 `/agw login` / `/agw import` 添加多个账号；重复登录同一 Google 账号时更新原记录而不产生重复条目；支持手动切换当前激活账号与单独登出某账号。
- **AC-3.3**：切换账号时通知 `ModelCatalog` 与 DSH 模型目录刷新，同时保留各账号在 `catalog-cache.json` 中独立的已验证模型列表。

### AC-4：额度耗尽自动切换账号（保留原模型）
- **AC-4.1**：`Config` 新增 `autoSwitchAccount`（默认 `true`）。当 `autoSwitchAccount === true` 且存在多个已登录账号时：
  - **被动切换**：`stream()` 尚未向调用方发射任何输出块（`!hasEmitted.value`）时遇到 `429`（含流内 `429`/`RESOURCE_EXHAUSTED` 错误事件），记录当前账号该模型的耗尽冷却时间，自动切换至下一个可用候选账号，并使用**完全相同的 `options.model` 与 `options.reasoningEffort`** 透明重试本次请求。
  - **主动预检切换**：请求开始前若当前账号在 `ModelCatalog` 中已知该模型 `remainingFraction === 0` 或处于耗尽冷却期内，且存在可用候选账号，直接预切换到候选账号再发请求，减少一次无效 `429`。
- **AC-4.2**：候选账号选择优先挑选已知该模型可用且剩余额度更高的账号，跳过已知 `disabled`（不提供该模型）或同样处于该模型耗尽冷却的账号。
- **AC-4.3**：并发安全——多个并发请求同时在账号 A 遭遇 `429` 时，通过 CAS 式 `switchAccountIfCurrent(failedAccountId, targetId)` 防止连续误跳账号 B；每次请求每个账号至多尝试一次，防止死循环。
- **AC-4.4**：所有账号均耗尽或未开启 `autoSwitchAccount` 时，不掩盖错误，按原有语义抛出带 `providerRetryAfterMs` 的 `RATE_LIMIT` `LlmError`。
- **AC-4.5**：若 `hasEmitted.value === true`（流已输出部分文本/工具调用），严禁跨账号重放请求。
