# CodeLight 交付与打包合同

> **历史方案（2026-10-31）**：本文件保留此前的多 harness、窗口、传输或旧工程交付方案，不是当前发行能力或操作入口清单。当前 CodeLight 是 Codex 专用原生手机 App；其他 harness 是否启用留待后续决定。当前工程、命令和交付规则以 [产品合同](codelight-product.md)、[单独工程合同](codelight-standard-project.md) 和 [构建说明](../docs/BUILD-AND-VERIFY.md) 为准。

## 交付组成

- Mac daemon、原 owner / window adapter、source registry 与当前 spec/test/lock。
- `clients/happy` 的当前原生 Expo fork、所需 workspace/source/build 配置及原 MIT 声明。
- 当前 CodeLight 原生 Release iOS Simulator `.app`，只能在兼容模拟器运行，不冒充真机 IPA。
- 可复建的自建 Relay Docker/Caddy fragment、启动与应急说明。

## 隔离规则

源码包以白名单目录/文件复制到新的 staging directory；不会直接打包整个工作区。所有 private/evidence/data/research、原应用提取源、旧 mobile UI、旧交付包、node_modules/Pods/build/cache、`.env`、凭据、数据库、抓包与个人截图均排除。拒绝源码树里的 symlink，避免跟随到外部私密文件。

2026-10-29 最终分发审计：`native/codelight-native-worker-qa` 与 `native/codelight-qa` 是使用本地测试环境的专用验收工程，不是产品运行源码，必须从分发包排除；通用代码单测与其他当前 spec/test 仍保留。`scripts/package.mjs` 依赖已不交付的旧 `mobile/`，不进入分发，`package:legacy` 不作为当前产品入口。可运行的 `start:legacy` 仅保留为显式诊断服务器，不作为手机交付路线。

源码使用审计继续排除三个旧原型专用合同：`spec/delivery.md`、`spec/native-mobile-app.md`、`spec/native-mobile-transport.md`。它们描述旧 `mobile/`、Bearer bridge 配对及旧 Android/未签名 iPhone 交付，保留在工作区作为历史依据，不作为当前源码包的构建或使用指令；Happy 迁移理由与当前 CodeLight 合同继续分发。诊断入口遇到不支持的 Node 版本时，只提示选择已有 Node.js 24+ 后执行实际存在的 `npm run start:legacy`，不能指向未分发的 `start.sh`。

原生包必须验证 `CFBundleIdentifier=com.learnings.codelight`、显示名 CodeLight、iPhoneSimulator 平台、独立 `main.jsbundle`，并检查无内嵌 JWT / private key / test credentials。未传入真实原生产物时，只有明确 `--source-only` 模式可生成源码包，manifest 必须标记 native not-provided，不宣称完成。

manifest 记录真实文件大小、SHA256、源码文件清单与排除校验、Happy 基线/当前变更身份和原生产物的实际版本/平台。不把 fixture、旧 UI 或未执行测试写成验收通过。

`clients/happy/package.json` 的上游 `env:*` 命令依赖当前不存在且不分发的 `packages/dev-environments`。打包时仅在 staging 副本删除名称以 `env:` 开头的 scripts；工作区原文件、其他 scripts、依赖、workspace、pnpm 配置及锁文件保持。复制结果与源码 manifest 记录实际删除的命令，源码 tree SHA256 必须基于转换后的 staging 文件内容，不能使用工作区原文件的哈希。回归需验证全部缺失命令被移除、无关 metadata 与锁文件不变、工作区输入字节不变；新包再次打包无需已删除命令也能运行。

当前端口 80 私有测试部署可另附 deployment-specific Release Simulator ZIP：与通用包同一 JS、同一正常账号/配对界面，仅该部署域的 ATS HTTP 例外。不得内置测试账号、默认测试 URL 或测试启动分支。该域例外只存在于专用产物，不进入通用源码；本机 `LOCAL-RELAY.md` 单独提供部署地址。根验收记录将其签名/校验和、实际只读连接结果与通用产物区分，不能把专用 HTTP 验证扩张为通用包对任意 HTTP 域支持。

## 验证

隐私 fixture 测试确保 forbidden 文件和外部 symlink 不进入 archive；实际源码包在新的临时目录解包、安装 root 运行依赖并运行 help/inspect。不会重启或改变目标 Coding Agent。整体 native、relay、原 runtime admission 与 UI 验证另由根交付验收结果证明。
