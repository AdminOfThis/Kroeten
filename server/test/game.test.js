import assert from 'node:assert/strict';
import test from 'node:test';

import { openDatabase } from '../src/db.js';
import { Game } from '../src/game.js';
import * as P from '../src/protocol.js';

const NODE = 0x1234abcd;
const quiet = { info() {}, warn() {}, error() {} };

function setup() {
  const db = openDatabase(':memory:');
  const frames = [];
  const bridge = {
    connected: true,
    sendFrame: (dst, pt, payload) => frames.push({ dst, pt, payload }),
    send: () => true,
  };
  return { db, frames, game: new Game(db, bridge, quiet) };
}

let seq = 1;
function tx(game, overrides) {
  const t = {
    kind: 1, result: 0, flags: 3, nodeType: 1, uid: 'AABBCCDD', team: 255, gameId: game.settings().gameId,
    cardCounter: 1, delta: 10, adjDelta: 0, adjSeq: 0, balanceBefore: 0, balanceAfter: 10,
    epoch: 1763400000, uptimeMs: 1, nodeCfgVer: 1, ...overrides,
  };
  return P.encodeRel({ stream: 77, seq: overrides.seq ?? seq++, msgType: P.MSG.TX }, P.encodeTx(t));
}

test('transaction creates player and node, duplicates are ignored', () => {
  const { game } = setup();
  const msg = tx(game, { seq: 1 });
  game.ingestReliable(NODE, msg);
  game.ingestReliable(NODE, msg); // retransmission
  const players = game.listPlayers();
  assert.equal(players.length, 1);
  assert.equal(players[0].points, 10);
  assert.equal(players[0].tap_count, 1);
  assert.equal(game.listTransactions().length, 1);
  assert.equal(game.listNodes().length, 1);
});

test('late message from an offline node does not overwrite newer card state', () => {
  const { game } = setup();
  game.ingestReliable(NODE, tx(game, { seq: 10, cardCounter: 5, balanceAfter: 50 }));
  game.ingestReliable(NODE + 1, tx(game, { seq: 11, cardCounter: 3, balanceAfter: 30 }));
  const p = game.listPlayers()[0];
  assert.equal(p.points, 50);
  assert.equal(p.card_counter, 5);
  assert.equal(game.listTransactions().length, 2);
});

test('corrections are broadcast, applied via card adjSeq and cleared', () => {
  const { game, frames } = setup();
  game.ingestReliable(NODE, tx(game, { seq: 20, cardCounter: 1, balanceAfter: 10 }));
  frames.length = 0;

  game.adjustPlayer('AABBCCDD', { delta: 25, reason: 'Bonus' });
  game.adjustPlayer('AABBCCDD', { setTo: 100 }); // 100 - (10 + 25) = 65
  let p = game.listPlayers()[0];
  assert.equal(p.pending_delta, 90);
  assert.equal(p.pending_count, 2);

  const adjFrames = frames.filter((f) => f.pt === P.PKT.ADJ_CHUNK);
  const last = P.decodeAdjChunk(adjFrames[adjFrames.length - 1].payload);
  // seq 1 = automatic team assignment of the new player
  assert.deepEqual(last.entries.map((e) => [e.seq, e.delta]), [[1, 0], [2, 25], [3, 65]]);

  // Node applies all corrections on the next tap.
  const v0 = game.adjVersion();
  game.ingestReliable(NODE, tx(game, { seq: 21, cardCounter: 2, adjSeq: 3, adjDelta: 90, balanceBefore: 10, balanceAfter: 110 }));
  p = game.listPlayers()[0];
  assert.equal(p.points, 110);
  assert.equal(p.pending_count, 0);
  assert.equal(game.adjVersion(), v0); // no re-broadcast just because corrections were applied

  // Next correction continues after the applied sequence.
  game.adjustPlayer('AABBCCDD', { delta: -5 });
  const detail = game.playerDetail('AABBCCDD');
  assert.equal(detail.adjustments[0].seq, 4);
});

