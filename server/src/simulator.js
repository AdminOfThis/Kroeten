// Hardware-free simulation of the gateway + game nodes + player cards.
//
// Speaks exactly the same serial/binary protocol as the real gateway, so the
// whole server (DB, sync logic, dashboard) can be exercised without hardware.
// Nodes randomly go offline for a while: their transactions are queued and
// delivered later, and they miss broadcasts (exercises the resync logic).
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';

import * as P from './protocol.js';

const rand = (n) => Math.floor(Math.random() * n);

// Small seeded PRNG so station ids, card UIDs and the virtual site are the same
// on every start (like real devices, whose ids come from their MAC address).
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randomU32 = (rnd) => Math.floor(rnd() * 0x100000000) >>> 0;

class SimNode {
  constructor(id) {
    this.id = id;
    this.stream = (crypto.randomBytes(4).readUInt32LE(0) | 1) >>> 0;
    this.seq = 1;
    this.queue = [];
    this.game = null;
    this.nodeCfg = null;
    this.adj = { version: 0, gameId: 0, entries: [] };
    this.asm = null;
    this.cooldowns = new Map();
    this.reack = { type: 0, version: 0, count: 0, at: 0 };
    this.online = true;
    this.txCount = 0;
    this.bootMs = Date.now();
    this.dist = 255; // hop count, computed by SimLink.computeTopology()
    this.cost = P.COST_UNKNOWN; // route cost (ETX tenths)
    this.parent = 0;
    this.neighbors = [];
    this.x = 0;
    this.y = 0;
  }

  get nodeType() {
    return this.role?.type ?? 1;
  }

  points() {
    if (this.nodeType === 2) return -(this.game?.lookupCost ?? 0); // lookup costs points
    if (this.nodeCfg && this.nodeCfg.nodeType === 1 && this.nodeCfg.typeData.length >= 2) {
      return this.nodeCfg.typeData.readInt16LE(0);
    }
    return this.role?.points ?? 10; // before the server config arrived
  }

  cooldownSec() {
    if (this.nodeType === 2) return 0; // lookups have no cooldown
    if (this.nodeCfg && this.nodeCfg.cooldownSec !== null) return this.nodeCfg.cooldownSec;
    return this.game ? this.game.defaultCooldownSec : 0;
  }

  onAdjChunk(c) {
    if (c.version === this.adj.version && c.gameId === this.adj.gameId) return;
    if (!this.asm || this.asm.version !== c.version || this.asm.count !== c.count) {
      this.asm = { version: c.version, gameId: c.gameId, count: c.count, chunks: new Map() };
    }
    this.asm.chunks.set(c.index, c.entries);
    if (this.asm.chunks.size === this.asm.count) {
      const entries = [];
      for (let i = 0; i < this.asm.count; i++) entries.push(...this.asm.chunks.get(i));
      this.adj = { version: this.asm.version, gameId: this.asm.gameId, entries };
      this.asm = null;
    }
  }

  // Mirrors NodeBase::reacknowledge(): a config we already have was re-sent,
  // so the server missed our acknowledgement - answer again (max 3 times per
  // version, 5 s apart).
  shouldReack(type, version) {
    const r = this.reack;
    if (r.type !== type || r.version !== version) Object.assign(r, { type, version, count: 0, at: 0 });
    const now = Date.now();
    if (r.count >= 3 || (r.count > 0 && now - r.at < 5000)) return false;
    r.count++;
    r.at = now;
    return true;
  }

