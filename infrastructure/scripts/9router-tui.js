#!/usr/bin/env node
// Open the 9router Terminal UI against the ALREADY-RUNNING gateway (the systemd
// unit), instead of the vendor CLI's launcher flow.
//
// Why: `9router` (cli.js) always runs killAllAppProcesses() + killProcessOnPort()
// before showing its menu — that kills every `next-server` on the host
// (cartenz-portal included) and steals port 20128 from 9router.service. This
// script only speaks HTTP to whatever is serving on the port, authenticated with
// the cli token derived from DATA_DIR, so nothing is killed and no port is taken.
//
// The TUI needs a real TTY: it reads keys via readline raw mode. Started without
// a live pty it renders the menu and then the vendor CLI dies with
// `Error: read EIO` (and keeps holding the port). Both cases are handled here.

process.env.DATA_DIR = process.env.DATA_DIR || '/opt/cartenz/.9router';
const port = Number(process.env.ROUTER_PORT || 20128);

if (!process.stdin.isTTY) {
  console.error('9router TUI needs an interactive terminal (stdin is not a TTY).');
  console.error('Run it from a live SSH session, not via nohup/&/a detached wrapper.');
  process.exit(1);
}

// The vendor CLI prints a bare `Error: read EIO` here and then stays alive with
// its detached server holding the port. Say what actually happened instead.
process.stdin.on('error', (err) => {
  console.error(`\nTerminal read error (${err && err.code ? err.code : err && err.message}).`);
  console.error('The pty this process was started on is gone — the window/tab/session');
  console.error('that launched it is closed. Nothing was killed and no port was taken.');
  console.error('Re-run `9router tui` from a live terminal.');
  process.exit(1);
});

const { startTerminalUI } = require('/usr/lib/node_modules/9router/src/cli/terminalUI');

startTerminalUI(port).then(
  () => process.exit(0),
  (err) => {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(1);
  }
);
