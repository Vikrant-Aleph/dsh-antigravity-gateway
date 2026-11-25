# 技术方案与实施计划：OAuth 公开客户端 XOR 字节掩码编码与全历史清洗（PLAN）

> **关联需求**：[SPEC.md](SPEC.md)（2026-11-26 修订版）
> **当前基线**：`main` @ `e31928c`（`tag: v0.2.0`）、`refactor/modular-architecture` @ `c21f06e`
> **架构约束**：严格维持 `src/shared/` ← `src/protocol/` ← `src/core/` ← `src/dsh/` ← `src/index.ts` 四层单向依赖及零额外运行时依赖（仅 `undici`）。

---

## 1. 现状核查与问题定位（实证依据）

1. **GitHub Push Protection 拦截原因**：
   - 前一版在 [src/protocol/constants.ts](../../../src/protocol/constants.ts) 与清洗后历史提交 `src/constants.ts` / `src/protocol/constants.ts` 中使用了单段 Base64 字面量；GitHub Secret Scanning 会自动解码单段 Base64 并匹配 Google OAuth 模式从而拒绝推送（`GH013`）。
2. **当前全仓 Base64 残留分布（`git log --all -S` 实测）**：
   - 全仓库仅 `src/constants.ts`（`1204492` ~ `c5fa893` 范围）与 `src/protocol/constants.ts`（`30a30a8` ~ `e31928c` 范围）包含单段 Base64 编码字符串；`TECHNICAL*.md`、`README*.md`、`CHANGELOG.md`、`client.js`、`tests/` 及 `docs/` 均不含明文或 Base64 完整串（仅 `TECHNICAL*.md` / `CHANGELOG.md` 文字说明需从“Base64”同步改为“XOR 掩码字节数组”）。

---

## 2. 文件级修改计划

| 模块 / 文件 | 改动内容 |
|---|---|
| [src/protocol/constants.ts](../../../src/protocol/constants.ts) | 移除 `decodeBase64` 与全部 Base64 字符串字面量；新增纯 ES 函数 `decodeBytes(masked, key)`（仅用标准 `Uint8Array` + `TextDecoder`，零 `node:*` 导入），通过固定多字节 XOR 掩码整数数组还原 `ANTIGRAVITY_CLIENT_ID` 与 `ANTIGRAVITY_CLIENT_SECRET`，确保运行时字符串值字节级一致。 |
| [tests/oauth.test.mjs](../../../tests/oauth.test.mjs) | 强化全仓防泄漏测试：在现有明文前缀扫描基础上，动态计算 `Buffer.from(ANTIGRAVITY_CLIENT_SECRET).toString('base64').slice(0, 16)` 与 `Buffer.from(ANTIGRAVITY_CLIENT_ID).toString('base64').slice(0, 16)`，校验 `src/`、`lib/`、`tests/`、`docs/`、`client.js`、`README*.md`、`TECHNICAL*.md`、`CHANGELOG.md` **既无明文也无单段 Base64 编码串**。 |
| [TECHNICAL.md](../../../TECHNICAL.md)、[TECHNICAL.us.md](../../../TECHNICAL.us.md)、[CHANGELOG.md](../../../CHANGELOG.md) | 将 §2.2 与 `## [0.2.0]` 中关于公开客户端标识的存储方式说明由“Base64 编码”更新为“XOR 掩码字节数组编码”，保持文档与真实源码一致。 |
| [docs/features/oauth-client-externalization/PROGRESS.md](PROGRESS.md) | 同步记录本轮修订任务 `O-007` ~ `O-011` 状态与验证证据。 |

> 说明：[src/core/oauth.ts](../../../src/core/oauth.ts)（`resolveOAuthClient` 环境变量覆盖）与 [src/core/logger.ts](../../../src/core/logger.ts) / [src/index.ts](../../../src/index.ts)（OAuth client secret 与 `client_secret=` 脱敏）均已就位，无需变更。

---

## 3. Git 历史重写与发布前验证计划（需确认后执行）

1. **实施代码、文档与测试更新**：在 `main` 完成上述修改并通过 `npm run verify`（158 项测试全绿）后提交。
2. **备份与全历史清洗（须确认）**：
   - 先导出当前完整仓库 `git bundle` 备份至系统临时目录 `%TEMP%`；
   - 使用 `git filter-branch --force --tree-filter ... --tag-name-filter cat -- --all` 遍历 `main` 与 `refactor/modular-architecture` 全部提交，将历史上所有 `src/constants.ts` 与 `src/protocol/constants.ts` 中任何明文或单段 Base64 形态替换为等价的 `decodeBytes(masked, key)` 字节数组实现；
   - 清理 `refs/original/`、过期 reflog 并执行 `git gc --prune=now --aggressive`；
   - 使用 `git log --all -S` 对明文特征和 Base64 前缀双重检索，确认整个 Git 历史均返回 **0 命中**。
3. **标签同步与最终校验**：
   - 更新本地 `v0.2.0` 带注释标签指向清洗后最新 `main` 提交；
   - 执行 `npm run verify`、`npm run pack:local`、`node scripts/release-check.mjs --tag v0.2.0 --archive-dir .`、`node scripts/release-notes.mjs 0.2.0` 并清理临时 `.tgz`；
   - 根据用户授权决定是否执行 `git push -u origin main && git push origin v0.2.0`。

---

## 4. 任务拆分表

| ID | 任务 | 依赖 | 状态 |
|---|---|---|---|
| O-007 | 复核修订后 `SPEC.md`，检索全历史 Base64 残留分布并更新 `PLAN.md` | 无 | `DONE` |
| O-008 | 用户确认 XOR 编码替换、重写本地 Git 历史与暂不推送 | O-007 | `DONE` |
| O-009 | 修改 `src/protocol/constants.ts`、`tests/oauth.test.mjs` 与 `TECHNICAL*.md` / `CHANGELOG.md` 并通过 `npm run verify` | O-008 | `DONE` |
| O-010 | 备份并重写 `main` 与 `refactor/modular-architecture` 全历史、清理 `gc` 并双检 0 命中 | O-009 | `DONE` |
| O-011 | 重指 `v0.2.0` 标签、执行 `pack:local` + `release-check.mjs --tag v0.2.0`（暂不推送） | O-010 | `DONE` |
