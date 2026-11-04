# 黑白灰控件改版 · Design QA

日期：2026-11-03

## 目标与范围

依据用户提供的参考图，将现有画布操作界面改为黑白灰色调，采用柔和圆角边框、灰色填充滑槽和浅色圆角矩形滑块。按用户要求降低滑杆高度；保留应用布局、中文文案、现有字体与 Lucide 图标，以及实际媒体、画笔色板和 3D 场景的颜色数据。

参考图：`C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-57204580-3ddb-47be-a1db-a8f9e0bf905e.png`（576 × 1481）。这是控件风格参考，不是要求逐像素复制整页布局。

## 实现规格

- 面板：炭黑 `#1d1d1d`，18px 圆角；输入控件：`#292929`，10px 圆角。
- 滑槽：20px 高、7px 圆角；交互区域 28px 高；进度填充 `#424242`。
- 滑块：12 × 16px、5px 圆角，浅灰 `#e5e5e5`。
- 数值徽标：深灰底、细边框、等宽数字；选中分段项采用浅底深字。
- 手绘、元素编辑、3D、多角度与视频时长共用 UnifiedRange；删除旧的独立原生滑杆样式。

## 浏览器检查

通过 In-App Browser 检查 `http://localhost:5174/` 的独立测试画布，未调用外部生成服务。用户原有 `http://127.0.0.1:5174/` 页面保持打开。

- 默认视口 1280 × 720：手绘、元素编辑、3D、多角度、视频生成面板。
- 紧凑视口 800 × 720：多角度面板切换为单列，内部可滚动；面板及内容区 scrollWidth 均等于 clientWidth，无横向溢出。检查后已恢复视口。
- 手绘粗细：ArrowRight 8 → 9；End → 100，填充 100%；Home → 1，填充 0%；点击中点 → 51。滑槽实测 20px。
- 多角度：方向键 0° → 1°；正面俯拍预设更新垂直值至 36°；重置恢复默认值。
- 3D：无模型时焦距滑杆禁用；创建测试方体后可用，方向键 50 → 51。模型材质颜色、场景颜色和变换轴语义颜色保留。
- 视频时长：5 秒 → 6 秒；模型菜单背景为深灰、选中项可辨认。
- 键盘焦点采用单层圆角描边；没有新增浏览器控制台错误。

## 视觉对照与修正记录

将参考图与实际渲染截图放入同一次图像检查，对照控件设计而不是不同产品的版面结构。

第一轮发现并修复：

- P2：手绘输入旧焦点描边叠加在新滑槽焦点框上。已让 range 仅使用统一组件的焦点样式，并重新截图验证。
- P2：多角度球形网格及模型库图标仍存在装饰性色彩。已改为中性灰；实际模型与色板保持原色。
- P2：元素编辑数值徽标原有负 margin 不适合新高度。已改为标签与徽标同行、滑杆独占下一行。

最终检查：

| 检查项 | 结果 |
| --- | --- |
| 字体与层级 | passed — 保留应用字体，标题、标签、数值层次清晰 |
| 间距与布局 | passed — 紧凑滑杆不遮挡相邻控件，侧栏保持滚动 |
| 颜色与设计变量 | passed — 中性灰表面、细边框、浅色滑块与选中项符合参考 |
| 图标与素材 | passed — 使用现有图标；用户图像、模型和画笔颜色不做灰度处理 |
| 文案与状态 | passed — 原中文操作说明保留；选中、禁用、焦点状态可辨认 |
| 交互与响应式 | passed — 输入数值同步、预设重置、窄屏滚动均正常 |

截图：

- `C:/Users/Administrator/AppData/Local/Temp/canvas-monochrome-angle.png`
- `C:/Users/Administrator/AppData/Local/Temp/canvas-monochrome-angle-narrow.png`
- `C:/Users/Administrator/AppData/Local/Temp/canvas-monochrome-sketch.png`
- `C:/Users/Administrator/AppData/Local/Temp/canvas-monochrome-sketch-focus.png`
- `C:/Users/Administrator/AppData/Local/Temp/canvas-monochrome-element.png`
- `C:/Users/Administrator/AppData/Local/Temp/canvas-monochrome-3d.png`
- `C:/Users/Administrator/AppData/Local/Temp/canvas-monochrome-video.png`

