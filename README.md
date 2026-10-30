# Web-IDE

An experimental 64-bit Linux development environment running inside Chrome, with [code-server](https://github.com/coder/code-server) inside that same virtual machine.

The page loads a QEMU-Wasm emulator and a Debian amd64 guest, displays loading progress, and opens VS Code when the guest's editor responds. Files, shell processes, and development tools belong to the browser guest.

## Current status

The in-browser editor connection is under active verification. A visible editor, a successful HTTP health check, or a green native guest test does not establish that its file tree and integrated terminal work. End-to-end acceptance still requires a fresh browser start, opening and saving a guest file, a working integrated Bash terminal, and execution of all three demos. Snapshot restore and a subsequent browser start also need verification. This README does not claim that acceptance is complete.

## Architecture

One deployment image contains:

- The loading page, QEMU-Wasm, a Debian amd64 disk, and a prepared QEMU startup snapshot.
- Nginx and a session bridge built on container2wasm's virtual-network library. Each browser start receives a fresh cryptographically random session token and its own network worker process.
- Browser assets copied from the exact code-server guest image, including VS Code workers, built-in extensions, fonts, and terminal assets. Nginx serves these static files to avoid transferring them through the emulated CPU.

code-server itself runs in the guest. Nginx proxies its session document and session APIs, including file operations and terminal connections, through that guest's worker. There is no host-side code-server service. The older `ide/` directory describes an abandoned native editor approach and is not used by `scripts/build.sh`.

The page listens on container port `80`; the editor proxy listens on `18080`. `/sessions/<token>/net` carries the browser emulator's network connection, `/sessions/<token>/health` checks its editor, and `/sessions/<token>/editor/` proxies that guest's port `8080`. Guests use the same private address inside separate virtual networks; there is no shared forwarded editor port. Runtime workspaces are not mounted from the deployment host into the guest. The bundled xterm-pty 0.10.1 matches the emulator compiler's PTY integration.

## Guest tools and demos

| Component | Version |
| --- | --- |
| Guest architecture | Debian amd64 / x86_64 |
| Guest RAM | 1,024 MiB |
| code-server | 4.143.1 |
| asdf | 0.14.1 |
| Python | 3.12.7 |
| Node.js | 20.19.5 |
| Hugo | 0.168.0 |
| Docker binaries | 27.5.1 |
| container2wasm | v0.8.4, commit `6ed3d98882a2b22eafc1334f574c364a5b2b8c47`, with repository patches |

The demos are preinstalled in `/opt/web-ide/demos`:

```bash
cd /opt/web-ide/demos
python python/hello.py
node node/hello.js
(cd hugo && hugo --quiet && test -f public/index.html)
./run-all.sh
```

Python, Node, and Hugo are installed in asdf's version directories. Shells use those executables directly, avoiding asdf initialization during startup; the `asdf` command remains available.

Docker CLI and daemon binaries are included, but a working Docker daemon in this guest is **not supported or verified**. The previous runtime failed to set mount propagation to `shared` (`operation not permitted`). The presence of `docker` or `dockerd` is not evidence that containers can run.

## Build

Use Docker with BuildKit/buildx, Git, Go 1.25 or newer, Python 3.9 or newer, Bash, and `patch`. Run the repository's JavaScript regression checks with Node.js 24. The build needs network access to upstream sources and downloads. It compiles the kernel and emulator and creates large intermediate images; allow substantial free disk space, RAM, and build time. Both the guest and the final image target `linux/amd64`; an arm64 build host also needs Docker's amd64 execution support.

```bash
bash scripts/build.sh
```

Set `GO` if Go is not on the shell's path. Optional `WEB_IDE_IMAGE` and `WEB_IDE_GUEST_IMAGE` variables change the resulting local image names; defaults are `web-ide:local` and `web-ide-guest:local`.

The build exports the pinned upstream tree into `dist/toolchain/`, applies the versioned patches from `patches/container2wasm/`, and passes both the patched Dockerfile and its matching assets to container2wasm. It preserves existing `.tools/` edits. Each build uses a fresh output directory under `dist/builds/`.

The native build guest starts code-server before its RAM is captured. After HTTP readiness, the snapshot builder runs `scripts/warm-guest.mjs` against the actual VS Code management protocol: it requests the Linux environment, scans extensions, lists the demo directory, and starts the PTY host through a latency RPC. A warmup failure fails the build. This prepares guest services; it does not prove an interactive browser shell. The builder then waits for QEMU migration to complete before publishing the snapshot.

The outer guest init periodically synchronizes the restored system clock with the deployment Nginx's HTTP `Date` header through its fixed private gateway. It uses no external time service, proxy settings, or session credentials. This runs outside the application container, before its restricted capability set takes effect.

Package validation checks snapshot magic, file offsets, package length, and Wasm format. It also patches the generated data loader to reject a runtime package whose byte length differs from its metadata. `asset-manifest.json` records package hashes, the guest image ID, upstream revision, and patch hashes. Before startup, the page fetches this manifest without caching and versions every generated VM asset with its own SHA-256. Nginx accepts only matching versions from the generated `asset-versions.conf`; stale or unversioned VM requests return HTTP `409`. This prevents a deployment from combining a cached loader with a different disk or snapshot. A failed manifest or package download stops startup visibly.

The final Nginx build receives those verified assets and static editor files from the same guest image. These checks protect package consistency; browser acceptance remains a separate step.

## Run locally

Use available local ports and an unused container name:

```bash
docker run --name web-ide \
  -p 127.0.0.1:8090:80 \
  -p 127.0.0.1:18080:18080 \
  web-ide:local
```

Open `http://127.0.0.1:8090/` in Chrome. Loopback addresses can provide the secure context needed for browser isolation. The first visit downloads a large VM package and requires considerably more browser memory than the guest RAM alone. Download time and emulated execution speed depend on the client device.

The public image namespace is `mainpath/web-ide`. Published tags and deployments must be checked against the verified build; this document does not assert that an existing registry tag contains the current source.

## HTTPS deployment

Public deployments require HTTPS. For a page at `https://web-ide.example.com/`, the current frontend expects the editor proxy at `https://ide.example.com/`. Route the page hostname to container port `80` and the editor hostname to `18080`, with TLS on both hostnames. Preserve the original `Host`, session paths, query strings, and WebSocket upgrades for session network and editor connections. The network WebSocket checks that its browser `Origin` matches the public request host.

The Nginx configuration sets the page's isolation headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
Cross-Origin-Resource-Policy: same-origin
```

Editor resources use `Cross-Origin-Embedder-Policy: credentialless` and `Cross-Origin-Resource-Policy: cross-origin` so the isolated page can embed the editor. An upstream proxy must preserve these headers. The page checks `window.crossOriginIsolated` and refuses to start when isolation is unavailable. Ordinary public HTTP is insufficient. Keep byte-range responses for the large VM assets intact and avoid proxy compression or rewriting of those files.

## Browser sessions and persistence

Guest changes live in the running browser VM. Saving a file updates that guest; it does not write the deployment image or upload a persistent workspace. Reloading or closing the tab discards runtime changes. Browser caching can reuse downloaded assets, but does not save the guest's modified disk or RAM. The packaged snapshot is a shared build-time starting point, not a user's saved session.

Each new page start creates a separate worker and virtual network. Unknown sessions cannot allocate resources through health or editor requests, and a second network connection using the same token is rejected. The network WebSocket owns the worker's lifetime: disconnection destroys it. Defaults limit the bridge to 16 active sessions, 30 minutes without incoming network packets, and four hours per session. Its internal listener has an additional private key so another guest cannot reach a worker through the existing host NAT route.

The URL token is the session's bearer capability; do not share editor URLs. Responses use `Referrer-Policy: no-referrer`, and Nginx redacts session tokens from access-log paths. code-server authentication is disabled inside each guest. Session isolation tests are separate from a security assessment or completed browser acceptance. The bridge retains container2wasm's outbound networking and host NAT behavior, so it does not provide a sandbox for untrusted users against the deployment host's network.

## Verification and diagnostics

Repository regression checks can run without booting a VM:

```bash
node --test scripts/*.test.mjs
python3 -m unittest discover -s scripts/tests -v
assets="$(python3 scripts/prepare-build.py)"
repo="$PWD"
(
  cd "$assets"
  go test ./cmd/get-qemu-state
  go test ./cmd/init/web-ide-clock.go ./cmd/init/web-ide-clock_test.go
  go test -race "$repo/nginx/bridge/main.go" "$repo/nginx/bridge/main_test.go"
)
for script in guest/web-ide-init.sh scripts/build.sh scripts/run.sh; do
  bash -n "$script"
done
```

The `Guest` workflow runs startup, real-PTY termios, warmup-protocol, package, snapshot, and session-isolation regressions, then checks the tools and demos in a native amd64 Docker guest. Go bridge tests use the pinned module exported by `prepare-build.py` without modifying its tracked provenance.

The manually dispatched `Browser image` workflow runs these regressions and builds the complete amd64 image, including native RPC warmup and snapshot capture. It checks Nginx configuration and image architecture and uploads provenance extracted from the built image. Optional publishing pushes that image to `mainpath/web-ide` with the commit tag and `latest`; it does not deploy or perform browser acceptance. Publishing on `main` requires `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets.

The full-image workflow reports runner resources and requires 30 GiB of free workspace storage by default. Configure `WEB_IDE_BUILD_RUNNER` as a repository variable to select an appropriately provisioned Linux runner label, and `WEB_IDE_MIN_FREE_GIB` to adjust this preflight threshold. Passing the threshold is not a guarantee that a large build will fit. The workflow does not prune Docker or stop unrelated containers. A workflow definition or a green native check is not evidence that a particular published image or deployment has passed end-to-end acceptance.

The page exposes bounded guest output as `window.__guestLog` and startup/session state as `window.__webIdeBoot`. `window.__webIDE.readSerial()` reads that output; `sendSerial(text)` feeds the actual guest PTY for diagnostics. In the guest, `/var/log/code-server.log` contains editor startup output; the serial console receives `WEB_IDE_CODE_SERVER_LOG` lines. `WEB_IDE_CODE_SERVER_HTTP` and `WEB_IDE_SNAPSHOT` indicate HTTP readiness; `WEB_IDE_WARMUP_READY` records the build-time RPC warmup. None replaces browser file-save and integrated-terminal acceptance. Investigate browser connection logs and guest logs together when either remains unavailable.

Nginx request logs include the redacted route, HTTP and upstream status, and upstream connection, header, and response timings. Per-vhost HTTP error logs are deliberately suppressed: Nginx appends the original request URL to those messages and cannot apply the access-log redaction format. Global Nginx configuration/startup/process logs and the bridge's token-free transport error categories remain available. An outer reverse proxy needs equivalent session-URL redaction if it records requests.

## Inspiration and licenses

This is an original project, not a fork. It uses or draws inspiration from:

- [code-server](https://github.com/coder/code-server) for VS Code served from Linux.
- [vscode.dev](https://code.visualstudio.com/blogs/2021/10/20/vscode-dev) for browser-based editor interaction.
- [container2wasm](https://github.com/container2wasm/container2wasm) and [QEMU-Wasm](https://github.com/ktock/qemu-wasm) for the browser guest runtime.
- [xterm-pty](https://github.com/mame/xterm-pty) for the browser's PTY integration; its vendored MIT license and exact package provenance are in [`web/vendor/`](web/vendor/README.md).
- [v86](https://github.com/copy/v86) and [WebVM](https://github.com/leaningtech/webvm) for Linux in a browser.

The source in this repository is Apache-2.0; see [LICENSE](LICENSE). Upstream components retain their own licenses. In particular, QEMU and the Linux kernel have GPL licensing obligations, and container2wasm is Apache-2.0. Distributing the combined image must retain applicable upstream notices and provide corresponding source as required by those licenses. The pinned sources and local patches are part of the build's provenance.
