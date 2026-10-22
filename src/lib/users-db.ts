/**
 * CHISMOSO V1.5 — Users DB (Task IMP-PROD-SEC, audit C-2)
 *
 * Stores operator user accounts (username + bcrypt-hashed password) for the
 * session-based auth added by `src/lib/auth.ts`. Lives in the chismoso SQLite
 * database alongside the mesh tables — uses a SEPARATE better-sqlite3
 * connection (we never touch `ChismosoDB` directly — that class is owned by
 * the foundation layer).
 *
 * Tables:
 *   chismoso_users  : { id, username (UNIQUE), password_hash, role, created_at,
 *                       csrf_token, csrf_issued_at }
 *
 * The `csrf_token` column is updated atomically on every login + token refresh.
 * It is paired with the JWT session so a CSRF token is bound to the session
 * that minted it (single-use rotation is overkill for an operator dashboard
 * — the JWT signature already binds the token; the column is here so a
 * future `chismoso users revoke` CLI can rotate CSRF material per-user).
 */

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomFillSync } from 'node:crypto';

export const USERS_DB_PATH =
  process.env.CHISMOSO_DB_PATH ?? '/home/z/my-project/chismoso/data/chismoso.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chismoso_users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'operator',
  csrf_token      TEXT,
  csrf_issued_at  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chismoso_users_username ON chismoso_users(username);
`;

// ---------------------------------------------------------------------------
// Singleton — survives HMR, never closed
// ---------------------------------------------------------------------------

mkdirSync(dirname(USERS_DB_PATH), { recursive: true });

const globalForUsersDb = globalThis as unknown as {
  __usersDb?: DB;
};

function createUsersDb(): DB {
  const db = new Database(USERS_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  // Override `close` so route handlers that follow the standard
  // `try { db = openUsersDb(); ... } finally { db.close(); }` pattern do NOT
  // kill the singleton.
  (db as unknown as { close: () => void }).close = () => {
    /* no-op — singleton lives for the process lifetime */
  };
  return db;
}

const usersDbSingleton: DB = globalForUsersDb.__usersDb ?? createUsersDb();

if (process.env.NODE_ENV !== 'production') {
  globalForUsersDb.__usersDb = usersDbSingleton;
}

export interface ChismosoUser {
  id: string;
  username: string;
  passwordHash: string;
  role: 'operator' | 'admin';
  csrfToken?: string | null;
  csrfIssuedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChismosoUserPublic {
  id: string;
  username: string;
  role: 'operator' | 'admin';
  createdAt: string;
}

export function openUsersDb(): DB {
  return usersDbSingleton;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function findUserByUsername(username: string): ChismosoUser | null {
  const row = usersDbSingleton
    .prepare(`SELECT * FROM chismoso_users WHERE username = ?`)
    .get(username) as
    | {
        id: string;
        username: string;
        password_hash: string;
        role: string;
        csrf_token: string | null;
        csrf_issued_at: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role === 'admin' ? 'admin' : 'operator',
    csrfToken: row.csrf_token ?? null,
    csrfIssuedAt: row.csrf_issued_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findUserById(id: string): ChismosoUser | null {
  const row = usersDbSingleton
    .prepare(`SELECT * FROM chismoso_users WHERE id = ?`)
    .get(id) as
    | {
        id: string;
        username: string;
        password_hash: string;
        role: string;
        csrf_token: string | null;
        csrf_issued_at: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role === 'admin' ? 'admin' : 'operator',
    csrfToken: row.csrf_token ?? null,
    csrfIssuedAt: row.csrf_issued_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listUsers(): ChismosoUserPublic[] {
  const rows = usersDbSingleton
    .prepare(
      `SELECT id, username, role, created_at FROM chismoso_users ORDER BY created_at ASC`,
    )
    .all() as Array<{ id: string; username: string; role: string; created_at: string }>;
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role === 'admin' ? 'admin' : 'operator',
    createdAt: r.created_at,
  }));
}

/**
 * Insert (or update) a user. Returns the persisted user id. Used by the
 * `chismoso users add` CLI command — never exposed via HTTP.
 */
export function upsertUser(
  username: string,
  passwordHash: string,
  role: 'operator' | 'admin' = 'operator',
): string {
  const now = new Date().toISOString();
  const id = `usr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  usersDbSingleton
    .prepare(
      `INSERT INTO chismoso_users (id, username, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         password_hash = excluded.password_hash,
         role = excluded.role,
         updated_at = excluded.updated_at`,
    )
    .run(id, username, passwordHash, role, now, now);
  return id;
}

/**
 * Atomically rotate the per-user CSRF token. Called on login and on token
 * refresh. Returns the new token so the caller can hand it to the client
 * in the response body (the cookie only carries the session JWT — the CSRF
 * token is deliberately readable by client JS so it can be echoed back
 * in the `X-CSRF-Token` header on mutations).
 */
export function rotateCsrfToken(userId: string): string {
  const token = generateCsrfToken();
  const now = new Date().toISOString();
  usersDbSingleton
    .prepare(
      `UPDATE chismoso_users SET csrf_token = ?, csrf_issued_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(token, now, now, userId);
  return token;
}

/**
 * Validate that the supplied CSRF token matches the most recent token
 * persisted for the user. Constant-time compare to avoid timing leaks.
 */
export function validateCsrfToken(userId: string, token: string | null | undefined): boolean {
  if (!token || token.length === 0) return false;
  const row = usersDbSingleton
    .prepare(`SELECT csrf_token FROM chismoso_users WHERE id = ?`)
    .get(userId) as { csrf_token: string | null } | undefined;
  if (!row || !row.csrf_token) return false;
  return safeEqual(token, row.csrf_token);
}

/**
 * Invalidate the current CSRF token. Called on logout so any residual
 * `X-CSRF-Token` on a logged-out browser is dead.
 */
export function clearCsrfToken(userId: string): void {
  const now = new Date().toISOString();
  usersDbSingleton
    .prepare(
      `UPDATE chismoso_users SET csrf_token = NULL, csrf_issued_at = NULL, updated_at = ? WHERE id = ?`,
    )
    .run(now, userId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateCsrfToken(): string {
  // 32 bytes of CSPRNG → URL-safe base64. We use `node:crypto.randomFillSync`
  // which is available in both Node 18+ and the Next.js runtime. Avoids the
  // subtle bias of Math.random.
  const bytes = new Uint8Array(32);
  randomFillSync(bytes);
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Constant-time string compare to avoid timing-side-channel leaks.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
