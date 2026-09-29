import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_CONFIG, databasePath, normalizeConfig, validateConfigPatch } from "./config.mjs";

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

      CREATE TABLE IF NOT EXISTS provider_snapshots (
        provider TEXT PRIMARY KEY,
        observed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_quota_windows (
        provider TEXT NOT NULL,
        window_key TEXT NOT NULL,
        PRIMARY KEY (provider, window_key)
      );

      CREATE TABLE IF NOT EXISTS context_observations (
        provider TEXT NOT NULL,
        session_key TEXT NOT NULL,
        context_percent REAL NOT NULL,
        observed_at INTEGER NOT NULL,
        model TEXT,
        effort TEXT,
        source TEXT NOT NULL,
        PRIMARY KEY (provider, session_key, observed_at)
      );
      CREATE INDEX IF NOT EXISTS context_observations_latest
        ON context_observations(provider, session_key, observed_at DESC);

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

      CREATE TABLE IF NOT EXISTS alert_state (
        provider TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        window_key TEXT,
        observed_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notice_state (
        provider TEXT NOT NULL,
        surface TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, surface)
      );

      CREATE TABLE IF NOT EXISTS model_stepping_state (
        provider TEXT PRIMARY KEY,
        metadata TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS model_steps_recent ON model_steps(created_at DESC);
    `);
    // Pre-stepping releases wrote their fixed true default on every config change.
    // Once upgraded, an explicit qualityLock=true remains authoritative.
    this.database.exec(`
      BEGIN IMMEDIATE;
      UPDATE config SET value = 'false' WHERE key = 'qualityLock'
        AND NOT EXISTS (SELECT 1 FROM config WHERE key = 'modelStepping');
      INSERT OR IGNORE INTO config(key, value) VALUES ('modelStepping', 'true');
      COMMIT;
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
      if (snapshot.authoritativeWindows) {
        const head = this.database.prepare("SELECT observed_at FROM provider_snapshots WHERE provider = ?").get(snapshot.provider);
        if (!head || snapshot.observedAt >= head.observed_at) {
          this.database.prepare("DELETE FROM active_quota_windows WHERE provider = ?").run(snapshot.provider);
          const activate = this.database.prepare("INSERT OR IGNORE INTO active_quota_windows(provider, window_key) VALUES (?, ?)");
          for (const window of snapshot.windows) if (Number.isFinite(window.usedPercent)) activate.run(snapshot.provider, window.key);
          this.database.prepare(`
            INSERT INTO provider_snapshots(provider, observed_at) VALUES (?, ?)
            ON CONFLICT(provider) DO UPDATE SET observed_at = excluded.observed_at
          `).run(snapshot.provider, snapshot.observedAt);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  saveContextObservation(snapshot) {
    if (!snapshot?.provider || !Number.isFinite(snapshot.contextPercent)) {
      throw new TypeError("A provider context observation is required.");
    }
    const insert = this.database.prepare(`
      INSERT OR REPLACE INTO context_observations (
        provider, session_key, context_percent, observed_at, model, effort, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      snapshot.provider,
      sessionKey(snapshot.sessionId),
      Math.max(0, Math.min(100, snapshot.contextPercent)),
      snapshot.observedAt,
      snapshot.model || null,
      snapshot.effort || null,
      snapshot.source || "unknown",
    );
  }

  latestContext(provider, requestedSessionId = null) {
    if (!provider) throw new TypeError("A provider is required.");
    if (requestedSessionId != null) {
      const row = this.database.prepare(`
        SELECT * FROM context_observations
        WHERE provider = ? AND session_key = ?
        ORDER BY observed_at DESC LIMIT 1
      `).get(provider, sessionKey(requestedSessionId));
      return row ? mapContextObservation(row) : null;
    }
    const row = this.database.prepare(`
      SELECT * FROM context_observations
      WHERE provider = ?
      ORDER BY observed_at DESC LIMIT 1
    `).get(provider);
    return row ? mapContextObservation(row) : null;
  }

  latest(provider = null) {
    const where = provider ? "q.provider = ? AND" : "";
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
      WHERE ${where} (
        NOT EXISTS (SELECT 1 FROM provider_snapshots s WHERE s.provider = q.provider)
        OR EXISTS (SELECT 1 FROM active_quota_windows a WHERE a.provider = q.provider AND a.window_key = q.window_key)
      )
      ORDER BY q.provider, COALESCE(q.window_minutes, 999999), q.window_key
    `);
    return (provider ? statement.all(provider) : statement.all()).map(mapObservation);
  }

  latestFutureReset(provider, windowKey, now = Date.now(), source = null) {
    if (!provider || !windowKey) {
      throw new TypeError("A provider and window key are required.");
    }
    const sourceClause = source ? "AND source = ?" : "";
    const statement = this.database.prepare(`
      SELECT * FROM quota_observations
      WHERE provider = ? AND window_key = ?
        AND resets_at IS NOT NULL AND resets_at > ?
        ${sourceClause}
      ORDER BY observed_at DESC LIMIT 1
    `);
    const row = source
      ? statement.get(provider, windowKey, now, source)
      : statement.get(provider, windowKey, now);
    return row ? mapObservation(row) : null;
  }

  history(provider, windowKey, resetAt, since) {
    if (resetAt == null) {
      return this.database.prepare(`
        SELECT * FROM quota_observations
        WHERE provider = ? AND window_key = ? AND observed_at >= ?
        ORDER BY observed_at ASC
      `).all(provider, windowKey, since).map(mapObservation);
    }
    const statement = this.database.prepare(`
      SELECT * FROM quota_observations
      WHERE provider = ? AND window_key = ? AND observed_at >= ?
        AND resets_at = ?
      ORDER BY observed_at ASC
    `);
    return statement
      .all(provider, windowKey, since, resetAt)
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

  recentDecisions(limit = 12, includeModelSteps = false) {
    const statement = this.database.prepare(`
      SELECT provider, state, action, reason, task_class, reset_at, created_at
      FROM decisions ORDER BY created_at DESC LIMIT ?
    `);
    const decisions = statement.all(Math.max(1, Math.min(100, Math.round(limit)))).map((row) => ({
      provider: row.provider,
      state: row.state,
      action: row.action,
      reason: row.reason,
      taskClass: row.task_class,
      resetAt: numberOrNull(row.reset_at),
      createdAt: Number(row.created_at),
    }));
    // Keep a dedicated tail of model changes even after a busy night of hooks.
    return includeModelSteps
      ? [...decisions, ...this.recentModelSteps(limit)].sort((a, b) => b.createdAt - a.createdAt)
      : decisions;
  }

  updateModelStepping(provider, evaluate) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT metadata FROM model_stepping_state WHERE provider = ?").get(provider);
      const { state, transition, recommendation } = evaluate(row ? JSON.parse(row.metadata) : null);
      this.database.prepare(`
        INSERT INTO model_stepping_state(provider, metadata) VALUES (?, ?)
        ON CONFLICT(provider) DO UPDATE SET metadata = excluded.metadata
      `).run(provider, JSON.stringify(state));
      if (transition) this.database.prepare(`
        INSERT INTO model_steps(provider, created_at, metadata) VALUES (?, ?, ?)
      `).run(provider, transition.createdAt, JSON.stringify(transition));
      this.database.exec("COMMIT");
      return recommendation;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recentModelSteps(limit = 10) {
    return this.database.prepare(`
      SELECT metadata FROM model_steps ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(Math.max(1, Math.min(100, Math.round(limit)))).map((row) => JSON.parse(row.metadata));
  }

  modelStepCounts(since) {
    return this.database.prepare(`
      SELECT json_extract(metadata, '$.direction') AS direction, COUNT(*) AS count
      FROM model_steps WHERE created_at >= ? GROUP BY direction
    `).all(since);
  }

  getAlertState(provider) {
    const row = this.database.prepare(`
      SELECT provider, state, window_key, observed_at, updated_at
      FROM alert_state WHERE provider = ?
    `).get(provider);
    if (!row) return null;
    return {
      provider: row.provider,
      state: row.state,
      windowKey: row.window_key,
      observedAt: numberOrNull(row.observed_at),
      updatedAt: Number(row.updated_at),
    };
  }

  setAlertState(provider, state, options = {}) {
    this.database.prepare(`
      INSERT INTO alert_state(provider, state, window_key, observed_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        state = excluded.state,
        window_key = excluded.window_key,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at
    `).run(
      provider,
      state,
      options.windowKey || null,
      integerOrNull(options.observedAt),
      options.updatedAt ?? Date.now(),
    );
    return this.getAlertState(provider);
  }

  getNoticeState(provider, surface) {
    const row = this.database.prepare(`
      SELECT provider, surface, state, updated_at
      FROM notice_state WHERE provider = ? AND surface = ?
    `).get(provider, surface);
    if (!row) return null;
    return {
      provider: row.provider,
      surface: row.surface,
      state: row.state,
      updatedAt: Number(row.updated_at),
    };
  }

  setNoticeState(provider, surface, state, updatedAt = Date.now()) {
    this.database.prepare(`
      INSERT INTO notice_state(provider, surface, state, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider, surface) DO UPDATE SET
        state = excluded.state,
        updated_at = excluded.updated_at
    `).run(provider, surface, state, updatedAt);
    return this.getNoticeState(provider, surface);
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
    validateConfigPatch(patch);
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
    this.database.exec(
      "DELETE FROM quota_observations; DELETE FROM provider_snapshots; DELETE FROM active_quota_windows; DELETE FROM context_observations; DELETE FROM decisions; DELETE FROM alert_state; DELETE FROM notice_state; DELETE FROM model_stepping_state; DELETE FROM model_steps;",
    );
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

function mapContextObservation(row) {
  return {
    provider: row.provider,
    sessionId: row.session_key === "__provider__" ? null : row.session_key,
    contextPercent: Number(row.context_percent),
    observedAt: Number(row.observed_at),
    model: row.model,
    effort: row.effort,
    source: row.source,
  };
}

function sessionKey(value) {
  if (value == null || value === "") return "__provider__";
  return String(value).slice(0, 256);
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