  // Mirrors NodeBase::processCard() in the firmware.
  tap(card) {
    if (!this.game || this.game.state !== P.GAME_STATE.RUNNING) return;
    if (this.adj.gameId !== this.game.gameId) return; // correction list not synced yet
    const now = Date.now();
    const gameId = this.game.gameId;
    const tx = {
      kind: this.nodeType === 2 ? P.TX_KIND.LOOKUP : P.TX_KIND.TAP,
      result: P.TX_RESULT.OK,
      flags: P.TX_FLAGS.HAS_TIME,
      nodeType: this.nodeType,
      uid: card.uid,
      team: P.TEAM_NONE,
      gameId,
      cardCounter: 0,
      delta: 0,
      adjDelta: 0,
      adjSeq: 0,
      balanceBefore: 0,
      balanceAfter: 0,
      epoch: Math.floor(now / 1000),
      uptimeMs: (now - this.bootMs) >>> 0,
      nodeCfgVer: this.nodeCfg?.version ?? 0,
    };

    const rec = card.rec;
    let before;
    if (rec && rec.gameId === gameId) {
      before = { ...rec };
    } else if (rec && ((rec.gameId - gameId) << 16) >> 16 > 0) {
      tx.result = P.TX_RESULT.NODE_OUTDATED;
      Object.assign(tx, { team: rec.team, cardCounter: rec.counter, balanceBefore: rec.points, balanceAfter: rec.points });
      return this.enqueue(tx);
    } else {
      before = { gameId, counter: rec ? rec.counter : 0, points: 0, adjSeq: 0, team: P.TEAM_NONE };
      tx.flags |= P.TX_FLAGS.FRESH_CARD;
    }
    const after = { ...before };

    if (this.adj.gameId === gameId) {
      for (;;) {
        const e = this.adj.entries.find((x) => x.uid === card.uid && x.seq === after.adjSeq + 1);
        if (!e) break;
        after.points = Math.max(0, after.points + e.delta);
        if (e.team !== null) after.team = e.team;
        after.adjSeq = e.seq;
      }
    }
    const adjusted = after.adjSeq !== before.adjSeq;
    tx.adjDelta = after.points - before.points;

    const enabled = this.nodeCfg ? this.nodeCfg.enabled : true;
    const cd = this.cooldownSec();
    if (!enabled) {
      tx.result = P.TX_RESULT.DISABLED;
    } else if (cd > 0) {
      const last = this.cooldowns.get(card.uid);
      if (last && now - last < cd * 1000) tx.result = P.TX_RESULT.COOLDOWN;
    }
    if (tx.result === P.TX_RESULT.OK) {
      const d = this.points();
      if (after.points + d < 0) {
        tx.result = P.TX_RESULT.INSUFFICIENT;
      } else {
        after.points += d;
        tx.delta = d;
      }
    }

    if (tx.result === P.TX_RESULT.OK || adjusted) {
      after.counter = before.counter + 1;
      if (Math.random() < WRITE_FAIL_SHARE) {
        Object.assign(tx, {
          result: P.TX_RESULT.WRITE_FAILED,
          delta: 0,
          adjDelta: 0,
          team: before.team,
          adjSeq: before.adjSeq,
          cardCounter: before.counter,
          balanceBefore: before.points,
          balanceAfter: before.points,
        });
        return this.enqueue(tx);
      }
      card.rec = after;
      tx.flags |= P.TX_FLAGS.VERIFIED;
    } else {
      Object.assign(after, before);
      tx.adjDelta = 0;
    }
    if (tx.result === P.TX_RESULT.OK) this.cooldowns.set(card.uid, now);

    Object.assign(tx, {
      team: after.team,
      adjSeq: after.adjSeq,
      cardCounter: after.counter,
      balanceBefore: before.points,
      balanceAfter: after.points,
    });
    this.enqueue(tx);
  }

  enqueue(tx) {
    const body = P.encodeTx(tx);
    this.queue.push(P.encodeRel({ stream: this.stream, seq: this.seq++, msgType: P.MSG.TX }, body));
    this.txCount++;
  }

  heartbeat() {
    return P.encodeHeartbeat({
      nodeType: this.nodeType,
      fwVersion: 1,
      gameCfgVer: this.game?.version ?? 0,
      gameId: this.game?.gameId ?? 0,
      nodeCfgVer: this.nodeCfg?.version ?? 0,
      adjVer: this.adj.version,
      queueLen: this.queue.length,
      uptimeSec: Math.floor((Date.now() - this.bootMs) / 1000),
      dist: this.dist,
      cost: this.cost,
      parent: this.parent,
      flags: P.HB_FLAGS.HAS_TIME | P.HB_FLAGS.RFID_OK | (this.game ? P.HB_FLAGS.HAS_GAME_CFG : 0),
      adjCount: this.adj.entries.length,
      txCount: this.txCount,
      gameState: this.game ? this.game.state : P.GAME_STATE_NONE,
      neighbors: this.neighbors,
    });
  }
}

