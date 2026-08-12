'use strict';

/**
 * ObserveAdapter — adapter raw-SQL para @results/auth.
 *
 * Interface implementada:
 *   - findUserByUsername(username)   → SELECT icingaweb_user
 *   - verifyPassword(user, password) → pgcrypto crypt() (PostgreSQL nativo)
 *   - createSession(session)         → INSERT observe_sessions
 *   - findSession(token)             → SELECT observe_sessions por SHA-256
 *   - destroySession(token)          → DELETE observe_sessions por SHA-256
 *   - updateLastLogin(userId, now)   → (no-op: icingaweb_user não tem last_login)
 *   - updateLastActivity(token, now) → UPDATE observe_sessions last_seen_at
 * Tokens brutos nunca são persistidos, evitando que um vazamento do banco
 * permita reutilizar sessões.
 */

const { sessionHash } = require('@results/auth');

function isCurrentPasswordHash(hash) {
  const value = Buffer.isBuffer(hash) ? hash.toString('utf8') : String(hash || '');
  return /^\$2[abxy]\$12\$/.test(value);
}

class ObserveAdapter {
  /**
   * @param {object} db - { query(sql, params) → { rows, rowCount } }
   * @param {object} logger - { info, warn, error } (opcional)
   */
  constructor(db, logger) {
    this.db = db;
    this.logger = logger || { info: () => {}, warn: () => {}, error: () => {} };
  }

  // ── User lookup ────────────────────────────────────────────────────────────

  async findUserByUsername(username) {
    const r = await this.db.query(
      `SELECT "name" AS username, "active", "password_hash"
       FROM icingaweb_user
       WHERE lower("name") = lower($1::text)
       LIMIT 1`,
      [username]
    );
    if (!r.rowCount) return null;

    const row = r.rows[0];

    // Resolve role via IcingaWeb2 groups (mesma lógica do middleware antigo)
    let role = 'operator';
    try {
      const byId = await this.db.query(
        `SELECT 1
         FROM icingaweb_group_membership gm
         JOIN icingaweb_group g ON g.id = gm.group_id
         WHERE lower(g.name) = lower('Administrators')
           AND lower(gm.username) = lower($1::text)
         LIMIT 1`, [username]
      ).catch(() => ({ rowCount: 0 }));
      if (byId.rowCount) role = 'admin';
      if (role !== 'admin') {
        const byName = await this.db.query(
          `SELECT 1 FROM icingaweb_group_membership gm
           WHERE lower(gm.group_name) = lower('Administrators')
             AND lower(gm.username) = lower($1::text)
           LIMIT 1`, [username]
        ).catch(() => ({ rowCount: 0 }));
        if (byName.rowCount) role = 'admin';
      }
    } catch (_) { /* mantém operator */ }

    return {
      id: row.username,
      username: row.username,
      email: null,
      role,
      active: row.active,
      tenantId: 'default',
      _passwordHash: row.password_hash,
    };
  }

  // ── Password verification ──────────────────────────────────────────────────

  /**
   * Usa pgcrypto crypt() nativo do PostgreSQL — mesmo método do sistema antigo.
   * O hash no banco está no formato pgcrypto (não bcryptjs).
   *
   * Ex: crypt('senha', hash) = hash  →  senha correta
   */
  async verifyPassword(user, password) {
    if (!password || !user?._passwordHash) return false;
    if (!isCurrentPasswordHash(user._passwordHash)) {
      await this.consumePasswordCost(password);
      return false;
    }
    try {
      const r = await this.db.query(
        `SELECT 1 AS ok
         FROM icingaweb_user
         WHERE lower("name") = lower($1::text)
           AND "active" = 1
           AND "password_hash" = convert_to(crypt($2::text, convert_from("password_hash", 'UTF8')), 'UTF8')
         LIMIT 1`,
        [user.username, password]
      );
      return r.rowCount > 0;
    } catch (e) {
      this.logger.warn('Password verification failed', { err: e.message });
      return false;
    }
  }

  async consumePasswordCost(password) {
    // Mantém o custo de uma tentativa contra usuário inexistente próximo ao de
    // uma senha bcrypt inválida, reduzindo enumeração por tempo de resposta.
    await this.db.query(`SELECT crypt($1::text, gen_salt('bf', 12))`, [String(password || '')]);
  }

  // ── Session persistence ────────────────────────────────────────────────────

  async createSession(session) {
    try {
      await this.db.query(
        `INSERT INTO observe_sessions (token_hash, username, role, user_agent, ip, expires_at, created_at, last_seen_at, csrf_token, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          sessionHash(session.token),
          session.username,
          session.userSnapshot?.role || 'operator',
          String(session.userAgent || '').slice(0, 512),
          session.ipAddress || 'unknown',
          session.expiresAt,
          session.createdAt,
          session.lastActivityAt,
          session.csrfToken,
          session.userSnapshot?.tenantId || 'default',
        ]
      );
    } catch (e) {
      this.logger.warn('Session create failed', { err: e.message });
      throw e;
    }
  }

  async findSession(token) {
    const r = await this.db.query(
      `SELECT username, role, user_agent AS "userAgent", ip AS "ipAddress",
              created_at AS "createdAt", expires_at AS "expiresAt",
              last_seen_at AS "lastActivityAt", csrf_token AS "csrfToken",
              tenant_id AS "tenantId"
       FROM observe_sessions
       WHERE token_hash = $1 AND expires_at > NOW()
       LIMIT 1`,
      [sessionHash(token)]
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return {
      username: row.username,
      userId: row.username,
      userAgent: row.userAgent,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastActivityAt: row.lastActivityAt,
      csrfToken: row.csrfToken,
      userSnapshot: {
        id: row.username,
        username: row.username,
        role: row.role || 'operator',
        active: true,
        tenantId: row.tenantId || 'default',
      },
    };
  }

  async destroySession(token) {
    try {
      await this.db.query(
        `DELETE FROM observe_sessions WHERE token_hash = $1`,
        [sessionHash(token)]
      );
    } catch (e) {
      this.logger.warn('Session destroy failed', { err: e.message });
    }
  }

  async updateLastLogin(userId, now) {
    // icingaweb_user não tem coluna last_login — no-op
  }

  async updateLastActivity(token, now) {
    try {
      await this.db.query(
        `UPDATE observe_sessions SET last_seen_at = $2 WHERE token_hash = $1`,
        [sessionHash(token), now]
      );
    } catch (e) {
      this.logger.warn('Session activity update failed', { err: e.message });
    }
  }

  async deleteExpiredSessions() {
    await this.db.query(`DELETE FROM observe_sessions WHERE expires_at <= NOW()`);
  }

  async revokeAllForUser(username) {
    await this.db.query(`DELETE FROM observe_sessions WHERE lower(username) = lower($1::text)`, [username]);
  }
}

module.exports = { ObserveAdapter, isCurrentPasswordHash };
