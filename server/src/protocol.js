// Binary codec for the mesh payloads.
//
// IMPORTANT: mirrors firmware/lib/fk_common/src/Protocol.h. All values are
// little-endian, structs are packed. Keep both files in sync.

export const PKT = {
  BEACON: 1,
  RELIABLE: 2,
  ACK: 3,
  HEARTBEAT: 4,
  GAME_CONFIG: 5,
  NODE_CONFIG: 6,
  ADJ_CHUNK: 7,
  CMD: 8,
};

export const MSG = { TX: 1 };

export const TX_KIND = { TAP: 1, LOOKUP: 2 };
export const NODE_TYPE = { POINTS: 1, LOOKUP: 2 };

export const TX_RESULT = {
  OK: 0,
  COOLDOWN: 1,
  INSUFFICIENT: 2,
  WRITE_FAILED: 3,
  NODE_OUTDATED: 4,
  DISABLED: 5,
};

export const TX_FLAGS = {
  VERIFIED: 0x01,
  HAS_TIME: 0x02,
  FRESH_CARD: 0x04,
  SINGLE_SLOT: 0x08,
};

export const HB_FLAGS = {
  HAS_TIME: 0x01,
  RFID_OK: 0x02,
  HAS_GAME_CFG: 0x04,
};

export const GAME_STATE = { SETUP: 0, RUNNING: 1, PAUSED: 2, ENDED: 3 };
export const GAME_STATE_NONE = 0xff; // heartbeat: node has no game config yet
export const COST_UNKNOWN = 0xff; // route cost (ETX x5), see MeshTransport.h
export const COST_MAX = 0xfe;
export const COST_PER_LINK = 5; // = 1.0 ETX
export const LINK_COST_MAX = 100;
export const QUALITY_UNKNOWN = 0xff;
export const GAME_FLAGS = { BUZZER: 0x01 };
export const NODE_CFG_FLAGS = { ENABLED: 0x01 };
export const CMD = { IDENTIFY: 1, REBOOT: 2 };

export const MAX_TEAMS = 16;
export const TEAM_NONE = 0xff;
export const COOLDOWN_USE_DEFAULT = 0xffff;
export const NODE_NAME_LEN = 20;
export const NODE_TYPE_DATA_LEN = 32;
export const MAX_PAYLOAD = 230;

export const SIZES = {
  REL_HEADER: 9,
  TX_BODY: 50,
  HEARTBEAT: 33,
  GAME_CONFIG: 61,
  NODE_CONFIG: 59,
  ADJ_CHUNK_HDR: 9,
  ADJ_ENTRY: 18,
};
export const ADJ_PER_CHUNK = Math.floor((MAX_PAYLOAD - SIZES.ADJ_CHUNK_HDR) / SIZES.ADJ_ENTRY); // 12

export function uidToHex(bytes) {
  return Buffer.from(bytes).toString('hex').toUpperCase();
}

export function hexToUid(hex) {
  const b = Buffer.from(hex, 'hex');
  if (b.length === 0 || b.length > 10) throw new Error(`invalid uid ${hex}`);
  return b;
}

// --- reliable envelope -----------------------------------------------------

export function decodeRel(buf) {
  if (buf.length < SIZES.REL_HEADER) throw new Error('reliable message too short');
  return {
    stream: buf.readUInt32LE(0),
    seq: buf.readUInt32LE(4),
    msgType: buf[8],
    body: buf.subarray(SIZES.REL_HEADER),
  };
}

export function encodeRel({ stream, seq, msgType }, body) {
  const h = Buffer.alloc(SIZES.REL_HEADER);
  h.writeUInt32LE(stream >>> 0, 0);
  h.writeUInt32LE(seq >>> 0, 4);
  h[8] = msgType;
  return Buffer.concat([h, body]);
}

// --- TxBody ------------------------------------------------------------------

