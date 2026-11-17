import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GameManager } from '../src/games.js';
import * as P from '../src/protocol.js';

const NODE = 0x0badf00d;
const quiet = { info() {}, warn() {}, error() {} };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-games-'));
  const frames = [];
  const bridge = {
    connected: true,
    sendFrame: (dst, pt, payload) => frames.push({ dst, pt, payload }),
    send: () => true,
  };
  const manager = new GameManager({ dataDir: dir, bridge, log: quiet });
  return { dir, frames, manager, cleanup: () => { manager.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

let seq = 1;
function tx(epoch, o) {
  const t = {
    kind: 1, result: 0, flags: 3, nodeType: 1, uid: 'CAFE0001', team: 255, gameId: epoch,
    cardCounter: 1, delta: 10, adjDelta: 0, adjSeq: 0, balanceBefore: 0, balanceAfter: 10,
    epoch: 1763400000, uptimeMs: 1, nodeCfgVer: 1, ...o,
  };
  return P.encodeRel({ stream: 5, seq: seq++, msgType: P.MSG.TX }, P.encodeTx(t));
}

test('first start creates a game; create, rename and list', () => {
  const { manager, cleanup } = setup();
  try {
    assert.equal(manager.list().length, 1);
    const first = manager.currentInfo();
    manager.rename(first.id, 'Probelauf');
    const created = manager.create({ name: 'Sommerfest' });
    assert.equal(created.name, 'Sommerfest');
    const list = manager.list();
    assert.equal(list.length, 2);
    assert.equal(list.find((g) => g.current).name, 'Sommerfest');
    assert.equal(list.find((g) => !g.current).name, 'Probelauf');
  } finally {
    cleanup();
  }
});

test('pause, load another game, load back and continue with restored balances', () => {
  const { manager, frames, cleanup } = setup();
  try {
    const gameA = manager.currentInfo().id;
    manager.current.updateSettings({ state: P.GAME_STATE.RUNNING });
    const epochA1 = manager.current.settings().gameId;
    manager.ingestReliable(NODE, tx(epochA1, { cardCounter: 3, balanceAfter: 120 }));
    assert.equal(manager.current.listPlayers()[0].points, 120);

    // New game B: A is paused and keeps its state; B starts at 0.
    manager.create({ name: 'B' });
    const epochB = manager.current.settings().gameId;
    assert.notEqual(epochB, epochA1);
    assert.equal(manager.gameById(gameA).settings().state, P.GAME_STATE.PAUSED);
    assert.equal(manager.current.listPlayers().length, 0); // players are not taken over
    manager.ingestReliable(NODE, tx(epochB, { cardCounter: 4, balanceAfter: 10, flags: 3 | P.TX_FLAGS.FRESH_CARD }));

    // A late transaction of game A (node was offline) is filed into game A.
    manager.ingestReliable(NODE, tx(epochA1, { cardCounter: 4, balanceBefore: 120, balanceAfter: 130 }));
    assert.equal(manager.gameById(gameA).listPlayers()[0].points, 130);
    assert.equal(manager.current.listPlayers()[0].points, 10);

    // Load A again: new epoch, balance kept, restore correction for the card.
    frames.length = 0;
    manager.load(gameA);
    const g = manager.current;
    const epochA2 = g.settings().gameId;
    assert.ok(![epochA1, epochB].includes(epochA2));
    assert.equal(g.settings().state, P.GAME_STATE.PAUSED);
    const p = g.listPlayers()[0];
    assert.equal(p.points, 130);
    assert.equal(p.pending_count, 0); // restore is not shown as a pending change
    const restore = g.playerDetail('CAFE0001').adjustments.find((a) => a.kind === 2);
    assert.equal(restore.delta, 130);
    assert.equal(restore.seq, 1);
    assert.equal(restore.game_id, epochA2);

    // Nodes get the new config and the correction list of the new epoch.
    assert.ok(frames.some((f) => f.pt === P.PKT.GAME_CONFIG));
    const chunk = P.decodeAdjChunk(frames.filter((f) => f.pt === P.PKT.ADJ_CHUNK).at(-1).payload);
    assert.equal(chunk.gameId, epochA2);
    assert.ok(chunk.entries.some((e) => e.uid === 'CAFE0001' && e.delta === 130));

    // First scan in the new epoch: card was blank, restore + tap applied.
    manager.ingestReliable(NODE, tx(epochA2, {
      cardCounter: 5, adjSeq: 1, adjDelta: 130, balanceBefore: 0, balanceAfter: 140, flags: 3 | P.TX_FLAGS.FRESH_CARD,
    }));
    const after = manager.current.listPlayers()[0];
    assert.equal(after.points, 140);
    assert.ok(manager.current.playerDetail('CAFE0001').adjustments.every((a) => a.applied_at));
    // The log of A shows the card transactions of both epochs ...
    const log = manager.current.listTransactions();
    assert.equal(log.filter((t) => t.kind < 100).length, 3);
    // ... and the game events (created, running, paused, loaded).
    assert.deepEqual(log.filter((t) => t.kind >= 100).map((t) => t.kind).reverse(), [102, 100, 100, 101]);
  } finally {
    cleanup();
  }
});

test('save copy, view leaderboard of a saved game and delete it', () => {
  const { manager, cleanup } = setup();
  try {
    const epoch = manager.current.settings().gameId;
    manager.current.updateSettings({ state: P.GAME_STATE.RUNNING });
    manager.ingestReliable(NODE, tx(epoch, { balanceAfter: 55 }));
    const copy = manager.saveCopy('Sicherung');
    const lb = manager.leaderboardOf(copy.id);
    assert.equal(lb.game.name, 'Sicherung');
    assert.equal(lb.players[0].points, 55);
    assert.equal(lb.teams.reduce((s, t) => s + t.members, 0), 1);
    assert.throws(() => manager.remove(manager.currentInfo().id), (e) => e.status === 400);
    manager.remove(copy.id);
    assert.equal(manager.list().length, 1);
  } finally {
    cleanup();
  }
});

test('a running game is paused when the server starts', () => {
  const { dir, manager, cleanup } = setup();
  try {
    manager.current.updateSettings({ state: P.GAME_STATE.RUNNING });
    manager.close();
    const bridge = { connected: false, sendFrame() {}, send: () => true };
    const restarted = new GameManager({ dataDir: dir, bridge, log: quiet });
    try {
      assert.equal(restarted.current.settings().state, P.GAME_STATE.PAUSED);
      const ev = restarted.current.listTransactions({ result: 'event' }).find((t) => t.kind === 100);
      assert.equal(JSON.parse(ev.note).reason, 'Server gestartet');
    } finally {
      restarted.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    void cleanup;
  }
});
