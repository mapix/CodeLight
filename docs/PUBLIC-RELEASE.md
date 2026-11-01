# Public Mac release and static website

Source: <https://github.com/mapix/CodeLight>

Website: <https://codelight.novarock.io/>

The website serves static introduction/download files only. The Mac App keeps
hosting its own relay, keys, native observers and pairing. Do not deploy that
personal session service into the website's Kubernetes namespace.

## Reviewed source snapshot

Keep private development history locally. Create the initial public Git history
from the same source selection as the current archive, using
`copyPublicSourceSnapshot` in `src/release/source-snapshot.mjs`. It permits the
standalone source/configuration roots, excludes private/generated inputs and
obsolete prototype artifacts, skips deleted tracked files and refuses symlinks.
Do not push the original local history or upload the complete workspace.

```sh
pnpm package:source
node scripts/verify-codelight-source.mjs --install
```

Scan the fresh extracted snapshot with the repository's `.gitleaks.toml`, then
scan the new initial Git history before pushing it. The source ZIP and public
commit must reflect the final tested source; regenerate them after any fixes.
Do not reuse a source archive from an earlier candidate just because its build
or secret scan passed.

For later updates, apply the reviewed source selection to the existing clean
public checkout and retain its public history. Remove public files absent from
the new selection, inspect the diff, then run source/privacy/history scans before
committing. Never merge or push the original private development history.

## Version 0.5 behavior

Mac Local network, Cloudflare and configured Relay are independent checkbox
entries, enabled by default on first migration. One pinned-key QR conveys all
enabled candidates; the phone proves a reachable channel automatically and has
a manual Connection sheet. LAN authorization stays sealed to the approved
device, and public channels retain TLS validation. Same-peer route changes keep
the account/session cache and recover uncertain operations by their original
receipts, without mutation replay.

Directory pages are ordered by original Codex update time. Entries older than
72 hours default to basic title/project/time information. Opening a session
waits for its existing observation, then loads a fresh recent window at the
newest end. Older history is bounded and requested only on explicit upward
scroll; current/native status is independent of message age. These code rules
do not substitute for the physical-phone acceptance recorded per release.

## Build and sign

Use the pinned workspace and a supported Node 24 LTS patch. For official runtime
inputs, download the macOS arm64 archive from nodejs.org, verify its exact filename
against `SHASUMS256.txt`, and supply its license. Download cloudflared's macOS
arm64 release from the official Cloudflare repository and verify the release
asset digest. Keep downloaded binaries and credentials outside Git.

```sh
pnpm install --frozen-lockfile
pnpm typecheck:all
pnpm lint
pnpm build:native
CODELIGHT_NODE_BINARY=/absolute/path/to/verified/node \
CODELIGHT_NODE_LICENSE=/absolute/path/to/Node-LICENSE \
CODELIGHT_CLOUDFLARED_BINARY=/absolute/path/to/verified/cloudflared \
node scripts/build-mac-app.mjs /absolute/path/to/release/CodeLight.app
node scripts/sign-mac-app.mjs /absolute/path/to/release/CodeLight.app \
  'Developer ID Application: Your Name (TEAMID)'
codesign --verify --deep --strict /absolute/path/to/release/CodeLight.app
```

Copy bundles with `ditto` or `verbatimSymlinks: true`. Rewriting relative symlinks
breaks the resource seal. Do not modify an original Codex bundle or overwrite a
running owner's data to verify a release.

## Apple notarization

Create a submission ZIP from the signed candidate with `ditto`. Submit through
Apple's official `notarytool` using your existing keychain profile, App Store
Connect API key or Apple ID/app-specific credentials. Keep credential values out
of logs, shell history and source. A completed upload is not acceptance.

```sh
ditto -c -k --keepParent /absolute/path/to/release/CodeLight.app candidate.zip
unzip -tq candidate.zip
xcrun notarytool submit candidate.zip --keychain-profile YOUR_PROFILE --output-format json
xcrun notarytool info SUBMISSION_ID --keychain-profile YOUR_PROFILE \
  --output-format json > /private/path/notary-status.json
```