export function decodeTx(b) {
  if (b.length < SIZES.TX_BODY) throw new Error('tx body too short');
  const uidLen = Math.min(b[4], 10);
  return {
    kind: b[0],
    result: b[1],
    flags: b[2],
    nodeType: b[3],
    uid: uidToHex(b.subarray(5, 5 + uidLen)),
    team: b[15],
    gameId: b.readUInt16LE(16),
    cardCounter: b.readUInt32LE(18),
    delta: b.readInt32LE(22),
    adjDelta: b.readInt32LE(26),
    adjSeq: b.readUInt16LE(30),
    balanceBefore: b.readInt32LE(32),
    balanceAfter: b.readInt32LE(36),
    epoch: b.readUInt32LE(40),
    uptimeMs: b.readUInt32LE(44),
    nodeCfgVer: b.readUInt16LE(48),
  };
}

export function encodeTx(t) {
  const b = Buffer.alloc(SIZES.TX_BODY);
  const uid = hexToUid(t.uid);
  b[0] = t.kind;
  b[1] = t.result;
  b[2] = t.flags;
  b[3] = t.nodeType;
  b[4] = uid.length;
  uid.copy(b, 5);
  b[15] = t.team;
  b.writeUInt16LE(t.gameId, 16);
  b.writeUInt32LE(t.cardCounter >>> 0, 18);
  b.writeInt32LE(t.delta, 22);
  b.writeInt32LE(t.adjDelta, 26);
  b.writeUInt16LE(t.adjSeq, 30);
  b.writeInt32LE(t.balanceBefore, 32);
  b.writeInt32LE(t.balanceAfter, 36);
  b.writeUInt32LE(t.epoch >>> 0, 40);
  b.writeUInt32LE(t.uptimeMs >>> 0, 44);
  b.writeUInt16LE(t.nodeCfgVer, 48);
  return b;
}

// --- Heartbeat ---------------------------------------------------------------

// Heartbeat is followed by: uint8 count, then count x { uint32 id, uint8 perMin, uint8 quality }
// quality: % of beacon rounds the neighbour was heard (QUALITY_UNKNOWN = not enough data).
export const HB_NEIGHBOR_SIZE = 6;

function decodeNeighbors(b, offset) {
  const neighbors = [];
  if (b.length <= offset) return neighbors;
  const n = b[offset];
  for (let i = 0; i < n; i++) {
    const off = offset + 1 + i * HB_NEIGHBOR_SIZE;
    if (off + HB_NEIGHBOR_SIZE > b.length) break;
    neighbors.push({ id: b.readUInt32LE(off), perMin: b[off + 4], quality: b[off + 5] });
  }
  return neighbors;
}

export function decodeHeartbeat(b) {
  if (b.length < SIZES.HEARTBEAT) throw new Error('heartbeat too short');
  return {
    neighbors: decodeNeighbors(b, SIZES.HEARTBEAT),
    nodeType: b[0],
    fwVersion: b.readUInt16LE(1),
    gameCfgVer: b.readUInt16LE(3),
    gameId: b.readUInt16LE(5),
    nodeCfgVer: b.readUInt16LE(7),
    adjVer: b.readUInt32LE(9),
    queueLen: b.readUInt16LE(13),
    uptimeSec: b.readUInt32LE(15),
    dist: b[19],
    flags: b[20],
    adjCount: b.readUInt16LE(21),
    txCount: b.readUInt32LE(23),
    gameState: b[27], // GAME_STATE_NONE (0xFF) = no game config yet
    cost: b[28], // route cost to the bridge, ETX x5 (COST_UNKNOWN = no route)
    parent: b.readUInt32LE(29), // next device on the route (bridge id for 1 hop), 0 = none
  };
}

