# Happy 纯 Session Transport

> **当前发行范围（2026-10-31）**：本共享加密传输用于 CodeLight 的 Codex 原生会话投影。其他 source 或 window 的兼容示例保留为研究接口，不计入当前发行支持；当前范围见 [产品合同](codelight-product.md)。

## 所有者与范围

本模块只做Happy加密传输。Root负责source mapping/key bootstrap、原native adapter调用及native command journal/receipt。constructor必须显式serverOrigin/token/sessionId/encryptionKey/statePath，不读任何用户配置，不导入Happy CLI入口/runner/commonhandlers，不做Mac动作或模型调用。

一个statePath由单个Root进程里的一个transport拥有；进程内重复owner拒绝。Root跨进程lease仍是唯一owner，transport checkpoint使用async atomic replace与文件版本冲突检查，不能拿它冒充跨进程native admission锁。

## 接口

- `HappySessionTransport(options)`；`start({connectSocket:true})`显式载入checkpoint、Socket.IO连接及HTTP catch-up；constructor无网络/文件副作用。
- `publish(localId, record)`：先持久完整密文FIFO outbox，再POST v3；同id同record复用既有密文/ACK，不同record拒绝。HTTP失败保留pending，不改receive cursor；自动重试仅相同Happy log记录。
- `catchUp()`：v3 after_seq/hasMore，持久完整encrypted inbox与receive cursor后发new record观察事件。保留outer id/localId/seq/timestamps，记录解密错误而不dispatch native。
- `listInbox()` / `ackInbox(id)`：Root journal显式消费。进程恢复的未ack inbox不会自动再次发record事件，只报告recoverable inbox；Root必须先查自己的native receipt再决定处理。
- `registerRpc(method, handler)`：只显式注册method；精确session prefix及decrypt验证，无default common/runner handler。
- `registerReceiptHandler(handler)`：canonical `bridge-receipt` + compatibility `receipt`，都只是调用Root提供的read-only receipt查询。
- `callRpc(method, params)`：不缓冲断线请求，不自动重试RPC；派发后超时/断线按delivery-unknown。解密业务错误保留code/effectMayHaveOccurred。
- `updateMetadata(fn|object)` / `updateAgentState(fn|object)`：Happy encrypted expectedVersion CAS，mismatch解密最新值再应用fn，保留其他字段。bootstrap可给initialMetadata/metadataVersion/initialAgentState/agentStateVersion。
- `flush()` / `waitForConnect()` / `status()` / `close()`；close停止网络及timer、等待自己的持久IO，不关原app、不清原任务。
- crypto exports：encryptRecord/decryptRecord，deriveContentKeyPair，sealDataKey/unsealDataKey，deriveBlobKey/encryptBlob/decryptBlob。
- attachment helpers：`uploadAttachment(data,{filename})`和`downloadAttachment(ref)`复用request-upload/download；只传Happy密文，不解析任意本地路径，不假定native模型支持图片输入。

## Happy 兼容加密

MIT归因保留Happy Coder Contributors和upstream ee5ccff79b046570dc7e62eeec90e7c8a9d7027e。

JSON dataKey：AES-256-GCM `[version0][nonce12][ciphertext][tag16]`；legacy JSON及blob：NaCl secretbox `[nonce24][ciphertext+MAC16]`。blob key使用Happy HMAC-SHA512 tree，usage='Happy Blobs'，dataKey path=['session']，legacy=['master']。

当前三端dataEncryptionKey不是crypto_box_seal：Happy-agent/CLI/app均使用 `[version0][ephemeralPK32][random nonce24][crypto_box ciphertext]`，32-byte key总105 bytes。按现有格式实现，不用blake2b512截断或另换sealed-box算法。content key pair按Happy EnCoder/content树后SHA512(seed)[0:32]派生X25519。root负责保留/恢复原session key，不能稳定tag下换随机新key解密旧record。

## 持久与身份

checkpoint只保存密文/outer metadata/key fingerprint/HMAC body digest，不保存token或raw key/plaintext。parent目录0700、文件0600，async temp write→file sync→atomic rename→directory sync。JSON format/version和serverOrigin/sessionId/variant/key fingerprint严格绑定。

outbox ACK的seq不推进receive cursor；cursor只跨越已持久capture的完整server records。server log ACK不是native admission。inbox ack只删除transport pending，native receipt由Root独立权威。source重连、state恢复及Happy outbox重试都不能直接调用原native writer。

RPC params/response同session key加密。登记表默认空；receipt只是显式Root handler。方法未注册/坏密文不调用handler；进入handler后的异常若无明确无副作用证据按unknown保护。状态和diagnostic仅低敏code/counts，不日志私钥、token、密文body或用户消息。

## 验证

独立pure crypto/async durable checkpoint/HTTP protocol fixture测试；可对Root自建Happy57070、隔离account和专用test-only Happy session做真实Socket/v3/CAS/RPC/blob验证。没有原native source mapping、不发原agent消息、不任何Mac动作，不读取原Happy/Codex/Claude账号。

必须验证：稳定密文/ACK丢失重发、reload保留FIFO、id冲突、outer identity/cursor、恢复inbox不自动回放、RPC白名单/加密错误、same-origin Bearer/attachments ACL、Happy crypto跨实现fixture。真实native admission不属于transport测试，不以Happy ACK伪造它。

## 实现对接要点与已完成验证（2026-10-29）

```js
import { HappySessionTransport } from './session-transport.mjs';
const transport = new HappySessionTransport({
  serverOrigin, token, sessionId, encryptionKey, statePath,
  initialMetadata: decryptedMetadata, metadataVersion,
});
transport.registerReceiptHandler((params) => rootReadOnlyReceiptLookup(params));
transport.on('record', (incoming) => {
  // .content仍是wire密文；.record才是解密JSON。Root先journal校验，不能直接再次dispatch。
  if (incoming.publishedByThisTransport || incoming.decodeError) return;
  rootJournalCapture(incoming);
});
await transport.start();
await transport.publish(stableLocalId, plaintextRawRecord); // 内部加密；不传预加密ciphertext
```

`listInbox()`同样保留完整outer与解密.record，恢复项由Root主动查native journal/receipt。已ACK的publish返回copy且不重写checkpoint；外部不能修改transport持久ACK。不能把pendingInbox计数当native队列。

依赖由Root统一安装：socket.io-client4.8.1、tweetnacl1.0.3；没有blakejs或runner依赖。Node24.15.0 typecheck/lint与10项transport UT通过。当前Happy原helper互解JSON/dataKey/legacy/box，固定GCM/box/secretbox/HMAC fixtures通过，key wrapping105 bytes。

Root自建57070真实隔离test-only Happy session验证通过：Socket/v3密文去重与完整outer、bridge-receipt/receipt加密RPC、错误code保留、并发metadata CAS、agentState、68-byte PNG密文上传/解密、checkpoint reopen无record自动回放。测试Happy记录/附件已清理；original native动作0、model调用0。没有读原用户SDK/账号、没有Mac动作或App重启。

运行：`HAPPY_TRANSPORT_INTEGRATION=1 HAPPY_TRANSPORT_TEST_ACCOUNT=<explicit isolated account path> node --test test/happy-session-transport.integration.test.mjs`。普通tests不隐式读取测试凭据或启动服务；live test须显式opt-in。