// Roles of the simulated stations: name, points per scan (negative = shop) and
// cooldown. Applied as the initial station config on the server.
const STATION_ROLES = [
  { name: 'Teich', points: 10 },
  { name: 'Brücke', points: 10 },
  { name: 'Waldrand', points: 15 },
  { name: 'Kiosk', points: -20 },
  { name: 'Mühle', points: 10 },
  { name: 'Turm', points: 20 },
  { name: 'Lichtung', points: 10 },
  { name: 'Laden', points: -40 },
  { name: 'Quelle', points: 15 },
  { name: 'Höhle', points: 25 },
  { name: 'Steg', points: 10 },
  { name: 'Schatzkammer', points: -80 },
  { name: 'Hügel', points: 15 },
  { name: 'Ruine', points: 20 },
  { name: 'Tauschbörse', points: -30 },
  { name: 'Info-Säule', type: 2 }, // Kontostand-Station (price = game setting lookupCost)
];

const SHOP_VISIT_SHARE = 0.25; // share of scans that happen at shops
const BROKE_SHOP_SHARE = 0.12; // share of shop visits by players who cannot afford it (~3 % of all scans)
const WRITE_FAIL_SHARE = 0.003; // card removed too early (write failed)
const FLAKY_HB_LOSS = 0.1; // heartbeat loss of the badly connected stations
// Station outages, see chaos()
const CHAOS_INTERVAL_MS = 3 * 60_000;
const CHAOS_CHANCE = 0.35;
const CHAOS_LONG_SHARE = 0.15;
const FLAKY_LOSS = 0.35; // frame loss of the two badly connected stations
const NORMAL_LOSS = 0.05;
const LINK_OUTLIER_SHARE = 0.15; // share of radio links with poor quality
const ACK_LOSS = 0.02; // ACK to a station lost -> retransmission (duplicate)
const ACK_LOSS_FLAKY = 0.3;

export class SimLink extends EventEmitter {
  // seed: same seed = same stations, cards and site layout on every start.
  // stateFile: card contents are stored there, so a restart does not wipe the
  // virtual cards (on real cards the data simply stays on the chip).
  constructor({ nodes = 16, players = 50, tapIntervalMs = 1000, seed = 1, stateFile = null, log = console } = {}) {
    super();
    this.log = log;
    this.tapIntervalMs = tapIntervalMs;
    this.seed = seed;
    this.stateFile = stateFile;
    const nodeRnd = seededRandom(seed);
    const cardRnd = seededRandom(seed + 1000);
    this.nodes = Array.from({ length: nodes }, (_, i) => {
      const n = new SimNode((randomU32(nodeRnd) | 0x10) >>> 0);
      const role = STATION_ROLES[i % STATION_ROLES.length];
      n.role = i < STATION_ROLES.length ? role : { ...role, name: `${role.name} ${Math.floor(i / STATION_ROLES.length) + 1}` };
      return n;
    });
    this.cards = Array.from({ length: players }, () => ({
      uid: randomU32(cardRnd).toString(16).padStart(8, '0').toUpperCase(),
      rec: null,
    }));
    this.loadCards();
    this.gwId = 0x5a1a0001;
    this.upQueue = []; // { q, node, p, lastSent }
    this.nextQ = 1;
    this.open = false;
    this.layoutGameId = null;
    this.linkVar = new Map(); // per link quality factor (fluctuates)
    this.placeNodes(seed);
    this.computeTopology();
  }

  // Every game gets its own site layout (and therefore its own radio mesh):
  // the layout is derived from the game's card epoch, so the same game keeps
  // its layout across restarts while a new or loaded game gets a different one.
  relayoutFor(gameId) {
    if (gameId === this.layoutGameId) return;
    this.layoutGameId = gameId;
    this.placeNodes(this.seed * 7919 + gameId);
    this.linkVar.clear();
    for (const n of this.nodes) n.parent = 0;
    this.computeTopology();
    this.emit('debug', `# sim: new radio mesh for game epoch ${gameId}`);
  }