## 工程验证

- `npm run build`：通过；现有大体积 chunk 提示仍存在。
- `npm run lint`：通过。
- `node --test tests/*.test.mjs`：68 项，65 通过、0 失败、3 跳过（可选像素/集成测试环境未启用）。
- `git diff --check`：通过。
- 未新增阻塞问题；付费生成、真实模型上传与所有浏览器引擎未在本次样式验证中执行。

## 2026-11-04 · 柔和描边与内发光修订

最新依据：`C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-b5a3ade2-8e37-42ae-add4-b578bd2d0b4e.png`。用户明确要求减弱上一版玻璃凸起、提亮背景、采用浅灰描边和轻微内发光，因此本轮以这张图替代 CK.jpg 的明显凸起方向。

- 面板背景提亮为接近 `#292929`–`#242424` 的低对比渐变，控件为 `#303030`–`#2b2b2b`。
- 描边保留轻微灰阶变化，移除明显的上高光/下暗边；采用对称的 1px 内缘与低透明度内发光。
- 外阴影降低至面板 12px / 36px、普通框 6px / 18px，降低悬浮凸起感。
- 主面板、节点、浮动生成框、工具条、下拉菜单、输入框、内层卡片共享材质变量。Run 及确认按钮保留浅底深字；修复材质覆盖导致确认按钮对比度不足的问题。
- 滑槽保持 20px；媒体、画笔颜色和 3D 场景数据不做颜色处理。

在 In-App Browser 的独立 localhost 测试页以 1280 × 720 检查设置弹窗、视频节点/生成面板/展开菜单、手绘和多角度面板。确认按钮计算颜色为 `rgb(32,32,32)`，配浅色渐变背景；视频滑杆从 5 秒变为 6 秒，手绘粗细从 8 变为 9，滑槽实测 20px。设置弹窗与各编辑面板可正常打开、关闭。

最新参考图、节点截图和多角度截图在同一次图像输入中对照：字体与文案沿用应用；圆角与间距无新增遮挡；灰色表面、浅灰边缘及轻微内发光符合本轮方向；现有图标清晰，图片未灰度化。五项视觉检查通过，未发现本轮材质修改引入的 P0/P1/P2 问题。设置弹窗截图保存曾暂时不可用，后续节点和编辑器截图保存成功。

本轮证据：

- `C:/Users/Administrator/AppData/Local/Temp/canvas-soft-glass-nodes.png`
- `C:/Users/Administrator/AppData/Local/Temp/canvas-soft-glass-sketch.png`
- `C:/Users/Administrator/AppData/Local/Temp/canvas-soft-glass-angle.png`

本轮验证：build、lint、diff check 通过；68 项现有测试中 65 通过、3 按环境条件跳过、0 失败。未调用付费生成。布局结构及断点不变，本轮未重复上一轮窄屏检查。

## 2026-11-04 · 加粗渐变描边、压暗磨砂背景

按用户最新反馈，主要面板、节点、菜单、输入框、内层卡片及滑槽的描边加粗至 2px；采用五段灰阶渐变，顶部与转角略亮，中段更柔和。框内改为 `#222222` 至 `#141414` 的深灰渐变，叠加低透明度雾面高光；面板背景模糊调至 28px，浮动框为 22px。沿用轻微内发光与弱外阴影。

同一次视觉对照中比较上一版与本轮截图：新描边更清晰，背景明显压暗，渐变和圆角连续；文字、控件间距、图标及中文文案正常。1280 × 720 浏览器检查设置弹窗及多角度面板；实测弹窗描边 2px、模糊 28px；手绘滑槽描边 2px、总高仍为 20px。多角度方向键及重置正常。测试标签页已关闭。此次仅调整两份样式文件，build、lint 和 diff check 均通过，未重复运行刚通过的业务测试。

截图：`C:/Users/Administrator/AppData/Local/Temp/canvas-dark-frosted-gradient.png`。

本轮视觉结果：passed；未发现本轮修改引入的布局遮挡、文字对比度或交互问题。

## 2026-11-04 · 描边厚度微调

按用户指定，将共享框体描边变量及滑槽默认描边由 2px 改为 1.2px。仅修改厚度数值，沿用上一轮渐变与磨砂材质；未重复运行构建或浏览器检查。

## Final result

passed
