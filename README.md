# dsh-antigravity-gateway

中文 | [English](README.us.md)

在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 里使用
Google Antigravity 的模型：Claude、Gemini、GPT-OSS。自带 Google OAuth 登录，
不需要安装 Antigravity IDE 或 CLI。

**设计特点**：模型目录以**每个账号自己的实时返回**为准（服务器按计划/区域
返回不同目录），不做客户端退役拦截——你的账号在 Antigravity 里能用什么，
这里就提供什么。与 `dsh-antigravity-auth` 可共存，设置页一键登录/导入。

> **非官方、实验性、仅限个人使用。** Google 不支持第三方 Antigravity 登录
> 工具，账号可能被限制或封禁。使用前请阅读
> [Google FAQ](https://antigravity.google/docs/faq/) 和
> [附加条款](https://antigravity.google/terms)。私有端点可能随时变更或停止
> 服务，不要用于生产负载。

## 功能

| 能力 | 入口 |
|---|---|
| 语言模型 | 模型选择器中的 `Antigravity Gateway` provider（路由名 `antigravity-gateway`），自动过滤当前账号计划不可用模型 |
| Claude Opus / Sonnet | 4.6 与 5.5 系列，按账号目录提供，含 low/medium/high 思考档位 |
| Gemini 3.8 Flash / 4 Neon / Hydrogen / Carbon / Argon | 含 XHigh（Neon/Hydrogen），不可用计划模型在设置页标明原因 |
| GPT-OSS 120B Medium | `gpt-oss-120b-medium` |
| 账号与额度检测 | 设置 → Antigravity Gateway（多账号管理/切换、账号与模型额度进度条及重置时间倒计时、诊断日志），或 `/agw status · accounts · switch · login · cancel · logout · import · models · refresh` |
| 聊天框额度提示 | 选中本插件模型时，在聊天框模型名左侧显示简略 5h 额度（如 `5h | 87%`），悬停展示完整账号与各模型/分组额度 |
| 多账号自动切换 | 某账号额度耗尽（`429` 或已知 0%）时自动切换至可用备用账号并保留原所选模型（`autoSwitchAccount: true`） |
| 诊断日志 | `antigravity_gateway_log` 工具（read/stat/level/clear），有界、脱敏、轮转 |
| 图片输入 | 会话图片附件以 `inlineData` 发送（可配置上限） |

与 `dsh-antigravity-auth` **可共存**：provider 路由名不同，互不冲突；
`/agw import` 还能显式复用它的已登录账号（只读，不改动它的存储）。

## 快速开始

### 1. 环境要求

- 可用的 DSH 安装（开发基线：DSH `0.2.2-rc.5`，Desktop profile）。
- Node.js `>=20.18.1`。
- 有 Antigravity 访问权限的 Google 账号（可用模型随账号计划不同）。
- 登录需要 Host 本机能打开浏览器，OAuth 回调占用 `127.0.0.1:51121`
  （与 Antigravity CLI 注册的回调一致，可用 `oauthPort` 配置）。

### 2. 安装

从 GitHub Release 下载 tgz 后：

```sh
dsh plugin --profile desktop add ./dsh-antigravity-gateway-0.2.0.tgz
```

或在 DSH 的 **Plugins → Add plugin** 里选择本地目录/压缩包。
也可以从源码安装：

```sh
git clone https://github.com/Vikrant-Aleph/dsh-antigravity-gateway.git
cd dsh-antigravity-gateway
npm ci
npm run build
dsh plugin --profile desktop add .
```

安装后重启 Host 并刷新页面。插件列表里应出现「Antigravity Gateway」。

### 3. 登录

**设置页（推荐）**：打开 **设置 → Antigravity Gateway**，在「账号」tab 点
**使用 Google 登录**，浏览器完成授权后卡片自动变为已登录。同一页还能：
从 antigravity-auth 一键导入账号、退出登录、查看「模型」tab 的账号实时
目录、在「诊断日志」tab 读/清日志。

已经装过 `dsh-antigravity-auth` 并登录的话，点 **从 antigravity-auth 导入**
即可（只读它的 auth.json，随后自行刷新令牌）。

浏览器没自动打开时，卡片上附有授权链接，手动点开即可
（URL 不含密钥，PKCE verifier 只留在 Host 内存）。

也可以用命令登录：

```text
/agw login     # 打开浏览器完成 Google 授权，然后 /agw status 查看结果
/agw import    # 显式导入 dsh-antigravity-auth 的当前账号
```

### 4. 选模型

模型选择器里选 `Antigravity Gateway` 下的模型，例如
`claude-sonnet-5-5`。`/agw models` 列出当前账号实际可用的目录。

## 命令

```text
/agw status         # 登录状态、多账号数、凭据后端、项目 id、令牌过期时间（默认动作）
/agw accounts       # 列出全部已登录账号及当前激活标记
/agw switch <目标>  # 按序号、邮箱或 id 切换当前激活账号
/agw login          # 启动 Google OAuth（PKCE S256 + 环回回调）
/agw cancel         # 取消进行中的登录
/agw logout [all]   # 移除当前账号凭据（加 all 移除全部账号）
/agw import         # 从 dsh-antigravity-auth 导入账号到账号列表
/agw models         # 检测并列出账号可用/不可用模型、计划等级与剩余配额
/agw refresh        # 强制重新探测上游目录与配额
```

`/antigravity-gateway` 是 `/agw` 的全名别名。

## 配置

插件行 id 为 `dsh-antigravity-gateway`。常用字段（完整 schema 见
[TECHNICAL.md](TECHNICAL.md) §6）：

```yaml
- id: dsh-antigravity-gateway
  config:
    providers: [antigravity-gateway]   # 路由名，避免与其他插件冲突
    extraModels: []                   # 强制展示的固定模型 id
    promptCompatibility: true         # 改写触发 429 的 harness 身份句
    autoSwitchAccount: true           # 额度耗尽时自动切换到备用账号并保留原模型
    imageInput: true                  # 图片附件 inlineData 输入
    proxyUrl: ''                      # 显式 HTTP 代理；空则读 HTTPS_PROXY 等
    useSystemProxy: true              # 无 env 时读 Windows 系统代理
    logLevel: info                    # debug|info|warn|error|off
    oauthPort: 51121
```

代理：私有请求与 OAuth 令牌交换按 `proxyUrl` 配置 → `HTTPS_PROXY →
https_proxy → ALL_PROXY → all_proxy` → **Windows 系统代理**（注册表
ProxyServer，5 分钟缓存，`useSystemProxy: false` 可关）的顺序取用，
`NO_PROXY` 优先；仅支持 `http://` 代理 URL 经 CONNECT 隧道 HTTPS。
GUI 启动的 Host 不会继承 shell 的代理环境变量，系统代理自动检测让插件与
浏览器/IDE 走同一路由。网络排查可参考 dsh-antigravity-auth README 的
代理方案说明。

## 诊断日志

- 位置：默认 `~/.dsh/logs/dsh-antigravity-gateway/`；Host 进程设置了
  `DSH_PROFILE_DIR` 时在 `<profile>/logs/dsh-antigravity-gateway/`（或 `logDir` 配置）。
- 有界：单文件 ≤ `logMaxBytes`（默认 512 KiB），最多 `logMaxFiles` 个轮转文件，
  超限时最旧的先删。
- 脱敏：配置密钥、`Bearer …`、Google 访问/刷新令牌形状一律替换；
  只记录元数据（模型、状态码、耗时、token 数），**不记录消息内容**。
- 读取：agent 工具 `antigravity_gateway_log`（read/stat/level/clear），
  或 RPC `/api/antigravity-gateway-logs/*`。
- 请求级明细在 `debug` 级；成功请求摘要在 `info` 级；失败在 `warn` 级。
- `dumpRequestsTo` 可把完整请求 envelope 落盘供协议调试——默认关闭，
  内容含会话文本，用完即删。

## 开发

```sh
npm ci
npm run typecheck   # 覆盖 src/**/*.ts 与 client.js
npm run build
npm test            # 先构建再运行 157 个离线测试，不访问 Google
npm run verify      # typecheck + build + 全部离线测试
```

测试覆盖：模型路由解析（wire 枚举与档位预算）、工具 schema 清洗、请求 envelope 与
标签形状、SSE 解析、OAuth 流程、日志边界与脱敏、可用性与配额解析（含禁用模型
过滤与缓存兜底）、并发原子写盘、并行同名工具调用、四层架构单向依赖守卫、
`client.js` 加载与 RPC 契约一致性，以及对本机假端点的端到端适配器流（文本/
工具调用/401 刷新重放/404 诊断/429/503 容量退避/上下文溢出/历史签名回放）。
更多开发规范与安全策略见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。

### 发布流程

推送版本标签即自动发布：

```sh
# 1. 更新 package.json 版本与 CHANGELOG.md 对应小节
# 2. 提交并打标签
git tag v0.1.1
git push origin main v0.1.1
```

`release.yml` 会校验标签/版本/CHANGELOG 一致 → `npm ci` → 构建 + 离线测试 →
打包并校验归档内容 → SHA256 校验和 → 创建 GitHub Release（说明取自
CHANGELOG 对应小节，附 tgz 与 SHA256SUMS）。已存在的 Release 不会被覆盖。
CI（`ci.yml`）在每次 push/PR 时跑 Node 22/24 × Ubuntu/Windows 矩阵。

## 已知限制

- 设置页需要 Host 的 WebServer 绑定 `127.0.0.1`（Desktop 默认即是）；
  其他绑定下账号操作按安全策略关闭（与 dsh-antigravity-auth 一致）。
- 只做文本输出；图片生成、搜索 grounding、视频理解不在本插件范围
  （可继续用 dsh-antigravity-auth 的对应能力）。
- TLS 用 Node 栈，不是 CLI 的 Electron 指纹；截至 2026-11-22 端点不检查
  TLS 指纹（有日期的观测，见 TECHNICAL §2.4）。
- 模型可用性与限额以账号后端为准；固定快照中的限额为社区抓包观测值，
  非官方公布值。

## 文档

- [技术设计](TECHNICAL.md) · [Technical design (English)](TECHNICAL.us.md)
- [更新日志](CHANGELOG.md) · [GitHub Releases](https://github.com/Vikrant-Aleph/dsh-antigravity-gateway/releases)
- [问题反馈](https://github.com/Vikrant-Aleph/dsh-antigravity-gateway/issues)
  （附插件/DSH 版本、平台、错误码或 HTTP 状态；**不要**附凭据、授权 URL、
  令牌或完整流量抓包）

## 许可

[MIT](LICENSE)
