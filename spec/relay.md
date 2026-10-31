# 可选自建中继

> **历史方案（2026-10-31）**：本文件保留此前的多 harness、窗口、传输或旧工程交付方案，不是当前发行能力或操作入口清单。当前 CodeLight 是 Codex 专用原生手机 App；其他 harness 是否启用留待后续决定。当前工程、命令和交付规则以 [产品合同](codelight-product.md)、[单独工程合同](codelight-standard-project.md) 和 [构建说明](../docs/BUILD-AND-VERIFY.md) 为准。

本机服务在 Wi-Fi/VPN 下可直接访问。公网中继提供一个独立的 HTTPS/WSS 入口，本机 connector 主动出站建立认证通道；中继仅转发 HTTP/SSE 字节，不持有 Agent、会话快照或执行队列。

第一版一台中继对应一台电脑，可访问该电脑的两个应用。connector 密钥是至少32字节随机值，仅经 Authorization header和本地受限文件配置，不放URL、浏览器或日志。手机仍由本机服务配对、鉴权与处理命令receipt。

协议：request/start/chunk/end/error/cancel；请求ID独立于native commandId。每请求最大128KiB，每WS frame最大1MiB，最多64个在途请求，积压超界关闭连接并使手机重新获取snapshot。网络失败不重放HTTP写请求，手机按原commandId向本机查询结果。

远端只允许WSS，loopback测试可使用WS；TLS证书可由relay进程读取或外部反向代理终结。Web手机HTTP与SSE需有效cookie；原生App使用逐请求透传的Bearer。connector握手密钥不会作为手机凭据传给本机。跨域写操作拒绝，无Origin原生请求按原生传输合同鉴权。断开connector时取消本地请求，释放对应native订阅，不能泄漏follower。

验收包括：认证失败、真实HTTP配对与cookie/Bearer经过中继、原生logout撤销、SSE流、断连取消、body/frame/并发界限、没有任何重放写请求。公网部署在用户指定环境后单独验收，不把loopback测试视为公网可达证据。
