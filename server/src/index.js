// Floetende Kroeten - PC server.
//
// Usage:
//   node src/index.js                 auto-detect the gateway's serial port
//   node src/index.js --port COM5     use a fixed serial port
//   node src/index.js --sim           run with simulated gateway + nodes
//
// Options: --http 8080, --data <dir>, --sim-nodes 16, --sim-players 50, --sim-seed 1
// Data directory (default server/data, server/data/sim in simulation mode)
// holds library.db and one database per saved game in games/.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer } from 'ws';

import { createApi } from './api.js';
import { Bridge, SerialLink } from './bridge.js';
import { Flasher } from './flasher.js';
import { EVENT_KIND } from './game.js';
import { GameManager } from './games.js';
import { decodeHeartbeat, PKT } from './protocol.js';
import { SimLink } from './simulator.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const simulate = Boolean(arg('sim', false));
const httpPort = Number(arg('http', process.env.PORT || 8080));
const baseDir = path.join(here, '..', 'data');
const customDataDir = arg('data', null);
const dataDir = path.resolve(customDataDir || (simulate ? path.join(baseDir, 'sim') : baseDir));
// Database of the former single-game version, imported once into the default
// data directory (never into a custom one).
const legacyDbFile = customDataDir ? null : path.join(baseDir, simulate ? 'simulation.db' : 'game.db');

const log = {
  info: (m) => console.log(`[${new Date().toLocaleTimeString('de-DE')}] ${m}`),
  warn: (m) => console.warn(`[${new Date().toLocaleTimeString('de-DE')}] WARN ${m}`),
  error: (m) => console.error(`[${new Date().toLocaleTimeString('de-DE')}] ERROR ${m}`),
};

const link = simulate
  ? new SimLink({
      nodes: Number(arg('sim-nodes', 16)),
      players: Number(arg('sim-players', 50)),
      seed: Number(arg('sim-seed', 1)),
      stateFile: path.join(dataDir, 'sim-cards.json'),
      log,
    })
  : new SerialLink({ path: arg('port', process.env.FK_SERIAL_PORT), log });
const bridge = new Bridge(link, log);
bridge.simulated = simulate;
const manager = new GameManager({
  dataDir,
  bridge,
  log,
  legacyDbFile,
  // Simulated stations get names, prices (shops) and cooldowns on registration.
  nodeDefaults: simulate ? (nodeId) => link.nodeDefaults(nodeId) : null,
});
log.info(`data: ${dataDir} · active game: "${manager.currentInfo().name}"`);

bridge.handlers.reliable = (nodeId, buf) => manager.ingestReliable(nodeId, buf);
bridge.handlers.hello = () => manager.current.onGatewayHello();
bridge.handlers.rx = (nodeId, pt, hops, payload) => {
  if (pt === PKT.HEARTBEAT) {
    broadcast('radio', { d: 'rx', pt, node: nodeId }); // map: heartbeat dot station -> bridge
    try {
      manager.current.ingestHeartbeat(nodeId, decodeHeartbeat(payload), hops);
    } catch (err) {
      log.warn(`bad heartbeat from ${nodeId.toString(16)}: ${err.message}`);
    }
  }
};
bridge.on('debug', (line) => {
  if (process.env.FK_DEBUG) log.info(`gw: ${line}`);
});

// --- HTTP + WebSocket --------------------------------------------------------
const app = express();
const flasher = new Flasher({
  firmwareDir: path.resolve(process.env.FK_FIRMWARE_DIR || path.join(here, '..', '..', 'firmware')),
  link,
  log,
});
app.use('/api', createApi(manager, bridge, flasher));
const publicDir = path.join(here, '..', 'public');
app.use(express.static(publicDir));
// Dashboard sub pages (client-side routing): all serve the same page.
// Must match ROUTES in public/app.js.
const PAGES = ['/monitoring', '/score', '/players', '/transactions', '/stations', '/games', '/settings'];
app.get(PAGES, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// Coalesce bursts of change events into one push per type.
const pending = new Set();
let flushTimer = null;
function notify(type) {
  pending.add(type);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      for (const t of pending) broadcast(t, null);
      pending.clear();
    }, 250);
  }
}

manager.on('tx', (tx) => broadcast('tx', tx));
manager.on('players', () => notify('players'));
manager.on('nodes', () => notify('nodes'));
manager.on('settings', () => notify('settings'));
manager.on('games', () => notify('games'));
bridge.on('status', () => notify('gateway'));
// Every frame the bridge station transmits (beacons, ACKs, server frames) and
// repeated transactions it receives - drawn on the dashboard map.
bridge.on('air', (m) => broadcast('radio', { d: m.d, pt: m.pt, dst: m.dst, node: m.node, n: m.n, dup: m.dup }));
flasher.on('log', (line) => broadcast('flash-log', line));
flasher.on('status', (status) => broadcast('flash', status));

// Hardware events in the transaction log (game events of the active game).
bridge.on('connected', (port) => {
  manager.current.logEvent(EVENT_KIND.BRIDGE_CONNECTED, {
    port,
    text: simulate ? 'Simulation verbunden' : `Bridge-Station verbunden (${port})`,
  });
});
bridge.on('disconnected', (port) => {
  manager.current.logEvent(EVENT_KIND.BRIDGE_DISCONNECTED, {
    port,
    text: simulate ? 'Simulation getrennt' : `Bridge-Station getrennt (${port ?? '?'})`,
  });
});
flasher.on('status', (job) => {
  if (!job || job.state === 'running') return;
  const seconds = job.endedAt && job.startedAt ? Math.round((job.endedAt - job.startedAt) / 1000) : null;
  const what = `${job.label}-Firmware auf ${job.port}`;
  const text =
    job.state === 'success'
      ? `ESP geflasht: ${what}${seconds !== null ? ` (${seconds} s)` : ''}`
      : job.state === 'cancelled'
        ? `Flashen abgebrochen: ${what} – Gerät erneut flashen`
        : `Flashen fehlgeschlagen: ${what}${job.exitCode !== null ? ` (Code ${job.exitCode})` : ''}`;
  manager.current.logEvent(EVENT_KIND.FLASHED, { env: job.env, port: job.port, ok: job.state === 'success', state: job.state, text });
});

// Keep-alive for the bridge node: its status light shows "server connected"
// while frames arrive (it times out after 12 s).
setInterval(() => {
  if (bridge.connected) bridge.send({ t: 'ping' });
}, 5000);

setInterval(() => {
  manager.current.checkNodeLiveness();
  manager.current.syncNodes();
  notify('gateway');
}, 2000);

server.listen(httpPort, () => {
  log.info(`dashboard: http://localhost:${httpPort}`);
  link.start();
});

function shutdown() {
  log.info('shutting down');
  server.close();
  manager.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
