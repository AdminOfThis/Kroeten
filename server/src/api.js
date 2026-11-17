// REST API used by the dashboard.
import express from 'express';

import { CMD, GAME_STATE, TX_RESULT } from './protocol.js';
import { nodeTypesForClient } from './nodeTypes.js';

export function createApi(manager, bridge, flasher) {
  const r = express.Router();
  r.use(express.json({ limit: '100kb' }));
  const game = () => manager.current;

  const wrap = (fn) => (req, res) => {
    try {
      const out = fn(req, res);
      res.json(out ?? { ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  };

  r.get('/state', wrap(() => ({
    game: manager.currentInfo(),
    settings: game().settings(),
    adjVersion: game().adjVersion(),
    teams: game().teams(),
    gateway: bridge.status(),
    nodeTypes: nodeTypesForClient(),
    gameStates: GAME_STATE,
    txResults: TX_RESULT,
  })));

  r.patch('/settings', wrap((req) => game().updateSettings(req.body || {})));
  r.put('/teams', wrap((req) => game().setTeams(req.body)));

  // --- saved games ---
  r.get('/games', wrap(() => manager.list()));
  r.post('/games', wrap((req) => manager.create(req.body || {})));
  r.post('/games/save-copy', wrap((req) => manager.saveCopy(req.body?.name)));
  r.post('/games/:id/load', wrap((req) => manager.load(Number(req.params.id))));
  r.patch('/games/:id', wrap((req) => manager.rename(Number(req.params.id), req.body?.name)));
  r.delete('/games/:id', wrap((req) => manager.remove(Number(req.params.id))));
  r.get('/games/:id/leaderboard', wrap((req) => manager.leaderboardOf(Number(req.params.id))));

  r.get('/leaderboard', wrap(() => game().leaderboard()));
  r.get('/stats', wrap(() => game().stats()));

  r.get('/players', wrap(() => game().listPlayers()));
  r.get('/players/:uid', wrap((req) => game().playerDetail(req.params.uid)));
  r.patch('/players/:uid', wrap((req) => game().updatePlayer(req.params.uid, req.body || {})));
  r.post('/players/:uid/adjust', wrap((req) => game().adjustPlayer(req.params.uid, req.body || {})));

  r.get('/transactions', wrap((req) => game().listTransactions({
    limit: req.query.limit,
    beforeId: req.query.before,
    uid: req.query.uid,
    nodeId: req.query.node,
    result: req.query.result,
    allGames: req.query.all === '1',
  })));

  r.get('/transactions.csv', (req, res) => {
    const rows = game().listTransactions({ limit: 2000, allGames: true });
    const header = ['id', 'zeit', 'karten-epoche', 'station', 'spieler', 'uid', 'ergebnis', 'punkte', 'korrektur', 'vorher', 'nachher'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((t) => [
      t.id,
      new Date(t.received_at).toISOString(),
      t.game_id,
      t.node_name,
      t.player_name,
      t.uid,
      t.result,
      t.delta,
      t.adj_delta,
      t.balance_before,
      t.balance_after,
    ].map(esc).join(';'));
    const name = (manager.currentInfo().name || 'spiel').replace(/[^\w\-äöüÄÖÜß ]+/g, '_');
    res
      .type('text/csv')
      .attachment(`transaktionen - ${name}.csv`)
      .send([header.join(';'), ...lines].join('\r\n'));
  });

  r.get('/nodes', wrap(() => game().listNodes()));
  r.patch('/nodes/:id', wrap((req) => game().updateNode(Number(req.params.id), req.body || {})));
  r.delete('/nodes/:id', wrap((req) => game().deleteNode(Number(req.params.id))));
  r.post('/nodes/remove-stale', wrap(() => game().removeStaleNodes()));
  r.post('/nodes/:id/identify', wrap((req) => game().nodeCommand(Number(req.params.id), CMD.IDENTIFY)));
  r.post('/nodes/:id/reboot', wrap((req) => game().nodeCommand(Number(req.params.id), CMD.REBOOT)));

  r.get('/gateway', wrap(() => ({ ...bridge.status(), log: bridge.debugLines.slice(-100) })));

  // --- node types & firmware flashing ---
  const wrapAsync = (fn) => async (req, res) => {
    try {
      res.json((await fn(req, res)) ?? { ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  };

  r.get('/firmware', wrapAsync(async (req) => {
    const info = await flasher.info({ refresh: req.query.refresh === '1' });
    const nodes = game().listNodes();
    return {
      ...info,
      nodeTypes: nodeTypesForClient().map((t) => ({
        ...t,
        stations: nodes.filter((n) => n.nodeType === t.id).length,
        online: nodes.filter((n) => n.nodeType === t.id && n.online).length,
      })),
    };
  }));
  r.get('/firmware/ports', wrapAsync(() => flasher.ports(bridge.connected ? bridge.path : null)));
  r.get('/firmware/job', wrap(() => flasher.jobStatus(true)));
  r.post('/firmware/flash', wrapAsync((req) => flasher.flash(req.body || {})));
  r.post('/firmware/cancel', wrap(() => flasher.cancel()));

  return r;
}
