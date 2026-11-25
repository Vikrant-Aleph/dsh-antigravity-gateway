# UI 优化规格与验收标准：设置页层级排版与聊天框额度无框对齐（ui-quota-polish）

## 1. 需求摘要
1. **设置 → 模型信息视觉层级优化**（对应用户截图反馈）：
   - 顶部采用清晰的标题/状态元信息 + 右侧刷新操作栏。
   - 配额卡片采用双栏卡片（左组名 `13px`、右大号粗体百分比 `20px`、中间通栏 `5px` 细进度条、底行左侧**加粗简写窗口标签 `5h` / `weekly`**、右侧重置时间 `12px`）。
   - 可用模型列表每张卡片简洁呈现模型显示名（`14px` 粗体）、公告徽标、状态徽标与档位信息；因上方配额卡片已完整展示额度，可用模型卡片不再重复展示额度/进度条，有模型显示名时不再显示模型 ID，也不再展示模型介绍文本。
   - 不可用模型折叠收纳于底部可展开区域（存在可用模型时默认收起），保持主视图整洁。
2. **聊天框模型名称左侧额度样式对齐**：
   - 去除 `.agw-composer-chip` 的外框边框与常态背景底框；
   - 继承宿主模型名同款 UI 字体（`font-family: inherit`，去掉等宽字体），保持与 `ModelSelect.module.css` `.trigger` 一致的字号与行高（`font-size: 13px; line-height: 20px; height: 28px;`），字重设为 `600`（略粗于模型名的 `400`），在 28px 工具栏行内完全垂直居中对齐；
   - 保留悬停/聚焦弹出 `document.body` 完整额度卡片功能。

## 2. 验收标准
- `npm run typecheck`（含 `tsconfig.client.json` `checkJs`）零错误；
- `npm run verify`（全量离线测试）与 `npm run pack:local` + `release-check.mjs` 全通过；
- `tests/client-contract.test.mjs` 验证 `.agw-composer-chip` 无框且字体/字号/高度与模型名对齐，配额卡片展示加粗 `5h`/`weekly` 标签，以及可用模型行隐藏冗余 ID/额度/介绍。