test('new players are put into the smallest team, nobody is without a team', () => {
  const { game } = setup(); // 4 default teams
  for (let i = 0; i < 8; i++) {
    game.ingestReliable(NODE, tx(game, { seq: 100 + i, uid: `0000000${i}` }));
  }
  const sizes = game.leaderboard().teams.map((t) => t.members);
  assert.deepEqual(sizes, [2, 2, 2, 2]);
  assert.ok(game.listPlayers().every((p) => p.team_id !== null));
  // automatic assignment creates a team correction so the colour reaches the card
  const detail = game.playerDetail('00000000');
  assert.equal(detail.adjustments[0].kind, 1);
  assert.equal(detail.player.pending_count, 0); // team corrections are not shown as pending points

  assert.throws(() => game.updatePlayer('00000000', { teamId: null }), (e) => e.status === 400);

  // Removing teams redistributes their players.
  game.setTeams([{ name: 'A', color: '#ff0000' }, { name: 'B', color: '#00ff00' }]);
  assert.deepEqual(game.leaderboard().teams.map((t) => t.members).sort(), [4, 4]);
});

test('team change creates a team correction', () => {
  const { game } = setup();
  game.ingestReliable(NODE, tx(game, { seq: 30, cardCounter: 4, balanceAfter: 40 }));
  const other = game.listPlayers()[0].team_id === 1 ? 2 : 1;
  game.updatePlayer('AABBCCDD', { teamId: other, name: 'Anna' });
  const detail = game.playerDetail('AABBCCDD');
  assert.equal(detail.player.name, 'Anna');
  assert.equal(detail.adjustments[0].team_id, other);
});

test('teams are only editable in setup state', () => {
  const { game } = setup();
  game.setTeams([{ name: 'A', color: '#ff0000' }, { name: 'B', color: '#00ff00' }]);
  assert.equal(game.teams().length, 2);
  game.updateSettings({ state: P.GAME_STATE.RUNNING });
  assert.throws(() => game.setTeams([{ name: 'C', color: '#0000ff' }]), (e) => e.status === 409);
  assert.equal(game.teams().length, 2);
});

test('game state changes are logged as events but not counted as transactions', () => {
  const { game } = setup();
  game.ingestReliable(NODE, tx(game, { seq: 300 }));
  game.updateSettings({ state: P.GAME_STATE.RUNNING });
  game.updateSettings({ brightness: 50 }); // no state change -> no event
  game.updateSettings({ state: P.GAME_STATE.PAUSED });
  const events = game.listTransactions().filter((t) => t.kind >= 100);
  assert.equal(events.length, 2);
  assert.deepEqual(JSON.parse(events[0].note), { from: P.GAME_STATE.RUNNING, to: P.GAME_STATE.PAUSED });
  assert.equal(game.stats().transactions, 1);
  assert.equal(game.listTransactions({ result: 'event' }).length, 2);
  assert.equal(game.listTransactions({ result: '0' }).length, 1);
});

test('manual dashboard changes are kept in an audit log only shown with its filter', () => {
  const { game } = setup();
  game.ingestReliable(NODE, tx(game, { seq: 400 }));
  const before = game.listTransactions().length;
  game.updatePlayer('AABBCCDD', { name: 'Anna', notes: '' }); // notes unchanged -> only name logged
  game.updatePlayer('AABBCCDD', { name: 'Anna' }); // no change -> no entry
  game.adjustPlayer('AABBCCDD', { delta: 25, reason: 'Bonus' });
  game.updateNode(NODE, { typeConfig: { points: -15 }, cooldownSec: 30 }); // cooldown is ignored (game setting)
  game.updateSettings({ volume: 40 });

  const manual = game.listTransactions({ result: 'manual' }).map((t) => JSON.parse(t.note).text);
  assert.equal(manual.length, 4);
  assert.match(manual[3], /Name „Spieler CCDD“ → „Anna“/);
  assert.match(manual[2], /Punktekorrektur für „Anna“: \+25 – Grund: Bonus/);
  assert.match(manual[1], /Punkte pro Scan 10 → -15$/);
  assert.equal(game.listNodes()[0].cooldownSec, undefined);
  assert.match(manual[0], /Lautstärke 70 → 40 %/);
  // not in the normal log and not counted
  assert.equal(game.listTransactions().length, before);
  assert.equal(game.stats().transactions, 1);
});