export function encodeHeartbeat(h) {
  const b = Buffer.alloc(SIZES.HEARTBEAT);
  b[0] = h.nodeType;
  b.writeUInt16LE(h.fwVersion, 1);
  b.writeUInt16LE(h.gameCfgVer, 3);
  b.writeUInt16LE(h.gameId, 5);
  b.writeUInt16LE(h.nodeCfgVer, 7);
  b.writeUInt32LE(h.adjVer >>> 0, 9);
  b.writeUInt16LE(h.queueLen, 13);
  b.writeUInt32LE(h.uptimeSec >>> 0, 15);
  b[19] = h.dist;
  b[20] = h.flags;
  b.writeUInt16LE(h.adjCount, 21);
  b.writeUInt32LE(h.txCount >>> 0, 23);
  b[27] = h.gameState ?? GAME_STATE_NONE;
  b[28] = h.cost ?? COST_UNKNOWN;
  b.writeUInt32LE((h.parent ?? 0) >>> 0, 29);
  const nb = (h.neighbors || []).slice(0, 16);
  const tail = Buffer.alloc(1 + nb.length * HB_NEIGHBOR_SIZE);
  tail[0] = nb.length;
  nb.forEach((n, i) => {
    const off = 1 + i * HB_NEIGHBOR_SIZE;
    tail.writeUInt32LE(n.id >>> 0, off);
    tail[off + 4] = Math.min(255, Math.max(0, Math.round(n.perMin)));
    tail[off + 5] = n.quality ?? QUALITY_UNKNOWN;
  });
  return Buffer.concat([b, tail]);
}

// --- Game config -------------------------------------------------------------

export function parseHexColor(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color || '');
  if (!m) return [255, 255, 255];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

export function encodeGameConfig(cfg, teams) {
  const b = Buffer.alloc(SIZES.GAME_CONFIG);
  b.writeUInt16LE(cfg.version & 0xffff, 0);
  b.writeUInt16LE(cfg.gameId & 0xffff, 2);
  b[4] = cfg.state;
  b[5] = Math.max(0, Math.min(255, cfg.brightness));
  b.writeUInt16LE(Math.max(0, Math.min(0xfffe, cfg.defaultCooldownSec)), 6);
  b[8] = cfg.buzzer ? GAME_FLAGS.BUZZER : 0;
  const list = teams.slice(0, MAX_TEAMS);
  b[9] = list.length;
  list.forEach((t) => {
    const [r, g, bl] = parseHexColor(t.color);
    const off = 10 + t.id * 3;
    if (t.id < MAX_TEAMS) {
      b[off] = r;
      b[off + 1] = g;
      b[off + 2] = bl;
    }
  });
  b[58] = Math.max(0, Math.min(100, cfg.volume ?? 70));
  b.writeUInt16LE(Math.max(0, Math.min(30000, cfg.lookupCost ?? 0)), 59);
  return b;
}

export function decodeGameConfig(b) {
  const teamCount = b[9];
  const colors = [];
  for (let i = 0; i < teamCount; i++) colors.push([b[10 + i * 3], b[11 + i * 3], b[12 + i * 3]]);
  return {
    version: b.readUInt16LE(0),
    gameId: b.readUInt16LE(2),
    state: b[4],
    brightness: b[5],
    defaultCooldownSec: b.readUInt16LE(6),
    buzzer: (b[8] & GAME_FLAGS.BUZZER) !== 0,
    teamCount,
    colors,
    volume: b[58],
    lookupCost: b.length >= 61 ? b.readUInt16LE(59) : 0,
  };
}

// --- Node config -------------------------------------------------------------

