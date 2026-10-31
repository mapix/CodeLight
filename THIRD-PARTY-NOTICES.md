# Third-party notices

CodeLight includes and adapts the Happy project (`slopus/happy`) native Expo client and self-hosted encrypted sync server. The original MIT license is preserved in `licenses/Happy-LICENSE` and `apps/mobile/LICENSE`; `packages/relay` and `packages/wire` retain MIT metadata.

The initial reference commit was `ee5ccff79b046570dc7e62eeec90e7c8a9d7027e`. Public release metadata identifies the CodeLight source revision and the SHA-256 digest of its Mac download. CodeLight does not claim that a file-count manifest is a source-tree digest.

The macOS connector is independent of installed Coding Agent applications. Those applications are not redistributed. Extracted application bundles, personal screenshots, research artifacts, private credentials and old mobile prototypes are excluded from delivery.

Other included workspace components retain their own license files and notices. This document does not change their licensing terms.

The CodeLight 0.4.0 public Mac release bundles Node.js 24.22.2 (Node.js and included dependency licenses) and Cloudflare cloudflared 2026.10.7 (Apache License 2.0). Their license texts are included in the Mac App's Resources/licenses directory. Custom source builds must retain notices for their actual runtime versions. Cloudflare Tunnel forwards only the CodeLight HTTP/WebSocket service; the mobile app does not install a VPN profile.