Wait until the real status is `Accepted`; retrieve the Apple log if invalid.
`prepare-mac-release.mjs` refuses other status, verifies the CodeLight identity,
Developer ID/team/timestamp, staples and validates the ticket, assesses Gatekeeper,
then creates an immutable ZIP, SHA-256 file and public numeric release metadata.

```sh
node scripts/prepare-mac-release.mjs \
  --app /absolute/path/to/release/CodeLight.app \
  --notary-status /private/path/notary-status.json \
  --output /absolute/path/to/public-release \
  --team YOUR_TEAM_ID
```

The ZIP is produced after stapling. Never attach a personal-development iPhone
IPA or signing profile to a public release.

## Static image and Kubernetes

Create a fresh build context with `Dockerfile`, `nginx.conf` and
`security-headers.conf` from `deploy/website`. Copy `website/` into `site/`, the
verified `release.json` into `site/release.json`, and only the public ZIP/checksum
into `site/downloads/`. Include the public source commit in release metadata.
When replacing a deployed release, include its existing versioned public
downloads/checksums in the new context as well; updating `release.json` must not
break an older immutable download URL. Verify retained bytes against the earlier
published digest. Personal phone IPAs and private notary records are excluded.
Do not send the complete workspace, `.git`, `.runtime` or private evidence as a
Docker build context. Pin the resolved nginx base-image digest for a release.

```sh
docker build --build-arg NGINX_IMAGE=nginxinc/nginx-unprivileged@sha256:VERIFIED_DIGEST \
  -t codelight-website:RELEASE_TAG /path/to/public/context
```

When the cluster already holds a verified base image, inspect its architecture
and content ID against the saved vendor verification before reusing its local
tag. Build with `--pull=false` and `--build-arg NGINX_IMAGE=YOUR_VERIFIED_LOCAL_TAG`;
do not silently pull a moving tag or change daemon-wide registry settings.
Record the resulting website image ID, use a fresh release tag, and import only
that exact image into the cluster's containerd store.

The supplied manifest targets the existing nginx ingress / `letsencrypt-prod`
issuer and a dedicated `codelight` namespace. Replace `RELEASE_TAG` with the
immutable image tag. This cluster's single-node workflow imports the image into
containerd and uses `imagePullPolicy: Never`; a multi-node deployment must publish
the image to your registry and update that policy before scheduling elsewhere.

Create the dedicated namespace, validate the rendered manifest server-side, then
apply it. The website runs without root, a writable root filesystem, Linux
capabilities or a service-account token. Only the ingress controller may connect;
egress is denied. Existing cluster workloads and personal Codex owners remain
independent of this deployment.

```sh
kubectl create namespace codelight --dry-run=client -o yaml | kubectl apply -f -
kubectl apply --dry-run=server -f rendered-kubernetes.yaml
kubectl apply -f rendered-kubernetes.yaml
kubectl -n codelight rollout status deployment/codelight-website --timeout=180s
kubectl -n codelight wait --for=condition=Ready certificate/codelight-tls --timeout=180s
```

Verify HTTPS, security headers, language/FAQ controls, narrow layouts, the exact
download size/SHA-256, ZIP integrity and HTTP Range behavior. Publish only after
those checks. Keep deployment credentials in your own SSH/Kubernetes setup.

## Optional source CI

The reviewed GitHub Actions template is in `docs/ci/verify.yml`. The current
publisher cannot create workflows with its OAuth scope, so this release does
not activate Actions. A repository owner with workflow write permission may
copy the template into `.github/workflows/verify.yml` to enable it. Local type,
lint, security and scoped regression gates are executed before publication.

## Updating and recovery

Use a new immutable image/release filename for each update. Retain the previous
deployment revision and public artifact; roll back only this website's deployment
if verification fails. Do not remove old downloads while clients may still use
their versioned URL. A website rollback does not change any user's Mac session.
