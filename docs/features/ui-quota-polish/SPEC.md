# UI 优化规格与验收标准：设置页层级排版与聊天框额度无框对齐（ui-quota-polish）

## 1. 需求摘要
1. **设置 → 模型信息视觉层级优化**（对应用户图 1 痛点与图 2 参考设计）：
   - 顶部采用清晰的标题/状态元信息 + 右侧刷新操作栏。
   - 配额卡片采用双栏卡片（左标题 `13px`、右大号粗体百分比 `20px`、中间通栏 `5px` 细进度条、底部左窗口/右重置时间 `12px`）。
   - 可用模型列表每张卡片分四级层次：① 主标题（模型显示名 `14px` 粗体 + 副 ID + 公告徽标）与右侧大号百分比（`18px` 粗体）；② 通栏 `5px` 进度条；③ 次级元信息行（左状态/档位，右重置时间 `12px`）；④ 仅当存在上游说明时以细分割线隔开呈现描述文本。
   - 不可用模型折叠收纳于底部可展开区域（存在可用模型时默认收起），保持主视图整洁。
2. **聊天框模型名称左侧额度样式对齐**：
   - 去除 `.agw-composer-chip` 的外框边框与常态背景底框；
   - 继承宿主模型名同款 UI 字体（`font-family: inherit`，去掉等宽字体），保持与 `ModelSelect.module.css` `.trigger` 一致的字号与行高（`font-size: 13px; line-height: 20px; height: 28px;`），字重设为 `600`（略粗于模型名的 `400`），在 28px 工具栏行内完全垂直居中对齐；
   - 保留悬停/聚焦弹出 `document.body` 完整额度卡片功能。

## 2. 验收标准
- `npm run typecheck`（含 `tsconfig.client.json` `checkJs`）零错误；
- `npm run verify`（全量离线测试）与 `npm run pack:local` + `release-check.mjs` 全通过；
- `tests/client-contract.test.mjs` 验证 `.agw-composer-chip` 无框且字体/字号/高度与模型名对齐，以及 `ModelsPanel` 层次化进度条卡片与可折叠不可用列表正常渲染。
