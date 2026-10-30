# Browser PTY dependency

`xterm-pty.js` is the unmodified `xterm-pty` 0.10.1 npm distribution (`index.js`).
It is bundled locally so VM startup does not depend on a third-party CDN.
This version matches the Emscripten PTY library selected by the pinned
container2wasm compiler. In particular, its `TCSETS` accepts the plain termios
configuration objects produced by that integration.

- Source revision: https://github.com/mame/xterm-pty/tree/cfcbc7e2145d03a0afef45939e3971becb2b4443
- Official package metadata: https://registry.npmjs.org/xterm-pty/0.10.1
- Distribution: https://registry.npmjs.org/xterm-pty/-/xterm-pty-0.10.1.tgz
- npm tarball integrity (verified before extraction): `sha512-fF4x2iTTE2PmFRaZfQbO8iZB59Krf3q0ORAyYgesGFRGjUDJX36MpsjRVdmdIdA+HEzBcqMAcxzvaW7/rI088w==`
- `index.js` SHA-256: `d242a568a3b1ef487ede00e10108edbc4b9fd93de12db0ef694c9b81e691c649`
- `LICENSE.txt` SHA-256: `45c32f09070ea64647927a671b0c150467e25319d31b9d38fb68e0b149d82268`
- License: MIT; see `xterm-pty.LICENSE`.
