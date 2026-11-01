# CodeLight 产品与验收合同

## Control responsiveness and observation budget — 2026-11-01

- A large legacy Codex observer checkpoint moves already-acknowledged event
  bodies and prefixes outside the current observation window into immutable
  encrypted history archives before the 32 MiB active checkpoint limit is
  reached. Stable event IDs, row aliases/revisions, current prefixes, command
  plans and receipts remain in the active checkpoint. An archived prefix that
  re-enters the current window is authenticated and restored before applying
  native revisions. Pending event bodies and
  unknown native operations are never discarded or redispatched.
- Archive files are made durable before their references replace acknowledged
  bodies in the active checkpoint. A restart can reuse the same authenticated
  archive after an interrupted migration. Archive failure leaves the original
  active bodies intact. Historical audit/recovery can validate source/key
  identity and reconstruct every archived event.

```mermaid
sequenceDiagram
    participant C as Connector checkpoint owner
    participant H as Encrypted history archive
    participant A as Active checkpoint
    C->>C: Select acknowledged event bodies
    C->>H: Write immutable source-bound archive
    H-->>C: File and directory durable
    C->>A: Atomically save IDs + archive references
    Note over A: Row aliases, pending bodies and all native commands retained
```

- IPC framing copies each received byte a bounded number of times; large native
  snapshots cannot require quadratic buffer accumulation. Frame limits, version,
  target, owner and lease validation are retained.
- An existing matching live subscription may route requests directly to its
  original ownerClientId, as the native follower does. Absent/stale subscriptions
  still use owner discovery; this never bypasses native canHandle/version checks.
- Empty bootstrap and identical metadata/state updates do not rewrite encrypted
  journals or issue new CAS updates. Real native content changes and admission
  receipts remain durable.
- When push is unavailable, remembered history entries are not all restored as
  full observers. Selected/viewed sources and unfinished work remain protected;
  unviewed quiescent observers can retire while history and receipts remain.
  Lightweight project activity remains separate from full message observation.
- Unknown asynchronous-question replies can be confirmed only by an accepted
  original user row carrying that exact command ID under the same owner/epoch.
  A different device's answer or a pending/rejected steering row is insufficient.

2026-10-31 当前产品定位为 **Codex 专用原生手机 App**，只支持使用网关模式接入的桌面 Codex。其他 harness、窗口共享和 AX 控制是否启用留待后续决定。既有研究源码保留，但不属于当前发行能力。

## 产品规则与所有者

- 自动选路先以已配对密钥认证通道列表。HTTP 可读不等于实时通道已连接；首个候选实时连接失败时，继续验证同一 Mac 返回的最新候选，包括重启后变化的 LAN 地址。新地址须逐个认证并建立实时连接后才能显示 connected。手动选择只验证指定候选，失败保持原选择。候选替换不改变 peer、会话、凭据密钥或待确认操作编号。

```mermaid
sequenceDiagram
    participant P as 手机选路 owner
    participant G as 已配对 Mac 网关
    participant W as 实时连接
    P->>G: 认证已保存的候选
    G-->>P: 同一 peer 的最新通道列表
    P->>W: 验证候选实时连接
    W-->>P: 连接失败
    P->>G: 认证最新列表中的下一候选
    P->>W: 建立下一候选实时连接
    W-->>P: 已连接
    P->>P: 保存最终通道，保留原操作编号
```

