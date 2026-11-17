// Game logic: ingests node messages into the DB and keeps all nodes in sync
// with the current game settings, node configs and pending corrections.
import { EventEmitter } from 'node:events';

import { getSetting, setSetting, transaction } from './db.js';
import * as P from './protocol.js';
import { defaultTypeConfig, nodeTypeInfo, sanitizeTypeConfig } from './nodeTypes.js';

const DEFAULT_SETTINGS = {
  gameId: 1,
  version: 1,
  state: P.GAME_STATE.SETUP,
  brightness: 80,
  defaultCooldownSec: 10,
  buzzer: true,
  volume: 70,
  lookupCost: 5, // points per balance lookup (Kontostand-Station)
};

const DEFAULT_TEAMS = [
  { id: 0, name: 'Rot', color: '#e53935' },
  { id: 1, name: 'Blau', color: '#1e88e5' },
  { id: 2, name: 'Grün', color: '#43a047' },
  { id: 3, name: 'Gelb', color: '#fdd835' },
];

// adjustments.kind
export const ADJ_KIND = { MANUAL: 0, TEAM: 1, RESTORE: 2 };

// Game events are stored in the transaction log (node_id 0, kind >= 100) so
// they appear in the same chronological list as the card transactions.
//   100-109: game events (shown in the normal log)
//   110+   : manual dashboard changes (audit log, only shown with their filter;
//            stored on the server only, never sent to the stations)
export const EVENT_KIND = {
  STATE: 100,
  LOADED: 101,
  CREATED: 102,
  NODE_OFFLINE: 103,
  NODE_ONLINE: 104,
  BRIDGE_CONNECTED: 105,
  BRIDGE_DISCONNECTED: 106,
  FLASHED: 107,
  NODE_STATE: 108, // a station reports a new game state (acknowledgement)
  STATE_CONFIRMED: 109, // all stations online at the change have acknowledged it
  PLAYER: 110,
  ADJUST: 111,
  NODE: 112,
  SETTINGS: 113,
  TEAMS: 114,
  NODE_REMOVED: 115,
  GAME_RENAMED: 116,
  NODE_COMMAND: 117,
  GAME_COPY: 118,
};
const FIRST_EVENT_KIND = 100;
const GAME_STATE_LABELS = { 0: 'Vorbereitung', 1: 'Läuft', 2: 'Pausiert', 3: 'Beendet' };
const FIRST_MANUAL_KIND = 110;

const NODE_ONLINE_MS = 60_000;
export const STALE_NODE_MS = 5 * 60_000; // "veraltet": no heartbeat for 5 minutes
// Re-send schedule for config the stations have not acknowledged yet (their
// heartbeat still reports an older version): quick retries first - an
// acknowledgement normally arrives within ~2 s - then slower, so a station
// that is really gone does not flood the radio. Per config version.
const RESEND_SCHEDULE_MS = [2_500, 2_500, 4_000, 6_000, 8_000];
const resendDelay = (sent) => RESEND_SCHEDULE_MS[Math.min(Math.max(0, sent - 1), RESEND_SCHEDULE_MS.length - 1)];

// Bookkeeping of one config item: how often the current version was sent.
function noteSent(track, key) {
  if (track.key !== key) {
    track.key = key;
    track.sent = 0;
  }
  track.sent++;
  track.at = Date.now();
}
const resendDue = (track, key, now) => track.key !== key || now - track.at > resendDelay(track.sent);
const AUTO_ADJ_BROADCAST_MS = 15_000; // bundling of automatic team assignments
const TIME_RESEND_MS = 30_000;

const nextVersion = (v, max = 0xffff) => (v % max) + 1;
const hexId = (id) => (id >>> 0).toString(16).padStart(8, '0').toUpperCase();

export class Game extends EventEmitter {
  constructor(db, bridge, log = console) {
    super();
    this.db = db;
    this.bridge = bridge;
    this.log = log;
    this.gameSend = { key: null, sent: 0, at: 0 }; // see noteSent()
    this.adjSend = { key: null, sent: 0, at: 0 };
    this.lastTimeSent = 0;
    this.nodeCfgSent = new Map(); // nodeId -> { key, sent, at }
    this.stateChange = null; // pending game state acknowledgement, see trackStateChange()

    if (!getSetting(db, 'game', null)) setSetting(db, 'game', DEFAULT_SETTINGS);
    if (getSetting(db, 'adjVersion', null) === null) setSetting(db, 'adjVersion', 1);
    if (db.prepare('SELECT COUNT(*) AS n FROM teams').get().n === 0) {
      const ins = db.prepare('INSERT INTO teams (id, name, color) VALUES (?, ?, ?)');
      for (const t of DEFAULT_TEAMS) ins.run(t.id, t.name, t.color);
    }
    this.prepare();
    // The cooldown used to be settable per station; it is a game setting now.
    // Clear old overrides and bump the config version so stations get it.
    db.exec('UPDATE nodes SET cooldown_sec = NULL, config_version = (config_version % 65535) + 1 WHERE cooldown_sec IS NOT NULL');
    // Older databases may contain players without a team.
    if (this.db.prepare('SELECT 1 FROM players WHERE team_id IS NULL LIMIT 1').get()) {
      transaction(db, () => this.assignMissingTeams());
    }
  }

