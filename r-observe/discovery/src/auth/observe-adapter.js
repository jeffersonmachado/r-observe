'use strict';

/**
 * ObserveAdapter — adapter raw-SQL para @results/auth.
 *
 * Interface implementada:
 *   - findUserByUsername(username)   → SELECT icingaweb_user
 *   - verifyPassword(user, password) → pgcrypto crypt() (PostgreSQL nativo)
 *   - createSession(session)         → INSERT observe_sessions
 *   - destroySession(token)          → DELETE observe_sessions
 *   - updateLastLogin(userId, now)   → (no-op: icingaweb_user não tem last_login)
 *   - updateLastActivity(token, now) → UPDATE observe_sessions last_seen_at
 *   - loadAllSessions()              → SELECT sessões não expiradas
 *
 * NOTA: A interface do @results/auth espera que o adapter armazene e recupere
 *       tokens RAW (não hasheados). A coluna observe_sessions.token_hash será
 *       usada para armazenar o token em plain-text (o nome da coluna é herdado
 *       do sistema antigo, mas o conteúdo será o token opaco gerado pelo pacote).
 */

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
      const grp = await this.db.query(
        `SELECT 1 FROM icingaweb_group_membership gm
         WHERE lower(gm.group_name) = lower('Administrators')
           AND lower(gm.username) = lower($1::text)
         LIMIT 1`,
        [username]
      );
      if (grp.rowCount) role = 'admin';
    } catch (_) { /* mantém operator */ }

    return {
      id: row.username,
      username: row.username,
      email: null,
      role,
      active: row.active,
      tenantId: null,
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

  // ── Session persistence ────────────────────────────────────────────────────

  async createSession(session) {
    try {
      await this.db.query(
        `INSERT INTO observe_sessions (token_hash, username, role, user_agent, ip, expires_at, created_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          session.token,
          session.username,
          session.userSnapshot?.role || 'operator',
          String(session.userAgent || '').slice(0, 512),
          session.ipAddress || 'unknown',
          session.expiresAt,
          session.createdAt,
          session.lastActivityAt,
        ]
      );
    } catch (e) {
      // non-blocking — o Map em memória é a fonte da verdade
      this.logger.warn('Session create failed', { err: e.message });
    }
  }

  async destroySession(token) {
    try {
      await this.db.query(
        `DELETE FROM observe_sessions WHERE token_hash = $1`,
        [token]
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
        [token, now]
      );
    } catch (e) {
      this.logger.warn('Session activity update failed', { err: e.message });
    }
  }

  // ── Initialization ─────────────────────────────────────────────────────────

  async loadAllSessions() {
    try {
      const r = await this.db.query(
        `SELECT token_hash AS token,
                username,
                role,
                user_agent AS "userAgent",
                ip AS "ipAddress",
                created_at AS "createdAt",
                expires_at AS "expiresAt",
                last_seen_at AS "lastActivityAt"
         FROM observe_sessions
         WHERE expires_at > NOW()
         ORDER BY created_at ASC`
      );

      return r.rows.map(row => ({
        token: row.token,
        userId: row.username,
        username: row.username,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt,
        lastActivityAt: row.lastActivityAt instanceof Date ? row.lastActivityAt.toISOString() : row.lastActivityAt,
        ipAddress: row.ipAddress || 'unknown',
        userAgent: row.userAgent || 'unknown',
        userSnapshot: {
          id: row.username,
          username: row.username,
          role: row.role,
          active: true,
        },
      }));
    } catch (e) {
      this.logger.warn('Load sessions failed', { err: e.message });
      return [];
    }
  }
}

module.exports = { ObserveAdapter };
