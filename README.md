# Web-IDE

A full Linux based operating system inside your web-browser.

Open the site. A loading screen runs, then VS Code appears through [code-server](https://github.com/coder/code-server). The integrated terminal is a normal bash with Python 3, Node.js 20, git, and curl.

On a host named `web-ide.example`, the editor is served from `https://ide.example/` and embedded after the loading screen.

## Images

- `ide/Dockerfile` builds the editor. It is code-server 4.104.2 on Debian, running as the user `coder`, with authentication turned off inside that container.
- `nginx/Dockerfile` builds the loading page. It waits until the editor answers, then shows it.

The editor container does not publish a host port of its own. The page container proxies a health check to it.

## Inspiration

This is an original project, not a fork. It builds on ideas from:

- [code-server](https://github.com/coder/code-server) for VS Code in the browser
- [vscode.dev](https://code.visualstudio.com/blogs/2021/10/20/vscode-dev) for an editor in the browser
- [container2wasm](https://github.com/container2wasm/container2wasm), [QEMU-Wasm](https://github.com/ktock/qemu-wasm), [v86](https://github.com/copy/v86), and [WebVM](https://github.com/leaningtech/webvm) for Linux in a tab

QEMU is GPL-licensed. container2wasm is Apache-2.0. The source in this repository is Apache-2.0.

Running code-server inside QEMU-Wasm does not open the editor port in a usable time. The site therefore runs code-server as its own container.
