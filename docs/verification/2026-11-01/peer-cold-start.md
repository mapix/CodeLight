# Saved peer cold-start crash

## Confirmed failure

After scanning the multi-channel QR, physical phone build `2026110107` crashed
and continued crashing on launch. Retrieved native reports recorded SIGABRT,
and the device console identified the JavaScript signature:
`no PRNG -> peerAuthorization -> proofHeaders -> connect`.

The peer module used TweetNaCl's global random function, but the pairing provider
installed that function's random source as a module side effect. The application
restores authenticated sync before rendering the provider, and Metro enables
`inlineRequires`. The provider import can therefore remain lazy at that point.
Stored peer credentials request a nonce immediately during socket initialization,
exposing this ordering dependency again on each launch.

## Fix and verification

The peer transport now obtains each nonce directly from Expo's native system
cryptographic random source. The obsolete provider-installed global PRNG setter
was removed after checking its references. Existing peer/device credentials are
retained; recovery does not require key deletion or a weak random fallback.

- A regression with unavailable TweetNaCl randomness failed with `no PRNG`
  before the change and passed after it.
- Saved-peer socket initialization is exercised with the pairing provider absent.
- 13 directed peer/socket/pairing/channel tests passed; bridge/mobile/production
  relay typechecks and bridge lint passed.
- Phone and simulator `2026110108` built and installed. The first actual phone
  launch remained alive in the initial and settled process snapshots, and the
  Mac's private device registry recorded a fresh authenticated paired-device
  heartbeat. A second cold launch without clearing credentials also remained
  alive in its settled process snapshot. The latest retrieved crash report
  remained at 16:25:46, before the patched launches; no newer phone report was
  present in that bounded check.

Phone submission/message display outcomes remain awaiting the new live question.
The earlier build's physical acceptance remains withdrawn.
