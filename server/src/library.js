// Library of saved games. Every game lives in its own SQLite file under
// <dataDir>/games/; this registry stores names, files and which card epoch
// belongs to which game.
//
// Card epoch: the 16-bit "gameId" written on the cards. A new epoch is
// allocated every time a game is created or loaded, so cards scanned in
// another game in the meantime are reset and get their saved balance restored.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  file           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER
);
CREATE TABLE IF NOT EXISTS epochs (
  epoch      INTEGER PRIMARY KEY,
  game_id    INTEGER NOT NULL,
  started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class Library {
  constructor(dataDir) {
    this.dir = dataDir;
    fs.mkdirSync(path.join(dataDir, 'games'), { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'library.db'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec(SCHEMA);
  }

  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  list() {
    return this.db.prepare('SELECT * FROM games ORDER BY COALESCE(last_opened_at, created_at) DESC').all();
  }

  get(id) {
    return this.db.prepare('SELECT * FROM games WHERE id = ?').get(id) || null;
  }

  isEmpty() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM games').get().n === 0;
  }

  create(name) {
    const now = Date.now();
    const r = this.db.prepare('INSERT INTO games (name, file, created_at) VALUES (?, ?, ?)').run(name, '', now);
    const id = Number(r.lastInsertRowid);
    const file = path.join('games', `game-${id}.db`);
    this.db.prepare('UPDATE games SET file = ? WHERE id = ?').run(file, id);
    return this.get(id);
  }

  filePath(game) {
    return path.join(this.dir, game.file);
  }

  rename(id, name) {
    this.db.prepare('UPDATE games SET name = ? WHERE id = ?').run(name, id);
  }

  remove(id) {
    this.db.prepare('DELETE FROM games WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM epochs WHERE game_id = ?').run(id);
  }

  currentId() {
    return this.getMeta('current', null);
  }

  setCurrent(id) {
    this.setMeta('current', id);
    this.db.prepare('UPDATE games SET last_opened_at = ? WHERE id = ?').run(Date.now(), id);
  }

  // Ensures future epochs are greater than `epoch` (used when importing).
  reserveEpoch(epoch, gameId) {
    if (epoch > this.getMeta('epoch', 0)) this.setMeta('epoch', epoch);
    this.db
      .prepare('INSERT OR REPLACE INTO epochs (epoch, game_id, started_at) VALUES (?, ?, ?)')
      .run(epoch, gameId, Date.now());
  }

  allocateEpoch(gameId) {
    const next = (this.getMeta('epoch', 0) % 0xffff) + 1;
    this.setMeta('epoch', next);
    this.db
      .prepare('INSERT OR REPLACE INTO epochs (epoch, game_id, started_at) VALUES (?, ?, ?)')
      .run(next, gameId, Date.now());
    return next;
  }

  gameForEpoch(epoch) {
    return this.db.prepare('SELECT game_id FROM epochs WHERE epoch = ?').get(epoch)?.game_id ?? null;
  }

  close() {
    this.db.close();
  }
}
