# CodeLight 原生窗口界面

> **延期研究（2026-10-31）**：当前 CodeLight 发行是 Codex 原生会话专用。本文件保留此前的窗口/AX 研究与验证边界，不表示当前已启用窗口共享或其他 harness。窗口 ID、截图与 AX 控件不计为 Codex session 支持；是否启用留待后续决定。当前范围以 [产品合同](codelight-product.md) 为准。

原生界面以现有 Happy 导航、主题、字体、加密附件与图片预览为基础。window mode 按实际应用/PID/window/captureStamp 绑定，不把窗口 ID 当 conversation 或 turn ID。

- Mac owner/lease 和底层窗口 backend 是操作所有者；手机只保存草稿和待确认操作摘要。
- 通过 `window-control({commandId,action,payload})` 发送有限窗口动作。每次携带所见 captureStamp；未知回执只查询，不能自动换 ID 重发。
- 截图只能读该 source 绑定的 encrypted imageRef，手机不传本机路径。放大、平移、关闭复用原生图片预览。
- 坐标点击使用所见截图的比例和 stamp，图片未加载或不支持坐标控制时关闭点击。放大后的点击需要准确反变换，窗口改变时拒绝旧动作。
- 控件只来自原应用真实 AX observation。先选择一个可编辑的空输入，明确填入草稿；不自动点击发送、不声称已经进入 Agent。Terminal/iTerm/Warp 的文字能力由 adapter 关闭。
- window mode 与 chat mode 分开渲染，不出现默认模型选择或假 Native session 状态。锁屏、权限缺失、owner 未连接时显示真实状态并关闭控制。

2026-10-29 实际原生 ZCode 窗口验收发现：仅替换聊天 content 仍会挂载 AgentContentView 的 EmptyMessages overlay 和聊天 composer，空窗口来源的 Open 按钮因此存在但不可点击。窗口模式必须独占内容 surface，不挂载聊天 placeholder、composer、floating dock、恢复提示、goal/question/activity 或 CLI warning；由 NativeWindowPanel 独立提供状态、草稿和控制。普通 session 模式保留现有聊天 surface，模式切换不能改变 Hook 调用顺序。回归覆盖窗口模式排除聊天 overlay/input、普通模式完整保留聊天，并实际核对原生 Open isHittable 与真实加密窗口预览。

同一 overlay 也会覆盖首次配对后尚无消息的 Codex 来源激活 banner（AgentContentView 的 placeholder 是后挂载的绝对定位 ScrollView）。session 模式显示 NativeSourceBanner 时只排除聊天 placeholder，保留本地 composer 草稿及现有发送闸门；来源激活后恢复普通 empty/history 展示。验收使用正常新账号的空 descriptor，Open 后读取既有原会话历史，不发送新的模型请求。

验收：多 app 真实不可用状态、图片原生缩放/平移、坐标比例/越界、旧 stamp 拒绝、窗口控件身份、草稿持久化、unknown 不重发、关闭 source observer 不停止原应用。
