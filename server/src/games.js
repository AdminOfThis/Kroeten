// Manages the saved games: create, load (continue), rename, copy, delete.
//
// Exactly one game is "current": it is connected to the gateway and receives
// heartbeats and dashboard edits. Other games stay on disk; they are opened in
// the background to show their leaderboard or to file late transactions from
// nodes that were offline when the game was switched.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getSetting, openDatabase } from './db.js';
import { EVENT_KIND, Game, httpError } from './game.js';
import { Library } from './library.js';
import * as P from './protocol.js';

const NULL_BRIDGE = { connected: false, sendFrame() {}, send() { return false; } };
const FORWARDED_EVENTS = ['tx', 'players', 'nodes', 'settings'];

export class GameManager extends EventEmitter {
  // nodeDefaults(nodeId): optional preset for newly registered stations
  // ({ name, typeConfig }) - used by the simulator.
  constructor({ dataDir, bridge, log = console, legacyDbFile = null, nodeDefaults = null }) {
    super();
    this.nodeDefaults = nodeDefaults;
    this.bridge = bridge;
    this.log = log;
    this.lib = new Library(dataDir);
    this.background = new Map(); // gameId -> Game
    this.forwarders = [];

    if (this.lib.isEmpty()) {
      if (legacyDbFile && fs.existsSync(legacyDbFile)) this.importLegacy(legacyDbFile);
      else this.createInitialGame();
    }
    let id = this.lib.currentId();
    if (!id || !this.lib.get(id)) id = this.lib.list()[0].id;
    this.attach(id, this.openGameFile(id, bridge));
    this.lib.setCurrent(id);
    // Never continue a running game unattended after a (re)start: pause it,
    // it is resumed in the dashboard. (Loading a game pauses it as well, see
    // Game.resumeWithEpoch.)
    if (this.game.settings().state === P.GAME_STATE.RUNNING) {
      this.game.updateSettings({ state: P.GAME_STATE.PAUSED }, { reason: 'Server gestartet' });
      log.info?.('game was running - paused after server start');
    }
  }

  get current() {
    return this.game;
  }

  currentInfo() {
    return { ...this.lib.get(this.currentId), current: true };
  }

  // ---------------------------------------------------------------------------

  openGameFile(id, bridge) {
    const info = this.lib.get(id);
    if (!info) throw httpError(404, 'Spiel nicht gefunden');
    return this.makeGame(info, bridge);
  }

  makeGame(info, bridge) {
    const g = new Game(openDatabase(this.lib.filePath(info)), bridge, this.log);
    g.nodeDefaults = this.nodeDefaults;
    return g;
  }

  // Game instance for any saved game (current or background).
  gameById(id) {
    if (id === this.currentId) return this.game;
    let g = this.background.get(id);
    if (!g) {
      g = this.openGameFile(id, NULL_BRIDGE);
      this.background.set(id, g);
    }
    return g;
  }

  attach(id, game) {
    if (this.game) {
      for (const [ev, fn] of this.forwarders) this.game.off(ev, fn);
      this.game.bridge = NULL_BRIDGE;
      this.background.set(this.currentId, this.game);
    }
    this.background.delete(id);
    game.bridge = this.bridge;
    this.game = game;
    this.currentId = id;
    this.forwarders = FORWARDED_EVENTS.map((ev) => [ev, (...a) => this.emit(ev, ...a)]);
    for (const [ev, fn] of this.forwarders) game.on(ev, fn);
  }

  switchTo(id, game) {
    this.attach(id, game);
    this.lib.setCurrent(id);
    this.log.info?.(`active game: "${this.lib.get(id).name}" (card epoch ${game.settings().gameId})`);
    for (const ev of ['settings', 'players', 'nodes', 'games']) this.emit(ev);
    game.broadcastGameConfig();
    game.broadcastAdjustments();
  }

  pauseCurrent() {
    if (this.game && this.game.settings().state === P.GAME_STATE.RUNNING) {
      this.game.updateSettings({ state: P.GAME_STATE.PAUSED });
    }
  }

  createInitialGame() {
    const info = this.lib.create('Spiel 1');
    const g = this.makeGame(info, NULL_BRIDGE);
    g.initFrom(null, { epoch: this.lib.allocateEpoch(info.id) });
    g.db.close();
  }

