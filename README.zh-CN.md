# CodeLight

[网站与 Mac 下载](https://codelight.novarock.io/) · [源码](https://github.com/mapix/CodeLight) · [MIT 许可](LICENSE) · [English](README.md)

在 iPhone 上继续电脑已有的 Codex 会话：查看历史、切换会话、发送输入、
停止当前轮次、回答问题，并查看项目与会话状态。每次操作都路由回原 Codex
会话的 owner；CodeLight 不另起模型运行器，不修改或重启原桌面应用。

**只支持使用网关模式接入的桌面 Codex。** 其他 harness 和窗口远控暂不属于
当前发行范围，旧研究源码不代表产品已支持这些能力。

## 当前发行

- Mac 预览版：Apple Silicon、macOS 14+，Developer ID 签名、Apple 公证及
  ticket stapling。版本与 SHA-256 在下载页可核对。
- iPhone 客户端：目前需从源码构建并使用自己的 Apple 开发签名。
  尚无公开 App Store/TestFlight 发行，不提供带私人设备登记信息的开发 IPA。
- 安装后在手机扫描 Mac 二维码，无需另外注册 CodeLight 账号或安装 VPN。
  Mac 重启后临时连接地址可能变化，切到“扫码配对”重新扫描即可。

配对后 Mac 默认显示统计页，包含实时与累计网关流量、HTTP/RPC 交互、
在线设备和运行时长。手机项目内使用选择框切换会话，可见项目与会话接收
轻量状态；未知或断连状态保留“未确认”，不伪装为空闲。

Mac 的“公网入口”可选 Cloudflare 或自建 Relay。Relay 模式填写 HTTPS 服务地址，
按服务端要求填写访问密钥，校验 HTTP/WebSocket 连通后生成同样的二维码。
手机端继续扫码，不需要选择模式或填写服务器。公网 Relay 只转发网络流量，
不存会话、账号密钥或任务状态；会话与原 owner 始终留在 Mac。

## 构建与验证

```sh
git clone https://github.com/mapix/CodeLight.git
cd CodeLight
pnpm install --frozen-lockfile
pnpm typecheck:all
pnpm lint
pnpm build:native
```

开发基线为 Node 24.15.0 / pnpm 10.11.0。Mac 发行可使用兼容的较新 Node 24
LTS 安全补丁。手机构建需要 Xcode、CocoaPods 和自己的开发团队。
命令与签名参数见 [构建说明](docs/BUILD-AND-VERIFY.md)，公证与静态 Kubernetes
部署见 [公开发行流程](docs/PUBLIC-RELEASE.md)。

源码采用标准 workspace：`apps/mac` 为 SwiftUI Mac 界面，`apps/mobile` 为
Expo/React Native 客户端，`src` 为会话桥接，`packages/relay` 为嵌入式中继，
`packages/wire` 为共享协议，`website` 为无第三方统计脚本的静态网站。

## 安全与限制

请先阅读 [安全说明](SECURITY.md)。只为自己信任的手机配对；当前没有独立的
项目或会话 ACL。原 Codex 持续拥有运行时与 admission；未知操作回执不自动
重放。网站只分发静态页面和已验证的公开包，不接收配对、会话或账号数据。

桌面原生接口可能随 Codex 版本变化，尚未支持的接口会明确显示不可用。
性能基准记录的是合成历史下的 Mac CPU 与请求工作量，不代表已测得的
iPhone 帧率、续航或温度，也不保证手机不会发热。

CodeLight 是独立开源项目，不隶属于 OpenAI。基于 Happy 的 MIT 组件构建，
保留原许可证和第三方归属，详见 [第三方说明](THIRD-PARTY-NOTICES.md)。
