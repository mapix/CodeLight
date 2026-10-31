# Native 输入回显与验收

## 2026-10-29 CodeLight 验证

XCTest 在点击发送前检查输入，发现高速输入 `Reply` 成为 `Rply`。未发送丢字内容。NativeTextField 的 native 文本由原 TextInput 拥有，但父组件较旧的 value 回显可能与较新的 native edit 同时到达；当前命令使用最新 eventCount，不能把旧回显当作用户的程序化修改覆盖新编辑。

### 规则

- Native edit 的 text/eventCount 作为同一次事件记录；父组件回显匹配未消费的 native edit 时，只确认该回显，不写 native。
- 后续真正外部 value（如清空、恢复草稿、补全）仍用原 setTextAndSelection 路径，保留 eventCount 和光标语义。
- 首次非空 React tree seed 在实际 render 时取最新 native text，而不是锁住第一个字符；后续 seed 保持不变，以免每次键入重设 attributedText。
- UI 测试必须先核对完整输入再点击发送。输入失败不得触发模型，也不得把重跑变成重复发送。
- 模拟器 Release 包不包含私密 token/secret；测试窗口及测试账号与用户工作会话隔离。

### 验证

回归覆盖：旧父回显不能覆盖更新的 native 字符、跳过中间回显、外部清空仍生效、相同文字的后续外部编辑不能被永久吞掉、队列有界。随后使用真实原生模拟器重复高速输入并精确检查，才允许一次发送。