- CodeLight 基于本地 Happy MIT fork 的真实原生会话、工具、Markdown、附件与主题组件。App 名、原生 bundle、链接 scheme、启动页与设置统一为 CodeLight，保留许可证归属。
- 桌面 Connector 是观察者和转发者，Codex 原 owner 仍拥有原会话、运行时与 admission。Connector 不创建、恢复或重启原 Agent，不修改原应用源码、包、配置。窗口 ID、截图或 AX 控件不能冒充 Codex session ID 或原生会话协议。
- Mac App 内置加密同步服务、Connector 和出站隧道。本地独立数据目录保存配对密钥、加密检查点和操作摘要；手机凭据由原生安全存储拥有。
- 配对后 Mac App 默认显示实时及累计网关流量、HTTP/RPC 交互、在线设备和运行时长；通过“统计／扫码配对”切换内容。二维码续期保留当前选择，隐藏时不重新生成图片。详见 [Mac 统计页合同](codelight-mac-dashboard.md)。
- 正常首次使用只需打开 Mac App 并在手机扫描其二维码，不要求服务器选择、注册、匿名账号创建或 VPN。短期公网地址变化后重新扫描；公网使用 HTTPS，不能悄悄访问 Happy 公共服务。高级自建服务/诊断入口不改变正常扫码流程。
- 手机输入只有原 owner admission 才显示接受。断线、服务重启、未知回执保持稳定命令编号，不自动重发已经派发的动作。
- v2 peer 连接下，session/machine/model control RPC 的持久记录与 in-flight 合并按认证 peer、实体 ID 和操作/问题目标隔离；同一 Mac 的通道切换保留该身份。没有 peer 的旧连接继续使用原地址隔离，旧入口或其他会话的未知记录保持独立。结果未知的同目标操作只查原编号回执，不自动换编号重发。
- 旧版全局或地址 scope 记录只在原地址与实体匹配时尝试只读回执恢复；原回执可辨认目标时，不匹配的旧目标不能进入新问题的 scope。未确认结果和缺少身份依据的旧记录不被猜测为成功，也不自动重放。加密期间发生连接/账户切换时，请求不能发到新 socket。验收包含旧入口另一会话、同实体不同问题目标、同 scope ACK 丢失恢复、通道切换、旧记录保留与加密期间换连接。
- 手机提交后的传输错误或缺失终态回执只能标为“结果待确认”，不能标为已拒绝。先以原 commandId 只读查询回执；完成则结束提交，仍未知则保留原答案与身份，用户只能检查结果或关闭表单，不能用新 ID 重发。关闭待确认表单不发送取消操作。离线 socket 不缓存变更请求；重连和重新进入会话可只读恢复当前实体的未确认操作。私有诊断只记录操作阶段、时间与状态，不记录答案、凭据或地址。
- 原生集成发现：descriptor 尚未激活时 HTTP ACK 只代表进入中继。UI 和 Sync 双层要求普通 session 已 connected、非空 runtimeGeneration、steering=true 才能提交；所有非侵入手机 user 记录（包括缺 expectsAcceptance 的旧记录）hold 至 native accepted/rejected/unknown，明确排除原观察历史。Source activation banner 使用父 header 真实 top inset，不能被 glass header 遮挡，失败须可见。
- 实际 Native async question 只有 communications form、没有可关联内联 AskUserQuestion 卡时，即使有 choices 也必须展示 fallback banner/modal。只在明确存在可渲染且同 toolUseId/id 的内联卡时排除，不能按“有选项”假设内联卡必然存在。保留原 form question IDs、options 与 free-text，用户显式 Submit 后发送原 communication/question identity，点击选项不自动提交。
- 当前待回答的 fallback 提示独立于手机浮动输入区的状态淡出。用户阅读较早历史时，新问题仍必须可见、可打开；不能因为 `isChatAtBottom=false` 而同时隐藏提示并禁止触控。其他状态区、滚动按钮、输入草稿及原 question 所有者不变。验收包含在较早历史位置收到新 communication、打开表单并选择、显式提交一次、原 owner 回答/退役后移除提示；开发预览 `/dev/agent-question?history=1` 用于核对滚动历史时的固定提示和原生表单。
- 非 prefix 文本修订按 sourceRowId/revision 替换原片段，工具中途输出保持 running；只在原工具终态后显示完成。
- 原 native steering 输入的临时 item ID、`pending-user:callerId` 与接受后的正式行 ID 必须按原 caller/server 关联收口。源投影携带明确的替换行身份和历史 wire 别名；完整快照先到时也能移除旧临时显示行。不能按文字相同合并不同用户输入，替换别名的退役独立于正文版本去重。
- 手机底部只催当前轮未回答的问题；旧轮问题保留真实历史答复证据，不重新进入待操作队列。过期回复在 native dispatch 前拒绝，详见 [Codex 原生 IPC 合同](codex-native-ipc.md)。
- 项目视图在手机前台显示来自原 Codex 状态的轻量活跃/待操作统计，每条可见会话显示活跃、待操作、空闲或未确认状态。最近更新时间不是运行状态；未确认、过期或断连的数据不能显示为已确认的零。状态同步与当前会话的历史同步分开，详见 [项目状态合同](codelight-project-activity.md)。
- 原生项目内会话通过一行选择框切换，沿用已有项目归属、会话身份和路由。打开选择框不加载所有历史、不向原 Agent 发命令；重复选择当前会话保留输入草稿。
- 用户界面说明和翻译统一遵守 Codex-only 范围。不能用保留的 Happy/Claude/其他 harness 代码或历史 spec 宣称当前支持。

