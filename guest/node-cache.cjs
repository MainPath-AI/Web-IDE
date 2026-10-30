// Node's bytecode cache also works on Linux. VS Code's packaged-cache bootstrap
// enables only its Windows cache, so enable this guest-local cache explicitly.
const cache = require("node:module");
cache.enableCompileCache(process.env.NODE_COMPILE_CACHE);
const flush = () => cache.flushCompileCache();
// The native warmup flushes explicitly. Avoid periodic cache I/O on the
// browser's emulated CPU while the editor is serving file and terminal RPCs.
process.on("SIGUSR2", flush);
process.on("exit", flush);
