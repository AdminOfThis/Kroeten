// SQLite storage (node:sqlite, built into Node >= 22.13).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Team id = index stored on the card (0..15)
CREATE TABLE IF NOT EXISTS teams (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  uid          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  team_id      INTEGER,
  notes        TEXT NOT NULL DEFAULT '',
  points       INTEGER NOT NULL DEFAULT 0,  -- last known balance on the card
  card_counter INTEGER NOT NULL DEFAULT 0,  -- card write counter of that balance
  adj_seq      INTEGER NOT NULL DEFAULT 0,  -- highest correction applied on the card
  tap_count    INTEGER NOT NULL DEFAULT 0,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  last_node    INTEGER
);

CREATE TABLE IF NOT EXISTS nodes (
  node_id        INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  node_type      INTEGER NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  cooldown_sec   INTEGER,                    -- NULL = game default
  type_config    TEXT NOT NULL DEFAULT '{}',
  config_version INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT '{}', -- last heartbeat
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER
);

CREATE TABLE IF NOT EXISTS transactions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id        INTEGER NOT NULL,
  stream         INTEGER NOT NULL,
  seq            INTEGER NOT NULL,
  game_id        INTEGER NOT NULL,
  uid            TEXT NOT NULL,
  kind           INTEGER NOT NULL,
  result         INTEGER NOT NULL,
  flags          INTEGER NOT NULL,
  node_type      INTEGER NOT NULL,
  delta          INTEGER NOT NULL,
  adj_delta      INTEGER NOT NULL,
  adj_seq        INTEGER NOT NULL,
  balance_before INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL,
  card_counter   INTEGER NOT NULL,
  team           INTEGER,
  node_time      INTEGER,          -- node wall clock (unix s), NULL if unknown
  received_at    INTEGER NOT NULL, -- server time (unix ms)
  note           TEXT,             -- JSON details of game events (kind >= 100)
  UNIQUE (node_id, stream, seq)
);
CREATE INDEX IF NOT EXISTS idx_tx_uid ON transactions(uid);
CREATE INDEX IF NOT EXISTS idx_tx_game ON transactions(game_id, id);

-- Pending / applied point corrections and team assignments
CREATE TABLE IF NOT EXISTS adjustments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id      INTEGER NOT NULL,
  uid          TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  delta        INTEGER NOT NULL,
  team_id      INTEGER,
  kind         INTEGER NOT NULL DEFAULT 0, -- 0 manual, 1 team assignment, 2 restore after loading
  reason       TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  applied_at   INTEGER,
  applied_node INTEGER,
  UNIQUE (game_id, uid, seq)
);
CREATE INDEX IF NOT EXISTS idx_adj_pending ON adjustments(game_id, applied_at);
`;

export function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = FULL;'); // durability before we ACK to the gateway
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Schema upgrades for databases created by older versions.
function migrate(db) {
  const txCols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  if (!txCols.includes('note')) db.exec('ALTER TABLE transactions ADD COLUMN note TEXT');

  const adjCols = db.prepare('PRAGMA table_info(adjustments)').all().map((c) => c.name);
  if (!adjCols.includes('kind')) {
    db.exec('ALTER TABLE adjustments ADD COLUMN kind INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE adjustments SET kind = 1 WHERE team_id IS NOT NULL AND delta = 0');
  }
}

// Runs fn inside a transaction (node:sqlite has no helper for this).
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}