export function encodeNodeConfig({ version, nodeType, enabled, cooldownSec, name, typeData }) {
  const b = Buffer.alloc(SIZES.NODE_CONFIG);
  b.writeUInt16LE(version & 0xffff, 0);
  b[2] = nodeType;
  b[3] = enabled ? NODE_CFG_FLAGS.ENABLED : 0;
  const cd = cooldownSec === null || cooldownSec === undefined ? COOLDOWN_USE_DEFAULT : Math.max(0, Math.min(0xfffe, cooldownSec));
  b.writeUInt16LE(cd, 4);
  // ASCII only on the device; replace umlauts so names stay readable in logs.
  const ascii = (name || '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, NODE_NAME_LEN - 1);
  b.write(ascii, 6, 'ascii');
  const td = typeData || Buffer.alloc(0);
  b[26] = Math.min(td.length, NODE_TYPE_DATA_LEN);
  td.copy(b, 27, 0, NODE_TYPE_DATA_LEN);
  return b;
}

export function decodeNodeConfig(b) {
  const nameEnd = b.indexOf(0, 6);
  return {
    version: b.readUInt16LE(0),
    nodeType: b[2],
    enabled: (b[3] & NODE_CFG_FLAGS.ENABLED) !== 0,
    cooldownSec: b.readUInt16LE(4) === COOLDOWN_USE_DEFAULT ? null : b.readUInt16LE(4),
    name: b.toString('ascii', 6, nameEnd >= 6 && nameEnd < 26 ? nameEnd : 26),
    typeData: b.subarray(27, 27 + b[26]),
  };
}

// --- Pending corrections -----------------------------------------------------

// entries: [{ uid: 'hex', seq, delta, team (number | null) }]
export function encodeAdjChunks(version, gameId, entries) {
  const count = Math.max(1, Math.ceil(entries.length / ADJ_PER_CHUNK));
  if (count > 255) throw new Error('too many pending corrections');
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const part = entries.slice(i * ADJ_PER_CHUNK, (i + 1) * ADJ_PER_CHUNK);
    const b = Buffer.alloc(SIZES.ADJ_CHUNK_HDR + part.length * SIZES.ADJ_ENTRY);
    b.writeUInt32LE(version >>> 0, 0);
    b.writeUInt16LE(gameId & 0xffff, 4);
    b[6] = i;
    b[7] = count;
    b[8] = part.length;
    part.forEach((e, j) => {
      const off = SIZES.ADJ_CHUNK_HDR + j * SIZES.ADJ_ENTRY;
      const uid = hexToUid(e.uid);
      b[off] = uid.length;
      uid.copy(b, off + 1);
      b.writeUInt16LE(e.seq, off + 11);
      b.writeInt32LE(e.delta, off + 13);
      b[off + 17] = e.team === null || e.team === undefined ? TEAM_NONE : e.team;
    });
    chunks.push(b);
  }
  return chunks;
}

export function decodeAdjChunk(b) {
  const n = b[8];
  const entries = [];
  for (let j = 0; j < n; j++) {
    const off = SIZES.ADJ_CHUNK_HDR + j * SIZES.ADJ_ENTRY;
    const len = Math.min(b[off], 10);
    entries.push({
      uid: uidToHex(b.subarray(off + 1, off + 1 + len)),
      seq: b.readUInt16LE(off + 11),
      delta: b.readInt32LE(off + 13),
      team: b[off + 17] === TEAM_NONE ? null : b[off + 17],
    });
  }
  return { version: b.readUInt32LE(0), gameId: b.readUInt16LE(4), index: b[6], count: b[7], entries };
}

export function encodeCmd(cmd) {
  return Buffer.from([cmd]);
}

// --- serial framing ------------------------------------------------------------

export function crc16(buf) {
  let crc = 0xffff;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function frameLine(obj) {
  const json = JSON.stringify(obj);
  const crc = crc16(Buffer.from(json, 'utf8')).toString(16).padStart(4, '0');
  return `@${json}*${crc}\n`;
}

// Returns the parsed object, null for debug lines, or throws on corrupt frames.
export function parseLine(line) {
  const l = line.replace(/\r$/, '');
  if (!l.startsWith('@')) return null;
  const star = l.lastIndexOf('*');
  if (star < 0 || l.length - star !== 5) throw new Error('malformed frame');
  const json = l.slice(1, star);
  const crc = parseInt(l.slice(star + 1), 16);
  if (crc16(Buffer.from(json, 'utf8')) !== crc) throw new Error('crc mismatch');
  return JSON.parse(json);
}
