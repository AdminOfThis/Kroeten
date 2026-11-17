import assert from 'node:assert/strict';
import test from 'node:test';

import * as P from '../src/protocol.js';

const sampleTx = {
  kind: 1,
  result: 0,
  flags: 3,
  nodeType: 1,
  uid: '04A1B2C3D4E5F6',
  team: 2,
  gameId: 7,
  cardCounter: 123456,
  delta: -25,
  adjDelta: 40,
  adjSeq: 3,
  balanceBefore: 100,
  balanceAfter: 115,
  epoch: 1763400000,
  uptimeMs: 987654,
  nodeCfgVer: 9,
};

test('tx body round trip has firmware size', () => {
  const b = P.encodeTx(sampleTx);
  assert.equal(b.length, P.SIZES.TX_BODY);
  assert.deepEqual(P.decodeTx(b), sampleTx);
});

test('reliable envelope round trip', () => {
  const body = P.encodeTx(sampleTx);
  const rel = P.decodeRel(P.encodeRel({ stream: 0xdeadbeef, seq: 42, msgType: P.MSG.TX }, body));
  assert.equal(rel.stream, 0xdeadbeef);
  assert.equal(rel.seq, 42);
  assert.equal(rel.msgType, P.MSG.TX);
  assert.deepEqual(P.decodeTx(rel.body), sampleTx);
});

test('heartbeat round trip', () => {
  const hb = {
    nodeType: 1, fwVersion: 1, gameCfgVer: 5, gameId: 2, nodeCfgVer: 3, adjVer: 70000,
    queueLen: 4, uptimeSec: 3600, dist: 2, flags: 7, adjCount: 12, txCount: 99, gameState: 2, cost: 27, parent: 0x5a1a0001,
  };
  const b = P.encodeHeartbeat(hb);
  assert.equal(b.length, P.SIZES.HEARTBEAT + 1);
  assert.deepEqual(P.decodeHeartbeat(b), { ...hb, neighbors: [] });

  const neighbors = [{ id: 0xdeadbeef, perMin: 42, quality: 93 }, { id: 7, perMin: 3, quality: 255 }];
  const b2 = P.encodeHeartbeat({ ...hb, neighbors });
  assert.equal(b2.length, P.SIZES.HEARTBEAT + 1 + 2 * P.HB_NEIGHBOR_SIZE);
  assert.deepEqual(P.decodeHeartbeat(b2).neighbors, neighbors);
  // heartbeat of older firmware without neighbour list
  assert.deepEqual(P.decodeHeartbeat(b.subarray(0, P.SIZES.HEARTBEAT)).neighbors, []);
});

test('game config encodes team colours by team id', () => {
  const b = P.encodeGameConfig(
    { version: 3, gameId: 2, state: 1, brightness: 90, defaultCooldownSec: 60, buzzer: true, volume: 42, lookupCost: 250 },
    [{ id: 0, color: '#ff0000' }, { id: 1, color: '#00ff80' }],
  );
  assert.equal(b.length, P.SIZES.GAME_CONFIG);
  const d = P.decodeGameConfig(b);
  assert.equal(d.version, 3);
  assert.equal(d.state, 1);
  assert.equal(d.buzzer, true);
  assert.equal(d.volume, 42);
  assert.equal(d.lookupCost, 250);
  assert.deepEqual(d.colors, [[255, 0, 0], [0, 255, 128]]);
});

test('node config keeps ascii name and type data', () => {
  const b = P.encodeNodeConfig({
    version: 4, nodeType: 1, enabled: true, cooldownSec: null, name: 'Brücke Süd', typeData: Buffer.from([0xf6, 0xff]),
  });
  assert.equal(b.length, P.SIZES.NODE_CONFIG);
  const d = P.decodeNodeConfig(b);
  assert.equal(d.name, 'Bruecke Sued');
  assert.equal(d.cooldownSec, null);
  assert.equal(d.typeData.readInt16LE(0), -10);
});

test('adjustment list is chunked and round-trips', () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({
    uid: `0102030${i % 10}`, seq: i + 1, delta: i - 10, team: i % 3 === 0 ? null : i % 4,
  }));
  const chunks = P.encodeAdjChunks(11, 2, entries);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.length <= P.MAX_PAYLOAD);
  const decoded = chunks.map(P.decodeAdjChunk);
  assert.deepEqual(decoded.flatMap((d) => d.entries), entries);
  assert.equal(decoded[2].count, 3);
  // empty list still produces one chunk so nodes can commit "no corrections"
  assert.equal(P.encodeAdjChunks(12, 2, []).length, 1);
});

test('serial framing matches crc and rejects corruption', () => {
  const line = P.frameLine({ t: 'ack', q: 17 });
  assert.deepEqual(P.parseLine(line.trimEnd()), { t: 'ack', q: 17 });
  assert.equal(P.parseLine('# debug output'), null);
  assert.throws(() => P.parseLine(line.replace('17', '18').trimEnd()));
  // CRC-16/CCITT-FALSE check value
  assert.equal(P.crc16(Buffer.from('123456789')), 0x29b1);
});