test('stations going offline and coming back are logged as game events', () => {
  const { game, db } = setup();
  game.ingestReliable(NODE, tx(game, { seq: 500 }));
  game.checkNodeLiveness(); // initialises silently
  db.prepare('UPDATE nodes SET last_seen = ? WHERE node_id = ?').run(Date.now() - 120_000, NODE);
  game.checkNodeLiveness();
  game.checkNodeLiveness(); // no duplicate
  db.prepare('UPDATE nodes SET last_seen = ? WHERE node_id = ?').run(Date.now(), NODE);
  game.checkNodeLiveness();
  const events = game.listTransactions({ result: 'event' }).map((t) => [t.kind, JSON.parse(t.note).text]);
  assert.equal(events.length, 2);
  assert.equal(events[1][0], 103);
  assert.match(events[1][1], /scheint offline/);
  assert.equal(events[0][0], 104);
  assert.match(events[0][1], /wieder erreichbar/);
});

test('lookup price is a game setting and logged as manual change', () => {
  const { game } = setup();
  assert.equal(game.settings().lookupCost, 5);
  game.updateSettings({ lookupCost: 12 });
  assert.equal(game.settings().lookupCost, 12);
  const manual = game.listTransactions({ result: 'manual' }).map((t) => JSON.parse(t.note).text);
  assert.match(manual[0], /Kosten Kontoabfrage 5 → 12 Punkte/);
});

test('Vorbereitung cannot be re-entered after the game left it', () => {
  const { game } = setup();
  game.updateSettings({ state: P.GAME_STATE.SETUP }); // staying in setup is fine
  game.updateSettings({ state: P.GAME_STATE.RUNNING });
  assert.throws(() => game.updateSettings({ state: P.GAME_STATE.SETUP }), (e) => e.status === 409);
  game.updateSettings({ state: P.GAME_STATE.ENDED });
  assert.throws(() => game.updateSettings({ state: P.GAME_STATE.SETUP }), (e) => e.status === 409);
  assert.equal(game.settings().state, P.GAME_STATE.ENDED);
});

test('remove stale stations keeps active ones and the transaction log', () => {
  const { game, db } = setup();
  game.ingestReliable(NODE, tx(game, { seq: 200 }));
  game.ingestReliable(NODE + 1, tx(game, { seq: 201, uid: '11223344' }));
  // NODE + 1 was last seen 6 minutes ago
  db.prepare('UPDATE nodes SET last_seen = ? WHERE node_id = ?').run(Date.now() - 6 * 60_000, NODE + 1);
  assert.deepEqual(game.removeStaleNodes(), { removed: 1 });
  assert.deepEqual(game.listNodes().map((n) => n.nodeId), [NODE]);
  assert.equal(game.listTransactions().length, 2);
});

test('stale nodes get config re-sent based on heartbeat', () => {
  const { game, frames } = setup();
  game.ingestHeartbeat(NODE, {
    nodeType: 1, fwVersion: 1, gameCfgVer: 0, gameId: 0, nodeCfgVer: 0, adjVer: 0,
    queueLen: 0, uptimeSec: 5, dist: 1, flags: 2, adjCount: 0, txCount: 0,
  }, 0);
  const types = frames.map((f) => f.pt);
  assert.ok(types.includes(P.PKT.GAME_CONFIG));
  assert.ok(types.includes(P.PKT.NODE_CONFIG));
  assert.ok(types.includes(P.PKT.ADJ_CHUNK));
  const ncfg = P.decodeNodeConfig(frames.find((f) => f.pt === P.PKT.NODE_CONFIG).payload);
  assert.equal(ncfg.typeData.readInt16LE(0), 10);
});

