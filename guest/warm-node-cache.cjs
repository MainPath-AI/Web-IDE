// Run inside native QEMU before the RAM snapshot: its virtual CPU, Node binary,
// flags and paths match the browser guest. This prepares bytecode, not an editor
// acceptance result. No synthetic workbench or extension initialization is used.
const { fork } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
if (!root || !process.env.NODE_COMPILE_CACHE) throw new Error("Missing cache configuration");
const child = fork(path.join(root, "lib/vscode/out/bootstrap-fork.js"), ["--type=extensionHost", "--useHostProxy=false", "--transformURIs"], {
  env: { ...process.env, VSCODE_ESM_ENTRYPOINT: "vs/workbench/api/node/extensionHostProcess", VSCODE_CRASH_REPORTER_PROCESS_TYPE: "extensionHost", VSCODE_HANDLES_UNCAUGHT_ERRORS: "true", VSCODE_NLS_CONFIG: JSON.stringify({ userLocale: "en", osLocale: "en", resolvedLanguage: "en", defaultMessagesFile: path.join(root,"lib/vscode/out/nls.messages.json") }) },
  stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
});
let diagnostic = "";
child.stderr.on("data", data => { diagnostic = (diagnostic+data).slice(-3000); });
let warmed = false, stopping = false;
const deadline = setTimeout(() => { child.kill("SIGKILL"); process.exitCode = 1; }, 60000);
child.on("message", () => {
  if (stopping) return;
  stopping = true;
  // The extension module has compiled and reached its IPC initialization.
  // Flush while it is idle, then stop this disposable warmup process.
  child.kill("SIGUSR2");
  setTimeout(() => { warmed = true; child.kill("SIGTERM"); }, 1500);
});
child.on("error", () => { clearTimeout(deadline); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  clearTimeout(deadline);
  const files = fs.existsSync(process.env.NODE_COMPILE_CACHE) ? fs.readdirSync(process.env.NODE_COMPILE_CACHE,{recursive:true}).length : 0;
  if ((!warmed && code !== 0) || files < 3) { process.stderr.write(`WEB_IDE_NODE_CACHE_FAILED files=${files} code=${code} signal=${signal}\n${diagnostic}\n`); process.exitCode = 1; }
  else process.stdout.write(`WEB_IDE_NODE_CACHE_READY files=${files}\n`);
});
