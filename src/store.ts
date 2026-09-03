import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { log } from './log';

/**
 * Хранилище — один файл SQLite через встроенный в Node модуль `node:sqlite`.
 * Ни сервера БД, ни нативных сборок, ни зависимостей в package.json.
 * Нужно оно ровно для одного: помнить, какой топик принадлежит какому клиенту.
 */

export interface ClientRow {
  user_id: number;
  thread_id: number | null;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  language_code: string | null;
  phone: string | null;
  first_seen_at: number;
  last_seen_at: number;
  banned: number;
}

let db: any;

export function openStore(file = config.dbFile) {
  if (db) return;
  const dir = path.dirname(path.resolve(file));
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(path.resolve(file));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      user_id       INTEGER PRIMARY KEY,
      thread_id     INTEGER,
      first_name    TEXT,
      last_name     TEXT,
      username      TEXT,
      language_code TEXT,
      phone         TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL,
      banned        INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_thread ON clients (thread_id);

    CREATE TABLE IF NOT EXISTS seen_updates (
      update_id INTEGER PRIMARY KEY,
      at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_seen_at ON seen_updates (at);

    CREATE TABLE IF NOT EXISTS state (
      k TEXT PRIMARY KEY,
      v TEXT
    );
  `);

  log.info('Хранилище открыто', { file: path.resolve(file) });
}

export function closeStore() {
  if (db) {
    db.close();
    db = undefined;
  }
}

/* --------------------------------- клиенты --------------------------------- */

export function getClientByUserId(userId: number): ClientRow | undefined {
  return db.prepare('SELECT * FROM clients WHERE user_id = ?').get(userId) as ClientRow | undefined;
}

export function getClientByThreadId(threadId: number): ClientRow | undefined {
  return db.prepare('SELECT * FROM clients WHERE thread_id = ?').get(threadId) as
    | ClientRow
    | undefined;
}

export interface ClientInput {
  userId: number;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  languageCode?: string | null;
  phone?: string | null;
}

/** Создаёт клиента или обновляет его данные (имя и username могут меняться). */
export function upsertClient(input: ClientInput, now = Date.now()): ClientRow {
  db.prepare(
    `INSERT INTO clients
       (user_id, first_name, last_name, username, language_code, phone, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       first_name    = COALESCE(excluded.first_name, clients.first_name),
       last_name     = COALESCE(excluded.last_name, clients.last_name),
       username      = COALESCE(excluded.username, clients.username),
       language_code = COALESCE(excluded.language_code, clients.language_code),
       phone         = COALESCE(excluded.phone, clients.phone),
       last_seen_at  = excluded.last_seen_at`,
  ).run(
    input.userId,
    input.firstName ?? null,
    input.lastName ?? null,
    input.username ?? null,
    input.languageCode ?? null,
    input.phone ?? null,
    now,
    now,
  );
  return getClientByUserId(input.userId)!;
}

export function setThreadId(userId: number, threadId: number | null) {
  // старая привязка к тому же топику могла остаться от удалённого клиента
  if (threadId !== null) {
    db.prepare('UPDATE clients SET thread_id = NULL WHERE thread_id = ? AND user_id <> ?').run(
      threadId,
      userId,
    );
  }
  db.prepare('UPDATE clients SET thread_id = ? WHERE user_id = ?').run(threadId, userId);
}

export function setBanned(userId: number, banned: boolean) {
  db.prepare('UPDATE clients SET banned = ? WHERE user_id = ?').run(banned ? 1 : 0, userId);
}

export function countClients(): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM clients').get() as any).n);
}

/* ------------------------------ дедупликация ------------------------------- */

/**
 * true — апдейт новый и его надо обработать.
 * false — Telegram прислал его повторно (так бывает при таймауте вебхука).
 */
export function claimUpdate(updateId: number, now = Date.now()): boolean {
  const res = db
    .prepare('INSERT INTO seen_updates (update_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING')
    .run(updateId, now);
  return Number(res.changes ?? 0) > 0;
}

export function purgeOldUpdates(olderThanMs = 24 * 3600_000) {
  db.prepare('DELETE FROM seen_updates WHERE at < ?').run(Date.now() - olderThanMs);
}

/* ---------------------------------- state ---------------------------------- */

export function getState(key: string): string | null {
  const row = db.prepare('SELECT v FROM state WHERE k = ?').get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

export function setState(key: string, value: string) {
  db.prepare('INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(
    key,
    value,
  );
}
