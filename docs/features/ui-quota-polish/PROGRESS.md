# Feature Progress: UI Quota Polish

- **状态**：已完成并验证通过（2026-11-26）
- **规格**：[SPEC.md](SPEC.md)
- **修改内容**：
  1. 重构 `client.js` 中 `ModelsPanel` 与 `Quota` 卡片视觉层级（参考图 2）：头部左右分栏、双栏配额卡片、可折叠 `<details>` 不可用模型区。
  2. 调整 `client.js` 中 `.agw-composer-chip` 样式：去掉外框与底色（`border: none; background: transparent;`），采用 `font-family: inherit; font-size: 13px; line-height: 20px; font-weight: 600; height: 28px;`，与 DSH `ModelSelect` `.trigger` 完全对齐且略粗。
  3. 根据实机截图二次精简：配额卡片左下角窗口标签改为加粗简写 `5h` / `weekly`（`.agw-quota-window`）；可用模型列表移除重复额度/进度条、模型 ID（保留显示名）与模型介绍文本，仅保留模型名称、标签、可用状态与档位。
  4. 去除聊天框悬停浮层中的「当前所选模型」额度块及 `/agw models` 单模型行末尾的 `quota: XX%`，全部额度统一按两大配额分组展示。
- **验证结果**：`npm run verify`（153/153 通过，含 `tsc -p tsconfig.client.json --noEmit`）与 `npm run pack:local` + `release-check.mjs --tag v0.1.0 --archive-dir .` 均退出 `0`。