  prepare() {
    const db = this.db;
    this.q = {
      insertTx: db.prepare(`INSERT OR IGNORE INTO transactions
        (node_id, stream, seq, game_id, uid, kind, result, flags, node_type, delta, adj_delta, adj_seq,
         balance_before, balance_after, card_counter, team, node_time, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      getPlayer: db.prepare('SELECT * FROM players WHERE uid = ?'),
      insertPlayer: db.prepare(`INSERT INTO players (uid, name, first_seen, last_seen) VALUES (?, ?, ?, ?)`),
      touchPlayer: db.prepare('UPDATE players SET last_seen = ?, last_node = ? WHERE uid = ?'),
      updateBalance: db.prepare('UPDATE players SET points = ?, card_counter = ?, adj_seq = MAX(adj_seq, ?) WHERE uid = ?'),
      incTaps: db.prepare('UPDATE players SET tap_count = tap_count + 1 WHERE uid = ?'),
      markApplied: db.prepare(`UPDATE adjustments SET applied_at = ?, applied_node = ?
        WHERE game_id = ? AND uid = ? AND seq <= ? AND applied_at IS NULL`),
      pendingForBroadcast: db.prepare(`SELECT uid, seq, delta, team_id FROM adjustments
        WHERE game_id = ? AND applied_at IS NULL ORDER BY uid, seq`),
      // Restore corrections are already contained in players.points.
      pendingSum: db.prepare(`SELECT COALESCE(SUM(delta), 0) AS sum FROM adjustments
        WHERE game_id = ? AND uid = ? AND applied_at IS NULL AND kind != ${ADJ_KIND.RESTORE}`),
      maxAdjSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM adjustments WHERE game_id = ? AND uid = ?'),
      insertAdj: db.prepare(`INSERT INTO adjustments (game_id, uid, seq, delta, team_id, kind, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      teamSizes: db.prepare(`SELECT t.id, COUNT(p.uid) AS n FROM teams t
        LEFT JOIN players p ON p.team_id = t.id GROUP BY t.id`),
      getNode: db.prepare('SELECT * FROM nodes WHERE node_id = ?'),
      insertNode: db.prepare(`INSERT INTO nodes (node_id, name, node_type, type_config, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?)`),
      updateNodeStatus: db.prepare('UPDATE nodes SET status = ?, last_seen = ? WHERE node_id = ?'),
      touchNode: db.prepare('UPDATE nodes SET last_seen = ? WHERE node_id = ?'),
      getTx: db.prepare(`SELECT t.*, p.name AS player_name, p.team_id AS player_team, n.name AS node_name
        FROM transactions t LEFT JOIN players p ON p.uid = t.uid LEFT JOIN nodes n ON n.node_id = t.node_id
        WHERE t.id = ?`),
    };
  }

  // ---------------------------------------------------------------------------
  // Settings & teams
  // ---------------------------------------------------------------------------

  settings() {
    return { ...DEFAULT_SETTINGS, ...getSetting(this.db, 'game', DEFAULT_SETTINGS) };
  }

  adjVersion() {
    return getSetting(this.db, 'adjVersion', 1);
  }

  // The correction list version embeds the card epoch, so versions never
  // collide between games (a node holding list v1 of another game must not
  // look "in sync").
  bumpAdjVersion() {
    const epoch = this.settings().gameId & 0xffff;
    const v = this.adjVersion();
    const low = (v >>> 16) === epoch ? ((v & 0xffff) % 0xffff) + 1 : 1;
    setSetting(this.db, 'adjVersion', ((epoch << 16) | low) >>> 0);
  }

  teams() {
    return this.db.prepare('SELECT * FROM teams ORDER BY id').all();
  }

  // Appends a game event to the transaction log and pushes it to the dashboard.
  logEvent(kind, note) {
    const seq = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM transactions WHERE node_id = 0 AND stream = 0')
      .get().s;
    const r = this.db
      .prepare(
        `INSERT INTO transactions (node_id, stream, seq, game_id, uid, kind, result, flags, node_type, delta, adj_delta,
           adj_seq, balance_before, balance_after, card_counter, team, node_time, received_at, note)
         VALUES (0, 0, ?, ?, '', ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, ?)`,
      )
      .run(seq, this.settings().gameId, kind, Date.now(), JSON.stringify(note ?? {}));
    this.emit('tx', this.q.getTx.get(Number(r.lastInsertRowid)));
  }

  // Audit entry for a change made in the dashboard (German text for the log).
  logManual(kind, text, data = {}) {
    this.logEvent(kind, { text, ...data });
  }

  // meta: extra fields for the state change log entry (e.g. { reason }).
  updateSettings(patch, meta = {}) {
    const s = this.settings();
    const previousState = s.state;
    const before = { ...s };
    if (patch.state !== undefined) {
      const st = Number(patch.state);
      if (!Object.values(P.GAME_STATE).includes(st)) throw httpError(400, 'Ungültiger Spielstatus');
      // "Vorbereitung" is one-way: once the game has started it cannot go back
      // (team editing is only allowed before the start).
      if (st === P.GAME_STATE.SETUP && s.state !== P.GAME_STATE.SETUP) {
        throw httpError(409, 'Zurück zur Vorbereitung ist nach Spielbeginn nicht möglich');
      }
      s.state = st;
    }
    if (patch.brightness !== undefined) s.brightness = clamp(patch.brightness, 5, 255);
    if (patch.defaultCooldownSec !== undefined) s.defaultCooldownSec = clamp(patch.defaultCooldownSec, 0, 65000);
    if (patch.buzzer !== undefined) s.buzzer = Boolean(patch.buzzer);
    if (patch.volume !== undefined) s.volume = clamp(patch.volume, 0, 100);
    if (patch.lookupCost !== undefined) s.lookupCost = clamp(patch.lookupCost, 0, 30000);
    s.version = nextVersion(s.version);
    setSetting(this.db, 'game', s);
    if (s.state !== previousState) {
      this.logEvent(EVENT_KIND.STATE, { from: previousState, to: s.state, ...meta });
      this.trackStateChange();
    }
    const changes = [];
    if (s.defaultCooldownSec !== before.defaultCooldownSec) changes.push(`Abklingzeit ${before.defaultCooldownSec} → ${s.defaultCooldownSec} s`);
    if (s.volume !== before.volume) changes.push(`Lautstärke ${before.volume} → ${s.volume} %`);
    if (s.brightness !== before.brightness) changes.push(`LED-Helligkeit ${before.brightness} → ${s.brightness}`);
    if (s.buzzer !== before.buzzer) changes.push(`Summer ${s.buzzer ? 'an' : 'aus'}`);
    if (s.lookupCost !== before.lookupCost) changes.push(`Kosten Kontoabfrage ${before.lookupCost ?? 0} → ${s.lookupCost} Punkte`);
    if (changes.length) this.logManual(EVENT_KIND.SETTINGS, `Node-Einstellungen geändert: ${changes.join(', ')}`);
    this.emit('settings');
    this.broadcastGameConfig();
    return s;
  }

  setTeams(list) {
    if (this.settings().state !== P.GAME_STATE.SETUP) {
      throw httpError(409, 'Teams können nur im Status „Vorbereitung“ bearbeitet werden');
    }
    if (!Array.isArray(list) || list.length < 1 || list.length > P.MAX_TEAMS) {
      throw httpError(400, `Es sind 1 bis ${P.MAX_TEAMS} Teams erlaubt`);
    }
    const beforeTeams = this.teams();
    transaction(this.db, () => {
      this.db.exec('DELETE FROM teams');
      const ins = this.db.prepare('INSERT INTO teams (id, name, color) VALUES (?, ?, ?)');
      list.forEach((t, i) => {
        const name = String(t.name || '').trim() || `Team ${i + 1}`;
        const color = /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#ffffff';
        ins.run(i, name.slice(0, 40), color);
      });
      this.db.prepare('UPDATE players SET team_id = NULL WHERE team_id >= ?').run(list.length);
      this.assignMissingTeams();
      const s = this.settings();
      s.version = nextVersion(s.version);
      setSetting(this.db, 'game', s);
    });
    const describe = (teams) => teams.map((t) => `${t.name} (${t.color})`).join(', ');
    if (describe(beforeTeams) !== describe(this.teams())) {
      this.logManual(EVENT_KIND.TEAMS, `Teams geändert: ${describe(beforeTeams)} → ${describe(this.teams())}`);
    }
    this.emit('settings');
    this.emit('players');
    this.broadcastGameConfig();
    this.broadcastAdjustments();
  }

  // ---------------------------------------------------------------------------
  // Game lifecycle (called by GameManager)
  // ---------------------------------------------------------------------------

  // Initialises a freshly created game file from the previously active game.
  initFrom(source, { epoch }) {
    transaction(this.db, () => {
      const src = source ? source.settings() : DEFAULT_SETTINGS;
      setSetting(this.db, 'game', {
        ...DEFAULT_SETTINGS,
        defaultCooldownSec: src.defaultCooldownSec,
        brightness: src.brightness,
        buzzer: src.buzzer,
        volume: src.volume,
        lookupCost: src.lookupCost ?? DEFAULT_SETTINGS.lookupCost,
        gameId: epoch,
        version: nextVersion(src.version),
        state: P.GAME_STATE.SETUP,
      });
      if (source) {
        this.db.exec('DELETE FROM teams');
        const insTeam = this.db.prepare('INSERT INTO teams (id, name, color) VALUES (?, ?, ?)');
        for (const t of source.teams()) insTeam.run(t.id, t.name, t.color);
        this.copyNodesFrom(source.db);
      }
      this.assignMissingTeams();
      // Cards start blank: write every team assignment again.
      for (const p of this.db.prepare('SELECT uid, team_id FROM players WHERE team_id IS NOT NULL').all()) {
        if (!this.db.prepare('SELECT 1 FROM adjustments WHERE game_id = ? AND uid = ?').get(epoch, p.uid)) {
          this.addAdjustment(p.uid, 0, p.team_id, 'Teamzuordnung (neues Spiel)', ADJ_KIND.TEAM);
        }
      }
      this.bumpAdjVersion();
    });
    this.logEvent(EVENT_KIND.CREATED, { to: P.GAME_STATE.SETUP });
    this.trackStateChange();
  }

  // Continues a saved game under a new card epoch. Cards are treated as blank
  // in the new epoch; each player's saved balance and team are written back on
  // the first scan via a restore correction.
  resumeWithEpoch(epoch) {
    const before = this.settings().state;
    transaction(this.db, () => {
      const s = this.settings();
      s.gameId = epoch;
      s.version = nextVersion(s.version);
      if (s.state === P.GAME_STATE.RUNNING) s.state = P.GAME_STATE.PAUSED;
      setSetting(this.db, 'game', s);
      this.db.exec('UPDATE players SET card_counter = 0, adj_seq = 0');
      const now = Date.now();
      for (const p of this.db.prepare('SELECT uid, points, team_id FROM players').all()) {
        if (p.points <= 0 && p.team_id === null) continue;
        this.q.insertAdj.run(epoch, p.uid, 1, Math.max(0, p.points), p.team_id, ADJ_KIND.RESTORE, 'Spielstand wiederhergestellt', now);
      }
      this.assignMissingTeams(); // after the restore entries (they use seq 1)
      this.bumpAdjVersion();
    });
    this.logEvent(EVENT_KIND.LOADED, { from: before, to: this.settings().state });
    this.trackStateChange();
  }

  // Station configuration describes the hardware, so it follows the active game.
  copyNodesFrom(srcDb) {
    const ins = this.db.prepare(`INSERT OR REPLACE INTO nodes
      (node_id, name, node_type, enabled, cooldown_sec, type_config, config_version, status, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const n of srcDb.prepare('SELECT * FROM nodes').all()) {
      ins.run(n.node_id, n.name, n.node_type, n.enabled, n.cooldown_sec, n.type_config, n.config_version, n.status,
        n.first_seen, n.last_seen);
    }
  }

  // Key figures for the monitoring page.
  stats() {
    const tx = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN result = 0 THEN 1 ELSE 0 END), 0) AS ok,
           COALESCE(SUM(CASE WHEN received_at > ? THEN 1 ELSE 0 END), 0) AS recent
         FROM transactions WHERE kind < ${FIRST_EVENT_KIND}`,
      )
      .get(Date.now() - 5 * 60_000);
    const p = this.db.prepare('SELECT COUNT(*) AS players, COALESCE(SUM(points), 0) AS points FROM players').get();
    return { transactions: tx.total, ok: tx.ok, last5min: tx.recent, players: p.players, points: p.points };
  }

  summary() {
    const s = this.settings();
    const stats = this.db
      .prepare('SELECT COUNT(*) AS players, COALESCE(SUM(points), 0) AS points FROM players')
      .get();
    const tx = this.db.prepare('SELECT COUNT(*) AS n, MAX(received_at) AS last FROM transactions').get();
    return {
      state: s.state,
      epoch: s.gameId,
      players: stats.players,
      points: stats.points,
      teams: this.db.prepare('SELECT COUNT(*) AS n FROM teams').get().n,
      transactions: tx.n,
      lastActivity: tx.last,
    };
  }

  // ---------------------------------------------------------------------------
  // Automatic team assignment: every player always belongs to a team.
  // ---------------------------------------------------------------------------

  // Team with the fewest players; random among ties.
  pickTeam() {
    const sizes = this.q.teamSizes.all();
    if (!sizes.length) return null;
    const min = Math.min(...sizes.map((t) => t.n));
    const candidates = sizes.filter((t) => t.n === min);
    return candidates[Math.floor(Math.random() * candidates.length)].id;
  }

  // Must run inside a transaction. Returns number of players assigned.
  assignMissingTeams() {
    let n = 0;
    for (const p of this.db.prepare('SELECT uid FROM players WHERE team_id IS NULL ORDER BY first_seen').all()) {
      const team = this.pickTeam();
      if (team === null) break;
      this.db.prepare('UPDATE players SET team_id = ? WHERE uid = ?').run(team, p.uid);
      this.addAdjustment(p.uid, 0, team, 'Automatische Teamzuordnung', ADJ_KIND.TEAM);
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // Players
  // ---------------------------------------------------------------------------

  listPlayers() {
    const gameId = this.settings().gameId;
    return this.db
      .prepare(
        `SELECT p.*, t.name AS team_name, t.color AS team_color,
           (SELECT COALESCE(SUM(delta), 0) FROM adjustments a
             WHERE a.game_id = ? AND a.uid = p.uid AND a.applied_at IS NULL AND a.kind = ${ADJ_KIND.MANUAL}) AS pending_delta,
           (SELECT COUNT(*) FROM adjustments a
             WHERE a.game_id = ? AND a.uid = p.uid AND a.applied_at IS NULL AND a.kind = ${ADJ_KIND.MANUAL}) AS pending_count
         FROM players p LEFT JOIN teams t ON t.id = p.team_id
         ORDER BY p.points DESC, p.name`,
      )
      .all(gameId, gameId);
  }

  playerDetail(uid) {
    const player = this.listPlayers().find((p) => p.uid === uid);
    if (!player) throw httpError(404, 'Spieler nicht gefunden');
    const gameId = this.settings().gameId;
    const adjustments = this.db
      .prepare('SELECT * FROM adjustments WHERE game_id = ? AND uid = ? ORDER BY seq DESC')
      .all(gameId, uid);
    // Name changes (dashboard only, never written to the card) from the audit log.
    const nameChanges = this.db
      .prepare(`SELECT received_at, note FROM transactions WHERE node_id = 0 AND kind = ? AND json_extract(note, '$.uid') = ?
                ORDER BY id DESC`)
      .all(EVENT_KIND.PLAYER, uid)
      .map((r) => {
        const n = JSON.parse(r.note || '{}');
        // Older entries only have the text.
        const m = n.nameFrom === undefined ? /Name „(.*?)“ → „(.*?)“/.exec(n.text || '') : null;
        const from = n.nameFrom ?? m?.[1];
        const to = n.nameTo ?? m?.[2];
        return from === undefined ? null : { at: r.received_at, from, to };
      })
      .filter(Boolean);
    return { player, adjustments, nameChanges };
  }

  updatePlayer(uid, patch) {
    let teamChanged = false;
    const changes = [];
    let playerName = '';
    let nameChange = null;
    transaction(this.db, () => {
      const p = this.q.getPlayer.get(uid);
      if (!p) throw httpError(404, 'Spieler nicht gefunden');
      playerName = p.name;
      if (patch.name !== undefined) {
        const name = String(patch.name).trim().slice(0, 60);
        if (!name) throw httpError(400, 'Name darf nicht leer sein');
        this.db.prepare('UPDATE players SET name = ? WHERE uid = ?').run(name, uid);
        if (name !== p.name) {
          changes.push(`Name „${p.name}“ → „${name}“`);
          nameChange = { nameFrom: p.name, nameTo: name };
          playerName = name;
        }
      }
      if (patch.notes !== undefined) {
        const notes = String(patch.notes).slice(0, 500);
        this.db.prepare('UPDATE players SET notes = ? WHERE uid = ?').run(notes, uid);
        if (notes !== p.notes) changes.push(notes ? `Notizen „${notes}“` : 'Notizen gelöscht');
      }
      if (patch.teamId !== undefined) {
        const teamId = patch.teamId === null || patch.teamId === '' ? null : Number(patch.teamId);
        if (teamId === null) throw httpError(400, 'Jeder Spieler muss einem Team angehören');
        if (!this.db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) {
          throw httpError(400, 'Unbekanntes Team');
        }
        if (teamId !== p.team_id) {
          this.db.prepare('UPDATE players SET team_id = ? WHERE uid = ?').run(teamId, uid);
          this.addAdjustment(uid, 0, teamId, 'Teamzuordnung', ADJ_KIND.TEAM);
          teamChanged = true;
          const teamName = (id) => this.db.prepare('SELECT name FROM teams WHERE id = ?').get(id)?.name ?? '–';
          changes.push(`Team ${teamName(p.team_id)} → ${teamName(teamId)}`);
        }
      }
    });
    if (changes.length) {
      this.logManual(EVENT_KIND.PLAYER, `Spieler „${playerName}“ bearbeitet: ${changes.join(', ')}`, { uid, ...nameChange });
    }
    this.emit('players');
    if (teamChanged) this.broadcastAdjustments();
  }

  // delta or setTo (absolute target balance incl. pending corrections)
  adjustPlayer(uid, { delta, setTo, reason }) {
    let created = false;
    let text = '';
    transaction(this.db, () => {
      const p = this.q.getPlayer.get(uid);
      if (!p) throw httpError(404, 'Spieler nicht gefunden');
      const gameId = this.settings().gameId;
      let d;
      let target = null;
      if (setTo !== undefined && setTo !== null && setTo !== '') {
        target = Math.max(0, Number.parseInt(setTo, 10));
        if (Number.isNaN(target)) throw httpError(400, 'Ungültiger Zielwert');
        const pending = this.q.pendingSum.get(gameId, uid).sum;
        d = target - (p.points + pending);
      } else {
        d = Number.parseInt(delta, 10);
        if (Number.isNaN(d)) throw httpError(400, 'Ungültige Punkteänderung');
      }
      if (d === 0) return;
      if (Math.abs(d) > 1_000_000) throw httpError(400, 'Punkteänderung zu groß');
      const why = String(reason || '').slice(0, 200);
      this.addAdjustment(uid, d, null, why);
      created = true;
      const signed = d > 0 ? `+${d}` : `${d}`;
      text = target !== null
        ? `Punkte von „${p.name}“ auf ${target} gesetzt (Korrektur ${signed})`
        : `Punktekorrektur für „${p.name}“: ${signed}`;
      if (why) text += ` – Grund: ${why}`;
    });
    if (created) {
      this.logManual(EVENT_KIND.ADJUST, text, { uid });
      this.emit('players');
      this.broadcastAdjustments();
    }
  }

  // Must run inside a transaction.
  addAdjustment(uid, delta, teamId, reason, kind = ADJ_KIND.MANUAL) {
    const gameId = this.settings().gameId;
    const p = this.q.getPlayer.get(uid);
    const seq = Math.max(this.q.maxAdjSeq.get(gameId, uid).seq, p ? p.adj_seq : 0) + 1;
    if (seq > 0xffff) throw httpError(400, 'Zu viele Korrekturen für diesen Spieler');
    this.q.insertAdj.run(gameId, uid, seq, delta, teamId, kind, reason, Date.now());
    this.bumpAdjVersion();
  }

  leaderboard() {
    const players = this.listPlayers().map((p) => ({
      uid: p.uid,
      name: p.name,
      points: p.points,
      teamId: p.team_id,
      teamName: p.team_name,
      teamColor: p.team_color,
      pendingDelta: p.pending_delta,
      tapCount: p.tap_count,
    }));
    const teams = this.db
      .prepare(
        `SELECT t.id, t.name, t.color, COUNT(p.uid) AS members, COALESCE(SUM(p.points), 0) AS points
         FROM teams t LEFT JOIN players p ON p.team_id = t.id
         GROUP BY t.id ORDER BY points DESC, t.id`,
      )
      .all();
    return { players, teams };
  }

  // ---------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------

  // All transactions of this game file (including earlier card epochs, i.e.
  // before the game was saved and loaded again).
  listTransactions({ limit = 200, beforeId, uid, nodeId, result } = {}) {
    const where = [];
    const args = [];
    if (beforeId) {
      where.push('t.id < ?');
      args.push(Number(beforeId));
    }
    if (uid) {
      where.push('t.uid = ?');
      args.push(uid);
    }
    if (nodeId !== undefined && nodeId !== '') {
      where.push('t.node_id = ?');
      args.push(Number(nodeId));
    }
    if (result === 'event') {
      where.push(`t.kind >= ${FIRST_EVENT_KIND} AND t.kind < ${FIRST_MANUAL_KIND}`);
    } else if (result === 'manual') {
      where.push(`t.kind >= ${FIRST_MANUAL_KIND}`);
    } else if (result !== undefined && result !== '') {
      where.push(`t.result = ? AND t.kind < ${FIRST_EVENT_KIND}`);
      args.push(Number(result));
    } else {
      // Manual changes (audit log) only appear with their own filter.
      where.push(`t.kind < ${FIRST_MANUAL_KIND}`);
    }
    const sql = `SELECT t.*, p.name AS player_name, p.team_id AS player_team, n.name AS node_name
      FROM transactions t LEFT JOIN players p ON p.uid = t.uid LEFT JOIN nodes n ON n.node_id = t.node_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.id DESC LIMIT ?`;
    args.push(Math.min(Math.max(Number(limit) || 200, 1), 2000));
    return this.db.prepare(sql).all(...args);
  }

  // Called for every reliable message forwarded by the gateway. Returns once
  // the data is committed - only then may the gateway delete it.
  ingestReliable(nodeId, buf) {
    const rel = P.decodeRel(buf);
    if (rel.msgType !== P.MSG.TX) {
      this.log.warn?.(`unknown reliable message type ${rel.msgType} from ${hexId(nodeId)}`);
      return;
    }
    const tx = P.decodeTx(rel.body);
    const now = Date.now();
    let txId = null;
    let adjChanged = false;

    transaction(this.db, () => {
      this.ensureNode(nodeId, tx.nodeType, now);
      const r = this.q.insertTx.run(
        nodeId,
        rel.stream,
        rel.seq,
        tx.gameId,
        tx.uid,
        tx.kind,
        tx.result,
        tx.flags,
        tx.nodeType,
        tx.delta,
        tx.adjDelta,
        tx.adjSeq,
        tx.balanceBefore,
        tx.balanceAfter,
        tx.cardCounter,
        tx.team === P.TEAM_NONE ? null : tx.team,
        tx.flags & P.TX_FLAGS.HAS_TIME ? tx.epoch : null,
        now,
      );
      if (r.changes === 0) return; // duplicate (retransmission)
      txId = Number(r.lastInsertRowid);

      let player = this.q.getPlayer.get(tx.uid);
      if (!player) {
        this.q.insertPlayer.run(tx.uid, `Spieler ${tx.uid.slice(-4)}`, now, now);
        if (this.assignMissingTeams() > 0) adjChanged = true; // team colour reaches the card on the next scan
        player = this.q.getPlayer.get(tx.uid);
      }
      this.q.touchPlayer.run(now, nodeId, tx.uid);

      const s = this.settings();
      const cardChanged = tx.result !== P.TX_RESULT.WRITE_FAILED && tx.result !== P.TX_RESULT.NODE_OUTDATED;
      if (tx.gameId === s.gameId && cardChanged) {
        // The card is the source of truth: the newest card state wins, even if
        // messages from an offline node arrive late.
        if (tx.cardCounter >= player.card_counter) {
          this.q.updateBalance.run(tx.balanceAfter, tx.cardCounter, tx.adjSeq, tx.uid);
        }
        if (tx.result === P.TX_RESULT.OK) this.q.incTaps.run(tx.uid);
        // Applied corrections are only marked; the version is not bumped, so
        // nodes keep their list (stale entries are harmless: a card only takes
        // seq numbers above the one it stores). This avoids re-broadcasting
        // the whole list on every scan, e.g. after loading a saved game.
        // The list shrinks with the next real change.
        if (tx.adjSeq > 0) this.q.markApplied.run(now, nodeId, s.gameId, tx.uid, tx.adjSeq);
      }
    });

    if (txId !== null) {
      this.emit('tx', this.q.getTx.get(txId));
      this.emit('players');
    }
    // New players got an automatic team: not urgent, bundle these broadcasts.
    if (adjChanged) this.scheduleAdjBroadcast(AUTO_ADJ_BROADCAST_MS);
  }

  // ---------------------------------------------------------------------------
  // Nodes
  // ---------------------------------------------------------------------------

  ensureNode(nodeId, nodeType, now) {
    const n = this.q.getNode.get(nodeId);
    const defaultName = `Station ${hexId(nodeId).slice(-4)}`;
    // Optional preset for new stations (used by the simulator: names, shops).
    const preset = this.nodeDefaults?.(nodeId) ?? null;
    const presetConfig = () => JSON.stringify(sanitizeTypeConfig(nodeType, preset.typeConfig));
    if (!n) {
      this.q.insertNode.run(
        nodeId,
        preset?.name ?? defaultName,
        nodeType,
        preset ? presetConfig() : JSON.stringify(defaultTypeConfig(nodeType)),
        now,
        now,
      );
      this.emit('nodes');
      return;
    }
    if (preset && n.config_version === 1 && n.name === defaultName) {
      // Station was never configured by hand: apply the preset.
      this.db
        .prepare('UPDATE nodes SET name = ?, type_config = ?, config_version = 2 WHERE node_id = ?')
        .run(preset.name, presetConfig(), nodeId);
      this.emit('nodes');
    }
    if (n.node_type !== nodeType && nodeType !== 0) {
      // Device was flashed with another node type: reset its type config.
      this.db
        .prepare('UPDATE nodes SET node_type = ?, type_config = ?, config_version = ? WHERE node_id = ?')
        .run(nodeType, JSON.stringify(defaultTypeConfig(nodeType)), nextVersion(n.config_version), nodeId);
    }
    this.q.touchNode.run(now, nodeId);
  }

  ingestHeartbeat(nodeId, hb, hops) {
    const now = Date.now();
    this.ensureNode(nodeId, hb.nodeType, now);
    const node = this.q.getNode.get(nodeId);
    const prev = JSON.parse(node.status || '{}');
    this.q.updateNodeStatus.run(JSON.stringify({ ...hb, hops, at: now }), now, nodeId);
    this.noteReportedState(node, prev, hb, now);
    this.emit('nodes');
    this.syncNodes();
  }

  // Remembers which stations (online right now) still have to acknowledge the
  // current game state; once all did, one summary event is logged.
  trackStateChange() {
    const now = Date.now();
    const s = this.settings();
    const pending = new Set();
    for (const n of this.db.prepare('SELECT node_id, status FROM nodes WHERE last_seen > ?').all(now - NODE_ONLINE_MS)) {
      const st = JSON.parse(n.status || '{}');
      if (st.gameState !== s.state || st.gameId !== s.gameId) pending.add(n.node_id);
    }
    this.stateChange = pending.size ? { state: s.state, gameId: s.gameId, at: now, total: pending.size, pending } : null;
  }

  // Game state acknowledgement: stations send an early heartbeat after they
  // applied a new game config; the heartbeat carries the state they now use.
  // Logged whenever the reported state of a station changes (not on the first
  // heartbeat of a station / after a firmware without this field).
  noteReportedState(node, prev, hb, now) {
    const gs = hb.gameState;
    if (gs === undefined || gs === P.GAME_STATE_NONE) return;
    const s = this.settings();
    if (hb.gameId !== s.gameId) return; // still on another game (card epoch)
    const known = prev.at !== undefined && prev.gameState !== undefined;
    if (!known || (prev.gameState === gs && prev.gameId === hb.gameId)) return;

    const label = GAME_STATE_LABELS[gs] ?? `Status ${gs}`;
    const sc = this.stateChange;
    const delay = sc && sc.state === gs && sc.gameId === hb.gameId ? Math.round((now - sc.at) / 1000) : null;
    const current = gs === s.state;
    this.logEvent(EVENT_KIND.NODE_STATE, {
      node: node.node_id,
      state: gs,
      text: `Station „${node.name}“ hat Spielstatus „${label}“ übernommen${delay !== null ? ` (nach ${delay} s)` : ''}` +
        `${current ? '' : ` – erwartet: „${GAME_STATE_LABELS[s.state]}“`}`,
    });
    if (sc && current && sc.state === gs && sc.pending.delete(node.node_id) && sc.pending.size === 0) {
      this.logEvent(EVENT_KIND.STATE_CONFIRMED, {
        state: gs,
        text: `Spielstatus „${label}“ von ${sc.total === 1 ? 'der Station' : `allen ${sc.total} Stationen`} bestätigt (nach ${delay} s)`,
      });
      this.stateChange = null;
    }
  }

  listNodes() {
    const now = Date.now();
    const s = this.settings();
    const adjVersion = this.adjVersion();
    return this.db
      .prepare('SELECT * FROM nodes ORDER BY name')
      .all()
      .map((n) => {
        const status = JSON.parse(n.status || '{}');
        const online = n.last_seen !== null && now - n.last_seen < NODE_ONLINE_MS;
        const hasStatus = status.at !== undefined;
        return {
          nodeId: n.node_id,
          hexId: hexId(n.node_id),
          name: n.name,
          nodeType: n.node_type,
          nodeTypeLabel: nodeTypeInfo(n.node_type)?.label ?? `Typ ${n.node_type}`,
          enabled: n.enabled === 1,
          typeConfig: JSON.parse(n.type_config || '{}'),
          configVersion: n.config_version,
          lastSeen: n.last_seen,
          online,
          status,
          inSync: hasStatus
            ? {
                game: status.gameCfgVer === s.version && status.gameId === s.gameId,
                node: status.nodeCfgVer === n.config_version,
                adj: status.adjVer === adjVersion,
              }
            : null,
        };
      });
  }

  updateNode(nodeId, patch) {
    const n = this.q.getNode.get(nodeId);
    if (!n) throw httpError(404, 'Station nicht gefunden');
    const name = patch.name !== undefined ? String(patch.name).trim().slice(0, 40) || n.name : n.name;
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : n.enabled;
    const typeConfig =
      patch.typeConfig !== undefined
        ? sanitizeTypeConfig(n.node_type, patch.typeConfig)
        : JSON.parse(n.type_config || '{}');
    this.db
      .prepare(
        `UPDATE nodes SET name = ?, enabled = ?, type_config = ?, config_version = ?
         WHERE node_id = ?`,
      )
      .run(name, enabled, JSON.stringify(typeConfig), nextVersion(n.config_version), nodeId);
    this.nodeCfgSent.delete(nodeId);

    // Audit log
    const changes = [];
    if (name !== n.name) changes.push(`Name „${n.name}“ → „${name}“`);
    if (enabled !== n.enabled) changes.push(enabled ? 'aktiviert' : 'deaktiviert');
    const oldCfg = JSON.parse(n.type_config || '{}');
    for (const f of nodeTypeInfo(n.node_type)?.fields || []) {
      if (oldCfg[f.key] !== typeConfig[f.key]) changes.push(`${f.label} ${oldCfg[f.key] ?? '–'} → ${typeConfig[f.key]}`);
    }
    if (changes.length) {
      this.logManual(EVENT_KIND.NODE, `Station „${name}“ bearbeitet: ${changes.join(', ')}`, { node: nodeId });
    }

    this.emit('nodes');
    this.sendNodeConfig(this.q.getNode.get(nodeId));
  }

  deleteNode(nodeId) {
    const n = this.q.getNode.get(nodeId);
    this.db.prepare('DELETE FROM nodes WHERE node_id = ?').run(nodeId);
    if (n) this.logManual(EVENT_KIND.NODE_REMOVED, `Station „${n.name}“ (${hexId(nodeId)}) entfernt`, { node: nodeId });
    this.emit('nodes');
  }

  // Removes stations that have not sent anything for `maxAgeMs` (or never did).
  // Their transactions stay in the log.
  removeStaleNodes(maxAgeMs = STALE_NODE_MS) {
    const cutoff = Date.now() - maxAgeMs;
    const stale = this.db.prepare('SELECT node_id, name FROM nodes WHERE last_seen IS NULL OR last_seen < ?').all(cutoff);
    const r = this.db.prepare('DELETE FROM nodes WHERE last_seen IS NULL OR last_seen < ?').run(cutoff);
    for (const id of [...this.nodeCfgSent.keys()]) {
      if (!this.q.getNode.get(id)) this.nodeCfgSent.delete(id);
    }
    if (r.changes > 0) {
      this.logManual(
        EVENT_KIND.NODE_REMOVED,
        `${stale.length} veraltete Station${stale.length === 1 ? '' : 'en'} entfernt: ${stale.map((n) => `„${n.name}“`).join(', ')}`,
      );
      this.emit('nodes');
    }
    return { removed: Number(r.changes) };
  }

  nodeCommand(nodeId, cmd) {
    const n = this.q.getNode.get(nodeId);
    if (!n) throw httpError(404, 'Station nicht gefunden');
    this.bridge.sendFrame(nodeId, P.PKT.CMD, P.encodeCmd(cmd));
    const label = cmd === P.CMD.REBOOT ? 'Neustart' : cmd === P.CMD.IDENTIFY ? 'Finden' : `Befehl ${cmd}`;
    this.logManual(EVENT_KIND.NODE_COMMAND, `${label} an Station „${n.name}“ gesendet`, { node: nodeId });
  }

  // ---------------------------------------------------------------------------
  // Sync with the mesh
  // ---------------------------------------------------------------------------

  broadcastGameConfig() {
    if (!this.bridge.connected) return;
    const s = this.settings();
    noteSent(this.gameSend, `${s.gameId}:${s.version}`);
    this.bridge.sendFrame('all', P.PKT.GAME_CONFIG, P.encodeGameConfig(s, this.teams()));
  }

  // Broadcast the correction list after `delayMs`, merging requests: an
  // earlier scheduled broadcast wins, so many changes cause one broadcast.
  scheduleAdjBroadcast(delayMs) {
    const due = Date.now() + delayMs;
    if (this.adjTimer && this.adjDue <= due) return;
    clearTimeout(this.adjTimer);
    this.adjDue = due;
    this.adjTimer = setTimeout(() => this.broadcastAdjustments(), delayMs);
    this.adjTimer.unref?.();
  }

  broadcastAdjustments() {
    clearTimeout(this.adjTimer);
    this.adjTimer = null;
    if (!this.bridge.connected) return;
    const gameId = this.settings().gameId;
    noteSent(this.adjSend, `${gameId}:${this.adjVersion()}`);
    const entries = this.q.pendingForBroadcast
      .all(gameId)
      .map((a) => ({ uid: a.uid, seq: a.seq, delta: a.delta, team: a.team_id }));
    for (const chunk of P.encodeAdjChunks(this.adjVersion(), gameId, entries)) {
      this.bridge.sendFrame('all', P.PKT.ADJ_CHUNK, chunk);
    }
  }

  sendNodeConfig(n) {
    if (!this.bridge.connected || !n) return;
    const info = nodeTypeInfo(n.node_type);
    const typeData = info ? info.encode(JSON.parse(n.type_config || '{}')) : Buffer.alloc(0);
    if (!this.nodeCfgSent.has(n.node_id)) this.nodeCfgSent.set(n.node_id, { key: null, sent: 0, at: 0 });
    noteSent(this.nodeCfgSent.get(n.node_id), n.config_version);
    this.bridge.sendFrame(
      n.node_id,
      P.PKT.NODE_CONFIG,
      P.encodeNodeConfig({
        version: n.config_version,
        nodeType: n.node_type,
        enabled: n.enabled === 1,
        cooldownSec: null, // the cooldown is a game setting for all stations
        name: n.name,
        typeData,
      }),
    );
  }

  sendTime() {
    if (!this.bridge.connected) return;
    this.lastTimeSent = Date.now();
    this.bridge.send({ t: 'time', epoch: Math.floor(Date.now() / 1000) });
  }

  onGatewayHello() {
    this.sendTime();
    this.broadcastGameConfig();
    this.broadcastAdjustments();
  }

  // Logs a game event when a station stops sending heartbeats (shown as
  // offline after NODE_ONLINE_MS) and when it is reachable again. Only while
  // the bridge node is connected - otherwise every station would "go offline"
  // because of one USB problem. The state is (re)initialised silently.
  checkNodeLiveness() {
    if (!this.bridge.connected) {
      this.liveness = null;
      return;
    }
    const now = Date.now();
    const init = !this.liveness;
    if (init) this.liveness = new Map();
    for (const n of this.db.prepare('SELECT node_id, name, last_seen FROM nodes').all()) {
      const online = n.last_seen !== null && now - n.last_seen < NODE_ONLINE_MS;
      const prev = this.liveness.get(n.node_id);
      if (!init && prev && prev.online !== online) {
        if (!online) {
          this.logEvent(EVENT_KIND.NODE_OFFLINE, {
            node: n.node_id,
            text: `Station „${n.name}“ scheint offline – kein Heartbeat seit ${Math.round(NODE_ONLINE_MS / 1000)} s`,
          });
        } else {
          const minutes = Math.max(1, Math.round((now - (prev.since ?? now)) / 60000));
          this.logEvent(EVENT_KIND.NODE_ONLINE, {
            node: n.node_id,
            text: `Station „${n.name}“ wieder erreichbar (etwa ${minutes} min offline)`,
          });
        }
      }
      const since = prev && prev.online === online ? prev.since : now;
      this.liveness.set(n.node_id, { online, since });
    }
  }

  // Compares what nodes report in their heartbeats with the desired state and
  // re-sends whatever is out of date (rate limited).
  syncNodes() {
    if (!this.bridge.connected) return;
    const now = Date.now();
    if (now - this.lastTimeSent > TIME_RESEND_MS) this.sendTime();

    const s = this.settings();
    const adjVersion = this.adjVersion();
    let gameStale = false;
    let adjStale = false;
    for (const n of this.db.prepare('SELECT * FROM nodes WHERE last_seen > ?').all(now - NODE_ONLINE_MS)) {
      const st = JSON.parse(n.status || '{}');
      if (st.at === undefined) continue;
      if (st.gameCfgVer !== s.version || st.gameId !== s.gameId) gameStale = true;
      if (st.adjVer !== adjVersion) adjStale = true;
      const track = this.nodeCfgSent.get(n.node_id);
      if (st.nodeCfgVer !== n.config_version && (!track || resendDue(track, n.config_version, now))) {
        this.sendNodeConfig(n);
      }
    }
    if (gameStale && resendDue(this.gameSend, `${s.gameId}:${s.version}`, now)) this.broadcastGameConfig();
    // A scheduled (bundled) broadcast is pending anyway - don't pre-empt it.
    if (adjStale && !this.adjTimer && resendDue(this.adjSend, `${s.gameId}:${adjVersion}`, now)) {
      this.broadcastAdjustments();
    }
  }
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function clamp(v, min, max) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw httpError(400, 'Ungültige Zahl');
  return Math.max(min, Math.min(max, n));
}