  // Imports a database from the single-game version of the server.
  importLegacy(file) {
    const info = this.lib.create('Importiertes Spiel');
    const src = new DatabaseSync(file);
    src.exec(`VACUUM INTO '${this.lib.filePath(info).replace(/'/g, "''")}'`);
    const epoch = getSetting(src, 'game', { gameId: 1 }).gameId;
    src.close();
    this.lib.reserveEpoch(epoch, info.id);
    // The original file is left untouched (it may still be open elsewhere);
    // the library is no longer empty, so it is never imported twice.
    this.log.info?.(`imported ${file} as "${info.name}" (original file kept, can be deleted)`);
  }

  // ---------------------------------------------------------------------------
  // Public operations
  // ---------------------------------------------------------------------------

  list() {
    return this.lib.list().map((info) => {
      let summary = null;
      try {
        summary = this.gameById(info.id).summary();
      } catch (err) {
        this.log.warn?.(`cannot open game ${info.id}: ${err.message}`);
      }
      return { ...info, current: info.id === this.currentId, summary };
    });
  }

  // New game: teams, stations and settings are taken over, players are not
  // (they register again with their first scan).
  create({ name }) {
    const clean = cleanName(name) || `Spiel ${this.lib.list().length + 1}`;
    this.pauseCurrent();
    const info = this.lib.create(clean);
    const g = this.makeGame(info, NULL_BRIDGE);
    g.initFrom(this.game, { epoch: this.lib.allocateEpoch(info.id) });
    this.switchTo(info.id, g);
    return this.currentInfo();
  }

  load(id) {
    if (id === this.currentId) throw httpError(400, 'Dieses Spiel ist bereits geladen');
    const target = this.gameById(id);
    this.pauseCurrent();
    target.copyNodesFrom(this.game.db);
    target.resumeWithEpoch(this.lib.allocateEpoch(id));
    this.switchTo(id, target);
    return this.currentInfo();
  }

  // Snapshot of the current game under a new name ("Speichern unter").
  saveCopy(name) {
    const clean = cleanName(name) || `${this.lib.get(this.currentId).name} (Kopie)`;
    const info = this.lib.create(clean);
    this.game.db.exec(`VACUUM INTO '${this.lib.filePath(info).replace(/'/g, "''")}'`);
    this.game.logManual(EVENT_KIND.GAME_COPY, `Kopie gespeichert als „${clean}“`);
    this.emit('games');
    return info;
  }

  rename(id, name) {
    const clean = cleanName(name);
    if (!clean) throw httpError(400, 'Name darf nicht leer sein');
    const info = this.lib.get(id);
    if (!info) throw httpError(404, 'Spiel nicht gefunden');
    this.lib.rename(id, clean);
    if (clean !== info.name) {
      this.gameById(id).logManual(EVENT_KIND.GAME_RENAMED, `Spiel umbenannt: „${info.name}“ → „${clean}“`);
    }
    this.emit('games');
  }

  remove(id) {
    if (id === this.currentId) throw httpError(400, 'Das geladene Spiel kann nicht gelöscht werden');
    const info = this.lib.get(id);
    if (!info) throw httpError(404, 'Spiel nicht gefunden');
    const g = this.background.get(id);
    if (g) {
      g.db.close();
      this.background.delete(id);
    }
    this.lib.remove(id);
    const file = this.lib.filePath(info);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    this.emit('games');
  }

  leaderboardOf(id) {
    const g = this.gameById(id);
    // leaderboard().teams contains id, name, color, members and points
    return { game: { ...this.lib.get(id), summary: g.summary() }, ...g.leaderboard() };
  }

  // Routes reliable messages to the game that owns the card epoch, so late
  // transactions of an offline node land in the right game.
  ingestReliable(nodeId, buf) {
    let epoch;
    try {
      const rel = P.decodeRel(buf);
      if (rel.msgType === P.MSG.TX) epoch = P.decodeTx(rel.body).gameId;
    } catch {
      // let the current game report the decode error
    }
    if (epoch !== undefined && epoch !== this.game.settings().gameId) {
      const owner = this.lib.gameForEpoch(epoch);
      if (owner !== null && owner !== this.currentId && this.lib.get(owner)) {
        this.gameById(owner).ingestReliable(nodeId, buf);
        this.emit('games');
        return;
      }
    }
    this.game.ingestReliable(nodeId, buf);
  }

  close() {
    for (const g of this.background.values()) g.db.close();
    this.game?.db.close();
    this.lib.close();
  }
}

function cleanName(name) {
  return String(name ?? '').trim().slice(0, 60);
}