  loadCards() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const recs = new Map((saved.cards || []).map((c) => [c.uid, c.rec]));
      for (const c of this.cards) c.rec = recs.get(c.uid) ?? null;
    } catch (err) {
      this.log.warn?.(`simulator: cannot read ${this.stateFile}: ${err.message}`);
    }
  }

  // Debounced save of the virtual card contents.
  saveCardsSoon() {
    if (!this.stateFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        const tmp = `${this.stateFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ seed: this.seed, cards: this.cards }));
        fs.renameSync(tmp, this.stateFile);
      } catch (err) {
        this.log.warn?.(`simulator: cannot save card state: ${err.message}`);
      }
    }, 2000);
    this.saveTimer.unref?.();
  }

  // Initial server-side config for a simulated station (name, points, cooldown).
  nodeDefaults(nodeId) {
    const n = this.nodes.find((x) => x.id === nodeId);
    if (!n) return null;
    const typeConfig = n.nodeType === 1 ? { points: n.role.points } : {};
    return { name: n.role.name, typeConfig };
  }

  // Virtual site: a branched chain. The first stations are close to the bridge
  // node, later ones attach preferably to stations far out, so many stations
  // need 2-4 hops. Each new station is placed where it has the most room.
  placeNodes(layoutSeed) {
    this.range = 230;
    this.gw = { id: this.gwId, x: 0, y: 0, online: true };
    const placed = [this.gw];
    const rnd = seededRandom(layoutSeed + 2000);
    const fromBridge = (p) => Math.hypot(p.x, p.y);
    this.nodes.forEach((n, i) => {
      let anchor = this.gw;
      if (i >= 3) {
        const a = placed[1 + Math.floor(rnd() * (placed.length - 1))];
        const b = placed[1 + Math.floor(rnd() * (placed.length - 1))];
        anchor = fromBridge(a) > fromBridge(b) ? a : b;
      }
      let best = null;
      for (let k = 0; k < 8; k++) {
        const angle = rnd() * Math.PI * 2;
        const d = this.range * (0.6 + rnd() * 0.3);
        const x = anchor.x + Math.cos(angle) * d;
        const y = anchor.y + Math.sin(angle) * d;
        const room = Math.min(...placed.map((p) => Math.hypot(p.x - x, p.y - y)));
        if (!best || room > best.room) best = { x, y, room };
      }
      n.x = best.x;
      n.y = best.y;
      placed.push(n);
    });
    // The two stations farthest out have a bad radio link.
    this.nodes.forEach((n) => (n.flaky = false));
    [...this.nodes].sort((a, b) => fromBridge(b) - fromBridge(a)).slice(0, 2).forEach((n) => (n.flaky = true));
  }

  // A station can only talk to the bridge node if a route exists.
  reachable(n) {
    return n.online && n.cost !== P.COST_UNKNOWN;
  }

  // True delivery probability of the radio link between two devices. Most
  // links are good (~95 %, a little less at the edge of the range); about one
  // in seven links is an outlier (obstacle, bad antenna angle: 55-85 %), and
  // links of the two flaky stations are poor. Each link drifts slightly over
  // time around its own base value (see fluctuateLinks()).
  linkQ(a, b) {
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d > this.range) return 0;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    let v = this.linkVar.get(key);
    if (!v) {
      const base = Math.random() < LINK_OUTLIER_SHARE ? 0.55 + Math.random() * 0.3 : 0.96 + Math.random() * 0.04;
      v = { base, f: base };
      this.linkVar.set(key, v);
    }
    let q = (1 - 0.15 * (d / this.range) ** 8) * v.f;
    if (a.flaky || b.flaky) q *= 0.5;
    return q < 0.05 ? 0 : q;
  }

  // Small drift of every link around its base value (every 30 s).
  fluctuateLinks() {
    for (const v of this.linkVar.values()) {
      v.f = Math.min(1, Math.max(v.base - 0.05, Math.min(v.base + 0.03, v.f + (Math.random() - 0.5) * 0.03)));
    }
  }

  // Mirrors MeshTransport (firmware): every station measures the quality of
  // its links (share of beacon rounds heard, ~16 rounds) and, once per round,
  // picks the neighbour with the lowest cost "neighbour cost + 1/q^2" as its
  // parent - first among links >= 30 %, weak links only as fallback, with
  // 10 % hysteresis. Iterated here until stable (the radio needs a few rounds).
  computeTopology() {
    const devices = [this.gw, ...this.nodes.filter((n) => n.online)];
    const quality = new Map(); // "a|b" -> measured quality in % (with a little noise)
    const qOf = (a, b) => {
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      if (!quality.has(key)) {
        const q = this.linkQ(a, b);
        quality.set(key, q ? Math.max(1, Math.min(100, Math.round(q * 100 + (Math.random() - 0.5) * 3))) : 0);
      }
      return quality.get(key);
    };
    const linkCost = (q) => (q < 7 ? P.LINK_COST_MAX : Math.min(P.LINK_COST_MAX, Math.floor((P.COST_PER_LINK * 10000) / (q * q))));
    const nbs = new Map(devices.map((d) => [d.id, devices.filter((o) => o !== d && qOf(d, o) > 0)]));

    const cost = new Map(devices.map((d) => [d.id, d === this.gw ? 0 : P.COST_UNKNOWN]));
    const hops = new Map(devices.map((d) => [d.id, d === this.gw ? 0 : 255]));
    const parent = new Map(this.nodes.map((n) => [n.id, n.online ? n.parent : 0]));
    for (let round = 0; round < 30; round++) {
      let changed = false;
      for (const n of devices) {
        if (n === this.gw) continue;
        let best = null;
        let parentCost = null;
        for (const pass of [0, 1]) {
          for (const o of nbs.get(n.id)) {
            if (cost.get(o.id) >= P.COST_MAX) continue; // no / saturated route
            const q = qOf(n, o);
            if (pass === 0 && q < 30) continue;
            const c = cost.get(o.id) + linkCost(q);
            if (o.id === parent.get(n.id)) parentCost = c;
            if (!best || c < best.c) best = { o, c };
          }
          if (best) break;
        }
        let pick = best;
        if (best && best.o.id !== parent.get(n.id) && parentCost !== null && parentCost * 10 <= best.c * 11) {
          pick = { o: devices.find((d) => d.id === parent.get(n.id)), c: parentCost };
        }
        const newCost = pick ? Math.min(P.COST_MAX, pick.c) : P.COST_UNKNOWN;
        const newHops = pick ? hops.get(pick.o.id) + 1 : 255;
        const newParent = pick ? pick.o.id : 0;
        if (newCost !== cost.get(n.id) || newHops !== hops.get(n.id) || newParent !== parent.get(n.id)) {
          cost.set(n.id, newCost);
          hops.set(n.id, newHops);
          parent.set(n.id, newParent);
          changed = true;
        }
      }
      if (!changed) break;
    }
    // Frames each device transmits per minute: beacon relays (12) + its
    // heartbeat (3) + relayed traffic of the stations routing through it.
    // What a neighbour hears of it depends on the link quality.
    const children = new Map();
    for (const n of devices) {
      if (n === this.gw) continue;
      const seen = new Set();
      for (let p = parent.get(n.id); p && !seen.has(p); p = parent.get(p)) {
        seen.add(p);
        children.set(p, (children.get(p) || 0) + 1);
        if (p === this.gw.id) break;
      }
    }
    const sentPerMin = (d) => (d === this.gw ? 20 : 15) + 4 * (children.get(d.id) || 0);
    const heard = (listener, speaker) =>
      Math.max(1, Math.round((sentPerMin(speaker) * qOf(listener, speaker)) / 100 + (Math.random() - 0.5) * 2));
    for (const n of this.nodes) {
      const before = n.parent;
      n.cost = n.online ? cost.get(n.id) : P.COST_UNKNOWN;
      n.dist = n.online && n.cost !== P.COST_UNKNOWN ? hops.get(n.id) : 255;
      n.parent = n.online ? parent.get(n.id) : 0;
      if (n.online && before && n.parent !== before) {
        this.emit('debug', `# sim: ${n.role.name} now routes via ${n.parent.toString(16)} (cost ${(n.cost / P.COST_PER_LINK).toFixed(1)})`);
      }
      n.neighbors = !n.online
        ? []
        : nbs.get(n.id).map((o) => ({
            id: o.id,
            perMin: heard(n, o),
            quality: qOf(n, o),
          }));
    }
    this.gwNeighbors = nbs.get(this.gw.id).map((o) => [o.id, heard(this.gw, o), qOf(this.gw, o)]);
  }

  get isOpen() {
    return this.open;
  }

  start() {
    this.open = true;
    setTimeout(() => this.emit('open', 'SIMULATOR'), 50);
    this.timers = [
      setInterval(() => this.tick(), 100),
      setInterval(() => this.heartbeats(), 20_000), // same as the firmware
      setInterval(() => this.gwStatus(), 5_000),
      // Beacon of the bridge station (time + routing), reported like the firmware.
      setInterval(() => this.emitMsg({ t: 'air', d: 'tx', pt: P.PKT.BEACON, dst: 'all' }), 5_000),
      setInterval(() => this.chaos(), CHAOS_INTERVAL_MS),
      setInterval(() => this.fluctuateLinks(), 30_000),
      setInterval(() => this.computeTopology(), 10_000), // periodic route scan
    ];
    setTimeout(() => this.heartbeats(), 1500);
    const maxHops = Math.max(...this.nodes.map((n) => (n.dist === 255 ? 0 : n.dist)));
    const shops = this.nodes.filter((n) => n.role.points < 0).map((n) => n.role.name);
    const lookups = this.nodes.filter((n) => n.nodeType === 2).map((n) => n.role.name);
    this.log.info?.(
      `simulator: ${this.nodes.length} stations (up to ${maxHops} hops, shops: ${shops.join(', ')}, ` +
        `balance lookup: ${lookups.join(', ') || '–'}), ${this.cards.length} cards`,
    );
  }

  emitMsg(obj) {
    setImmediate(() => this.emit('message', obj));
  }

  write(obj) {
    switch (obj.t) {
      case 'hello':
        this.emitMsg({ t: 'hello', id: this.gwId, fw: 1, ql: this.upQueue.length });
        break;
      case 'ack':
        this.upQueue = this.upQueue.filter((m) => m.q !== obj.q);
        break;
      case 'send':
        this.deliver(obj);
        break;
      default:
        break;
    }
    return true;
  }

  deliver(obj) {
    const payload = Buffer.from(obj.p, 'hex');
    // Like the gateway firmware: report the transmission for the map.
    this.emitMsg({ t: 'air', d: 'tx', pt: obj.pt, dst: obj.dst === 'all' ? 'all' : obj.dst });
    if (obj.pt === P.PKT.GAME_CONFIG) this.relayoutFor(P.decodeGameConfig(payload).gameId);
    const targets = obj.dst === 'all' ? this.nodes : this.nodes.filter((n) => n.id === obj.dst);
    for (const n of targets) {
      // unreachable (offline itself or no route) or frame lost
      if (!this.reachable(n) || Math.random() < (n.flaky ? FLAKY_LOSS : NORMAL_LOSS)) continue;
      switch (obj.pt) {
        case P.PKT.GAME_CONFIG: {
          const cfg = P.decodeGameConfig(payload);
          if (!n.game || n.game.version !== cfg.version) {
            if (n.game && n.game.gameId !== cfg.gameId) n.cooldowns.clear();
            n.game = cfg;
            // Like the firmware: early (jittered) heartbeat = acknowledgement.
            this.heartbeatSoon(n, 1500);
          } else if (n.shouldReack(P.PKT.GAME_CONFIG, cfg.version)) {
            this.heartbeatSoon(n, 1500); // repeated config: our ack was lost
          }
          break;
        }
        case P.PKT.NODE_CONFIG: {
          const cfg = P.decodeNodeConfig(payload);
          if (!n.nodeCfg || n.nodeCfg.version !== cfg.version) {
            n.nodeCfg = cfg;
            this.heartbeatSoon(n, 500);
          } else if (n.shouldReack(P.PKT.NODE_CONFIG, cfg.version)) {
            this.heartbeatSoon(n, 1500);
          }
          break;
        }
        case P.PKT.ADJ_CHUNK:
          n.onAdjChunk(P.decodeAdjChunk(payload));
          break;
        case P.PKT.CMD:
          this.emit('debug', `# sim node ${n.id.toString(16)}: command ${payload[0]}`);
          break;
        default:
          break;
      }
    }
  }

  // Picks a station and a card for the next scan. Scans also happen at
  // offline stations (they buffer). Shops are visited regularly, partly by
  // players who cannot afford the price.
  pickTap() {
    const pick = (list) => list[rand(list.length)];
    const shops = this.nodes.filter((n) => n.points() < 0);
    const others = this.nodes.filter((n) => n.points() >= 0);
    if (shops.length && (Math.random() < SHOP_VISIT_SHARE || !others.length)) {
      const shop = pick(shops);
      const price = -shop.points();
      const balance = (c) => (c.rec && c.rec.gameId === shop.game?.gameId ? c.rec.points : 0);
      const broke = this.cards.filter((c) => balance(c) < price);
      const rich = this.cards.filter((c) => balance(c) >= price);
      const wantBroke = Math.random() < BROKE_SHOP_SHARE;
      const pool = (wantBroke ? broke : rich).length ? (wantBroke ? broke : rich) : this.cards;
      return [shop, pick(pool)];
    }
    return [pick(others), pick(this.cards)];
  }

  tick() {
    // Random scans.
    if (Math.random() < 100 / this.tapIntervalMs) {
      const [node, card] = this.pickTap();
      node.tap(card);
      this.saveCardsSoon();
    }
    // Reachable nodes hand their queue to the gateway (gateway persists +
    // ACKs). Badly connected stations get through only now and then.
    // Sometimes the ACK is lost: the station keeps the message and sends it
    // again later; the gateway recognises the duplicate and ACKs again.
    const now = Date.now();
    const acked = new Set();
    for (const n of this.nodes) {
      if (!this.reachable(n) || now < (n.retryAt || 0)) continue;
      if (n.flaky && Math.random() > 0.04) continue;
      while (n.queue.length) {
        const p = n.queue[0];
        if (n.gwHas?.has(p)) {
          this.emitMsg({ t: 'air', d: 'rx', pt: P.PKT.RELIABLE, node: n.id, dup: 1 });
        } else {
          this.upQueue.push({ q: this.nextQ++, node: n.id, p: p.toString('hex'), lastSent: 0 });
        }
        acked.add(n.id); // the gateway transmits an ACK either way
        if (Math.random() < (n.flaky ? ACK_LOSS_FLAKY : ACK_LOSS)) {
          (n.gwHas ??= new WeakSet()).add(p);
          n.retryAt = now + 2000 + rand(3000); // station's retry backoff
          break;
        }
        n.queue.shift();
      }
    }
    if (acked.size) this.emitMsg({ t: 'air', d: 'tx', pt: P.PKT.ACK, dst: 'all', n: [...acked] });
    // Gateway forwards to the PC until ACKed.
    for (const m of this.upQueue.slice(0, 8)) {
      if (now - m.lastSent > 1500) {
        m.lastSent = now;
        this.emitMsg({ t: 'msg', q: m.q, node: m.node, p: m.p });
      }
    }
  }

  heartbeats() {
    for (const n of this.nodes) this.sendHeartbeat(n);
  }

  heartbeatSoon(n, jitterMs) {
    setTimeout(() => this.sendHeartbeat(n), 300 + Math.random() * jitterMs);
  }

  sendHeartbeat(n) {
    if (!this.reachable(n)) return;
    if (n.flaky && Math.random() < FLAKY_HB_LOSS) return; // heartbeat lost
    this.emitMsg({ t: 'rx', node: n.id, pt: P.PKT.HEARTBEAT, hops: n.dist - 1, p: n.heartbeat().toString('hex') });
  }

  gwStatus() {
    this.emitMsg({
      t: 'gw',
      id: this.gwId,
      fw: 1,
      ql: this.upQueue.length,
      up: Math.floor(process.uptime()),
      epoch: Math.floor(Date.now() / 1000),
      nb: this.gwNeighbors,
    });
  }

  // Station outages (checked every 3 min, 35 % chance, one at a time):
  // mostly short (20-45 s, below the 60 s offline limit - only visible as
  // buffered transactions), rarely long (90-180 s, shown as offline; about
  // one per hour). A failing relay also cuts off the stations behind it
  // unless they have another route.
  chaos() {
    if (Math.random() >= CHAOS_CHANCE) return;
    if (this.nodes.some((n) => !n.online)) return;
    const candidates = this.nodes.filter((n) => n.online);
    if (!candidates.length) return;
    const n = candidates[rand(candidates.length)];
    const seconds = Math.random() < CHAOS_LONG_SHARE ? 90 + rand(91) : 20 + rand(26);
    n.online = false;
    this.computeTopology();
    const cutOff = this.nodes.filter((o) => o.online && o.dist === 255).map((o) => o.role.name);
    this.emit(
      'debug',
      `# sim: ${n.role.name} offline for ${seconds} s${cutOff.length ? ` (also cut off: ${cutOff.join(', ')})` : ''}`,
    );
    setTimeout(() => {
      n.online = true;
      this.computeTopology();
      this.emit('debug', `# sim: ${n.role.name} back online (${n.queue.length} queued)`);
    }, seconds * 1000);
  }
}
