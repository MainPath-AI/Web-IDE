# Web-IDE

A full Linux based operating system inside your web-browser.

Web-IDE runs a 64-bit Linux system from one container. Nginx serves the page, QEMU compiled to WebAssembly, and a Debian amd64 disk from the same origin. The browser loads that disk into memory and opens a shell. Python, Node.js, and Hugo are already installed with asdf, each with one demo. code-server is installed in the guest.

## Inspiration

This is an original project, not a fork. It builds on ideas from:

- [container2wasm](https://github.com/container2wasm/container2wasm) and [QEMU-Wasm](https://github.com/ktock/qemu-wasm) for 64-bit Linux in the browser
- [code-server](https://github.com/coder/code-server) for VS Code in the guest
- [vscode.dev](https://code.visualstudio.com/blogs/2021/10/20/vscode-dev) for an editor in the browser
- [v86](https://github.com/copy/v86) and [WebVM](https://github.com/leaningtech/webvm) for Linux in a tab

QEMU is GPL-licensed and is built as a dependency. container2wasm is Apache-2.0. xterm and xterm-pty are MIT-licensed and are loaded from unpkg. The source in this repository is Apache-2.0.

## Guest

| Tool | Version |
| --- | --- |
| Debian | bookworm, amd64 |
| asdf | 0.14.1, plugins python, nodejs, hugo |
| Python | 3.12.7 |
| Node.js | 20.19.5 |
| Hugo | 0.168.0 |
| code-server | 4.143.1, no auth, port 8080 |
| Docker | static 27.5.1; `dockerd` is started on boot |

The demos live in `/opt/web-ide/demos`. `run-all.sh` runs all three.

## Image

```bash
docker pull mainpath/web-ide:latest
docker run --rm -p 8080:80 -p 18080:18080 mainpath/web-ide:latest
```

The page is then at `http://127.0.0.1:8080/`.

## Build

Docker and Go are required. `c2w` 0.8.4 cannot be installed with `go install`, because the module uses `replace` directives:

```bash
git clone --depth 1 --branch v0.8.4 https://github.com/container2wasm/container2wasm.git .tools/container2wasm
( cd .tools/container2wasm && go build -o ../bin/c2w ./cmd/c2w )
./scripts/build.sh
```

`c2w` compiles QEMU to WebAssembly and gives the guest 1024 MB of RAM. The build takes a while.

## Run

```bash
./scripts/run.sh
```

The page is at `http://127.0.0.1:8080/`. Nginx sets `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, and `Cross-Origin-Resource-Policy`. A proxy in front of the container has to forward those three headers. The disk is served without gzip.

A public hostname has to be served over HTTPS. Browsers ignore those headers on plain HTTP, so `SharedArrayBuffer` stays disabled and the guest does not start. `localhost` is the exception and works over HTTP. The page says so when the origin is not isolated.

The first load shows a progress bar, then the terminal. code-server starts in the guest, and the page reveals the IDE once it answers on port 8080. The container publishes ports 80 and 18080. `./scripts/run.sh` maps them to 8080 and 18080. The page opens a WebSocket at `/qemu-net`. `c2w-net` assigns the guest `192.168.127.3` over DHCP and forwards guest port 8080 to port 18080.

In testing, code-server did not answer within 15 minutes. Its launcher runs, and the Node process does not open the port in useful time under this emulator. The usable surface is the terminal with Python, Node, and Hugo.

`dockerd` does not stay up in this emulator. containerd stops because the kernel cannot set root mount propagation to `shared`. The terminal then prints `WEB_IDE_DOCKER_DOWN`.

## Checked

- `WEB_IDE_READY arch=x86_64`
- Python 3.12.7, x86_64
- Node v20.19.5, x64
- Hugo 0.168.0, linux/amd64
- Prompt `root@localhost:/opt/web-ide/demos#`
- code-server starts and does not answer on port 8080 within 15 minutes, so the IDE stays closed
- `dockerd` ends with `failed to start containerd: timeout waiting for containerd to start`, because the emulator kernel refuses a shared mount