## RPC scope 与事件顺序

- 手机前台会话状态独立于推送权限。v2 peer 必须通过当前认证连接发送密封请求；同一 Mac 换通道后使用当前 endpoint 与最新 peer 凭据，不能继续向旧地址发送普通 Bearer。
- 当前可见会话的前台状态保护既有 observer/RPC attachment；离开前台才允许其按现有空闲规则回收。连接或 peer 改变时，旧状态不能发送到另一个 Mac。
- RPC broker 在没有目标、参数无效或试图自调用且尚未 emit 时返回明确的 `effectMayHaveOccurred:false`。手机只将这种已确认未派发的新操作视为可重试；emit 后的断线/超时仍保留原编号并只读查询。旧版本留下的未知记录不因新规则自动重发或删除。

```mermaid
sequenceDiagram
    participant P as 手机可见会话
    participant A as 当前认证连接
    participant D as Mac 前台状态 owner
    participant C as 既有 observer/RPC attachment
    P->>A: 当前会话前台 heartbeat
    A->>D: 当前 endpoint 的密封认证请求
    D->>C: 保留可见会话 attachment
    P->>C: 用户显式提交原 command ID
    Note over C: 没有 emit 的失败可确认未派发；emit 后未知不重放
```

```mermaid
sequenceDiagram
    participant User as 手机用户
    participant Journal as 手机 scope journal
    participant Socket as 当前认证 socket
    participant Owner as 原 Mac/native owner
    Note over Journal: 认证 peer / 实体 / 操作目标；旧 scope 的 unknown 保留
    User->>Journal: 当前 scope 的显式提交
    Journal->>Journal: 先保存原 command ID
    Journal->>Socket: 加密并核对连接/账户仍匹配
    Socket->>Owner: 原 ID 的控制请求
    Owner->>Owner: 持久回执与原生 admission
    Owner-->>Journal: 同 ID 的 terminal receipt
    Journal->>Journal: 仅清理当前 scope
    Note over Journal,Owner: ACK 丢失仅查询原 ID；不重放 mutation
```

## 构建边界

本产品是用户明确要求开发并在模拟器测试的独立 fork，CodeLight 本地编译与测试针对当前源码。上游 Happy 的 EAS/OTA/商店发布流程属于上游产品发布；本轮不运行这些流程。独立产品输出需有对应的源码版本、构建标识、校验和及验证报告。

## 验收

完整网络验收包含当前 Mac App 的内置同步服务、出站隧道、Connector 和原生手机 App。Codex 桌面须已运行；发现和观察只绑定既有原 owner，绝不新建同会话 writer。类型/单测、模拟器、真机安装、网络可达与温度/帧率分别记录，不能互相代替。

1. 打开独立 Mac App，手机扫码完成配对，连接已经运行的 Codex 原 owner，读取真实专用验证聊天。
2. 原生界面显示 CodeLight、历史和工具；原输入、停止、问题/权限回应只作用于所见原会话身份。常规 UI、状态和恢复验收不发送新模型测试输入。
3. 字符增长、非 prefix 修订、工具输出、重复消息、Connector 重启和 App 重启正确恢复，不重复 native dispatch。
4. 图片点击打开、缩放、平移、关闭；附件只经源绑定加密链路提供，错误可见且可重试读取。
5. 前台项目状态、会话选择框和语言切换通过对应回归与原生验收；历史多 harness/window spec 不计入当前支持清单。
6. 提供可重建的源码、启动命令、本地模拟器包与当前验证报告，准确列出尚未验证的平台或能力。

```mermaid
sequenceDiagram
 participant M as CodeLight 原生 App
 participant S as 自建加密同步服务
 participant C as 独立 Connector / 回执日志
 participant O as 已有桌面 owner
 M->>S: 加密消息 + 稳定 localId
 S->>C: 持久 inbox
 C->>C: 保存动作计划 / 检查 lease 与 owner
 C->>O: 同一命令只派发一次
 O-->>C: 原 admission / 状态增量
 C->>S: 加密观察与接受回执
 S->>M: 恢复投影 / 更新原生界面
```
