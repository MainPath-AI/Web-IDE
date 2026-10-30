// Node's bytecode cache also works on Linux. VS Code's packaged-cache bootstrap
// enables only its Windows cache, so enable this guest-local cache explicitly.
const cache = require("node:module");
cache.enableCompileCache(process.env.NODE_COMPILE_CACHE);
const flush = () => cache.flushCompileCache();
setInterval(flush, 1000).unref();
process.on("SIGUSR2", flush);
process.on("exit", flush);
