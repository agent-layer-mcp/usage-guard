import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_CONFIG, databasePath, normalizeConfig } from "./config.mjs";

export class GuardStore {
  constructor(options = {}) {
    const filename = options.filename || databasePath(options.env);
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.filename = filename;
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS quota_observations (
        provider TEXT NOT NULL,
        window_key TEXT NOT NULL,
        window_label TEXT NOT NULL,
        used_percent REAL NOT NULL,
        window_minutes REAL,
        resets_at INTEGER,
        observed_at INTEGER NOT NULL,
        model TEXT,
        effort TEXT,
        context_percent REAL,
        source TEXT NOT NULL,
        PRIMARY KEY (provider, window_key, observed_at)
      );
      CREATE INDEX IF NOT EXISTS quota_observations_latest
        ON quota_observations(provider, window_key, observed_at DESC);

      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        state TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        task_class TEXT NOT NULL,
        reset_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS decisions_recent
        ON decisions(created_at DESC);

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  saveSnapshot(snapshot) {
    if (!snapshot?.provider || !Array.isArray(snapshot.windows)) {
      throw new TypeError("A provider snapshot with windows is required.");
    }

    const insert = this.database.prepare(`
      INSERT OR REPLACE INTO quota_observations (
        provider, window_key, window_label, used_percent, window_minutes,
        resets_at, observed_at, model, effort, context_percent, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const window of snapshot.windows) {
        if (!Number.isFinite(window.usedPercent)) continue;
        insert.run(
          snapshot.provider,
          window.key,
          window.label,
          Math.max(0, Math.min(100, window.usedPercent)),
          finiteOrNull(window.windowMinutes),
          integerOrNull(window.resetsAt),
          snapshot.observedAt,
          snapshot.model || null,
          snapshot.effort || null,
          finiteOrNull(snapshot.contextPercent),
          snapshot.source || "unknown",
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  latest(provider = null) {
    const where = provider ? "WHERE q.provider = ?" : "";
    const statement = this.database.prepare(`
      SELECT q.*
      FROM quota_observations q
      JOIN (
        SELECT provider, window_key, MAX(observed_at) AS observed_at
        FROM quota_observations
        GROUP BY provider, window_key
      ) latest
      ON latest.provider = q.provider
      AND latest.window_key = q.window_key
      AND latest.observed_at = q.observed_at
      ${where}
      ORDER BY q.provider, COALESCE(q.window_minutes, 999999), q.window_key
    `);
    return (provider ? statement.all(provider) : statement.all()).map(mapObservation);
  }

  history(provider, windowKey, resetAt, since) {
    const statement = this.database.prepare(`
      SELECT * FROM quota_observations
      WHERE provider = ? AND window_key = ? AND observed_at >= ?
        AND (resets_at = ? OR (resets_at IS NULL AND ? IS NULL))
      ORDER BY observed_at ASC
    `);
    return statement
      .all(provider, windowKey, since, resetAt, resetAt)
      .map(mapObservation);
  }

  recordDecision(decision) {
    const insert = this.database.prepare(`
      INSERT INTO decisions (
        provider, state, action, reason, task_class, reset_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      decision.provider,
      decision.state,
      decision.action,
      decision.reason,
      decision.taskClass,
      integerOrNull(decision.resetAt),
      decision.createdAt,
    );
  }

  recentDecisions(limit = 12) {
    const statement = this.database.prepare(`
      SELECT provider, state, action, reason, task_class, reset_at, created_at
      FROM decisions ORDER BY created_at DESC LIMIT ?
    `);
    return statement.all(Math.max(1, Math.min(100, Math.round(limit)))).map((row) => ({
      provider: row.provider,
      state: row.state,
      action: row.action,
      reason: row.reason,
      taskClass: row.task_class,
      resetAt: numberOrNull(row.reset_at),
      createdAt: Number(row.created_at),
    }));
  }

  getConfig() {
    const rows = this.database.prepare("SELECT key, value FROM config").all();
    const stored = {};
    for (const row of rows) {
      try {
        stored[row.key] = JSON.parse(row.value);
      } catch {
        stored[row.key] = row.value;
      }
    }
    return normalizeConfig({ ...DEFAULT_CONFIG, ...stored });
  }

  setConfig(patch) {
    const next = normalizeConfig({ ...this.getConfig(), ...patch });
    const upsert = this.database.prepare(`
      INSERT INTO config(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of Object.entries(next)) {
        upsert.run(key, JSON.stringify(value));
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return next;
  }

  clear() {
    this.database.exec("DELETE FROM quota_observations; DELETE FROM decisions;");
  }

  close() {
    this.database.close();
  }
}

function mapObservation(row) {
  return {
    provider: row.provider,
    key: row.window_key,
    label: row.window_label,
    usedPercent: Number(row.used_percent),
    windowMinutes: numberOrNull(row.window_minutes),
    resetsAt: numberOrNull(row.resets_at),
    observedAt: Number(row.observed_at),
    model: row.model,
    effort: row.effort,
    contextPercent: numberOrNull(row.context_percent),
    source: row.source,
  };
}

function finiteOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function numberOrNull(value) {
  return value == null ? null : Number(value);
}