test('stations acknowledge game state changes in the log', () => {
  const { game } = setup();
  const s0 = game.settings();
  const hb = (gameState, extra = {}) => ({
    nodeType: 1, fwVersion: 1, gameCfgVer: game.settings().version, gameId: s0.gameId, nodeCfgVer: 1, adjVer: 0,
    queueLen: 0, uptimeSec: 5, dist: 1, flags: 7, adjCount: 0, txCount: 0, gameState, ...extra,
  });
  const ackLog = () => game.listTransactions({ result: 'event' }).filter((t) => t.kind >= 108 && t.kind <= 109);
  // First heartbeats only establish the reported state.
  game.ingestHeartbeat(NODE, hb(P.GAME_STATE.SETUP), 0);
  game.ingestHeartbeat(NODE + 1, hb(P.GAME_STATE_NONE), 0);
  assert.equal(ackLog().length, 0);

  game.updateSettings({ state: P.GAME_STATE.RUNNING });
  game.ingestHeartbeat(NODE, hb(P.GAME_STATE.RUNNING), 0);
  assert.equal(ackLog().length, 1); // NODE + 1 still pending
  game.ingestHeartbeat(NODE, hb(P.GAME_STATE.RUNNING), 0); // unchanged: no new entry
  assert.equal(ackLog().length, 1);
  game.ingestHeartbeat(NODE + 1, hb(P.GAME_STATE.RUNNING), 0);
  const log = ackLog();
  assert.deepEqual(log.map((t) => t.kind).sort(), [108, 108, 109]);
  const summary = JSON.parse(log.find((t) => t.kind === 109).note);
  assert.equal(summary.state, P.GAME_STATE.RUNNING);
  assert.match(summary.text, /allen 2 Stationen/);
  const s = game.listNodes().find((n) => n.nodeId === NODE).status;
  assert.equal(s.gameState, P.GAME_STATE.RUNNING);
});

test('player detail lists name changes as adjustments', () => {
  const { game } = setup();
  game.ingestReliable(NODE, tx(game, { seq: 300 }));
  const uid = 'AABBCCDD';
  const oldName = game.playerDetail(uid).player.name;
  game.updatePlayer(uid, { name: 'Kröte 1' });
  game.updatePlayer(uid, { notes: 'nur Notiz' }); // no name change
  game.updatePlayer(uid, { name: 'Kröte 2' });
  const changes = game.playerDetail(uid).nameChanges;
  assert.deepEqual(changes.map((c) => [c.from, c.to]), [['Kröte 1', 'Kröte 2'], [oldName, 'Kröte 1']]);
});

test('unacknowledged game config is re-sent quickly first, then slower', () => {
  const { game, frames } = setup();
  const stale = {
    nodeType: 1, fwVersion: 1, gameCfgVer: 0, gameId: 0, nodeCfgVer: 0, adjVer: 0,
    queueLen: 0, uptimeSec: 5, dist: 1, flags: 2, adjCount: 0, txCount: 0,
  };
  const gameFrames = () => frames.filter((f) => f.pt === P.PKT.GAME_CONFIG).length;
  game.ingestHeartbeat(NODE, stale, 0); // first send
  assert.equal(gameFrames(), 1);
  game.syncNodes(); // too early
  assert.equal(gameFrames(), 1);
  const ago = (ms) => { game.gameSend.at = Date.now() - ms; game.syncNodes(); return gameFrames(); };
  assert.equal(ago(3_000), 2); // 2nd send after 2.5 s
  assert.equal(ago(3_000), 3); // 3rd send after 2.5 s
  assert.equal(ago(3_000), 3); // then 4 s ...
  assert.equal(ago(4_500), 4);
  assert.equal(ago(5_000), 4); // ... 6 s ...
  assert.equal(ago(6_500), 5);
  assert.equal(ago(7_000), 5); // ... and 8 s from then on
  assert.equal(ago(8_500), 6);
});
