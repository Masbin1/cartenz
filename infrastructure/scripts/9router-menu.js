#!/usr/bin/env node
/**
 * "Choose Interface" menu for 9router on this host — the same four options the
 * vendor CLI shows, minus the launcher flow that breaks the platform.
 *
 * Why this exists instead of the vendor menu: cli.js runs killAllAppProcesses()
 * (kill -9 every `next-server` on the host, cartenz-portal included) and
 * killProcessOnPort() (lsof -ti:20128 → kills 9router.service's own server) at
 * module load, BEFORE drawing the menu, then spawns its own server bound to
 * 0.0.0.0:20128 with data dir ~/.9router. Nothing here does any of that: it only
 * talks HTTP to whatever already serves the port, so 9router.service keeps the
 * port and cartenz-portal keeps running.
 *
 *   bare            -> this menu
 *   web             -> jump straight to the dashboard URL
 *
 * Needs a real TTY (raw-mode stdin reads). Started without one, the vendor path
 * dies with `Error: read EIO`; here you get a plain explanation instead.
 */

process.env.DATA_DIR = process.env.DATA_DIR || '/opt/cartenz/.9router';
const PORT = Number(process.env.ROUTER_PORT || 20128);

const net = require('net');
const { execFile } = require('child_process');
const VENDOR = '/usr/lib/node_modules/9router';

const { selectMenu, pause } = require(VENDOR + '/src/cli/utils/input');
const { clearScreen } = require(VENDOR + '/src/cli/utils/display');
const { getEndpoint } = require(VENDOR + '/src/cli/utils/endpoint');
const { version: VERSION } = require(VENDOR + '/package.json');

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function serverAlive(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

function openBrowser(url) {
  // Headless server: xdg-open usually fails; the URL is always printed.
  execFile('xdg-open', [url], () => {});
  console.log(`\nOpen in your browser: ${url}`);
  console.log(`${DIM}(no GUI here — from your laptop: ssh -L ${PORT}:127.0.0.1:${PORT} root@<host>, then open http://localhost:${PORT}/login)${RESET}`);
}

async function askMenu() {
  clearScreen();

  const alive = await serverAlive(PORT);
  let serverUrl = `http://localhost:${PORT}`;
  try {
    const { endpoint, tunnelEnabled } = await getEndpoint(PORT);
    if (tunnelEnabled) serverUrl = endpoint.replace(/\/v1$/, '');
  } catch { /* keep the local URL */ }

  const subtitle = alive
    ? `🚀 Server: ${GREEN}${serverUrl}${RESET}`
    : `🚀 Server: ${GREEN}${serverUrl}${RESET}  ${YELLOW}(not answering — check: systemctl status 9router)${RESET}`;

  const items = [
    { label: 'Web UI (Open in Browser)', icon: '🌐' },
    { label: 'Terminal UI (Interactive CLI)', icon: '💻' },
    { label: 'Hide to Tray (Background)', icon: '🔔' },
    { label: 'Exit', icon: '🚪' }
  ];

  return selectMenu(`Choose Interface (v${VERSION})`, items, 0, subtitle);
}

async function main() {
  const arg = process.argv[2];
  if (arg === 'web') { openBrowser(`http://127.0.0.1:${PORT}/login`); return; }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('The 9router menu needs an interactive terminal (stdin is not a TTY).');
    console.error('Run it from a live SSH session in the foreground — not via nohup/&/a detached wrapper.');
    process.exit(1);
  }

  // The vendor CLI dies with a bare `Error: read EIO` here and stays alive with
  // its detached server holding the port. Fail cleanly and say what happened.
  process.stdin.on('error', (err) => {
    console.error(`\nTerminal read error (${err && err.code ? err.code : err && err.message}).`);
    console.error('The pty this process was started on is gone — the window/tab/session that');
    console.error('launched it is closed. Nothing was killed and no port was taken.');
    process.exit(1);
  });

  while (true) {
    const selected = await askMenu();

    if (selected === 0) {
      openBrowser(`http://127.0.0.1:${PORT}/login`);
      await pause('\nPress Enter to go back to menu...');
    } else if (selected === 1) {
      const { startTerminalUI } = require(VENDOR + '/src/cli/terminalUI');
      await startTerminalUI(PORT);
      // startTerminalUI returns when "← Back to Interface Menu" is chosen.
    } else if (selected === 2) {
      clearScreen();
      console.log('\nTray mode is not available here.');
      console.log('The tray process spawns its OWN server and takes port 20128 away from');
      console.log('9router.service (which then crash-loops), and a headless server has no');
      console.log('tray icon to click anyway. The unit is already running in the background:');
      console.log('\n  systemctl status 9router');
      console.log('  journalctl -u 9router -f\n');
      await pause('Press Enter to go back to menu...');
    } else {
      // ESC (-1) as well as Exit
      return;
    }
  }
}

main().catch((err) => {
  console.error('Error:', err && err.message ? err.message : err);
  process.exit(1);
});
