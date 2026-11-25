# Feature Progress: UI Quota Polish

- **状态**：已完成并验证通过（2026-11-26）
- **规格**：[SPEC.md](SPEC.md)
- **修改内容**：
  1. 重构 `client.js` 中 `ModelsPanel` 与 `Quota` 卡片视觉层级（参考图 2）：头部左右分栏、双栏配额卡片（左标题 `13px` / 右粗体 `20px` / 通栏 `5px` 进度条 / 底行左窗口右重置时间）、四级层次可用模型卡片（`14px` 粗体模型名 + `18px` 百分比 / 通栏 `5px` 进度条 / 次级状态与档位+重置时间 / 分割线公告说明），并将不可用模型收拢为可折叠 `<details>` 区域。
  2. 调整 `client.js` 中 `.agw-composer-chip` 样式：去掉外框与底色（`border: none; background: transparent;`），采用 `font-family: inherit; font-size: 13px; line-height: 20px; font-weight: 600; height: 28px;`，与 DSH `ModelSelect` `.trigger`（`13px / 20px / 400 / 28px`）完全对齐且略粗。
- **验证结果**：`npm run verify`（153/153 通过，含 `tsc -p tsconfig.client.json --noEmit`）与 `npm run pack:local` + `release-check.mjs --tag v0.1.0 --archive-dir .` 均退出 `0`。
