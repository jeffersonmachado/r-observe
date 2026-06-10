'use strict';

function parseBool(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

async function ensureGrafanaAdminIfNotPersisted(env = process.env, logger = console) {
  const enabled = parseBool(env.OBSERVE_BOOTSTRAP_GRAFANA_ADMIN_ENABLED, true);
  if (!enabled) return { status: 'disabled' };
  const strictUnreachable = parseBool(
    env.OBSERVE_BOOTSTRAP_GRAFANA_ADMIN_STRICT,
    env.NODE_ENV !== 'development'
  );

  const user = String(env.GRAFANA_ADMIN_USER || '').trim();
  const password = String(env.GRAFANA_ADMIN_PASSWORD || '').trim();
  const baseUrl = String(env.GRAFANA_URL || 'http://observe-grafana:3000').replace(/\/+$/, '');

  if (!user || !password) {
    logger.log?.(JSON.stringify({
      level: 'info',
      service: 'r-observe-api',
      msg: 'Grafana bootstrap skipped (missing admin credentials)',
      ts: new Date().toISOString(),
    }));
    return { status: 'skipped-missing-env' };
  }

  try {
    const loginRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, password }),
    });

    if (loginRes.ok) {
      logger.log?.(JSON.stringify({
        level: 'info',
        service: 'r-observe-api',
        msg: 'Grafana admin credentials accepted (persisted or freshly initialized)',
        user,
        ts: new Date().toISOString(),
      }));
      return { status: 'ok' };
    }

    if (loginRes.status === 401) {
      logger.log?.(JSON.stringify({
        level: 'info',
        service: 'r-observe-api',
        msg: 'Grafana credentials appear persisted with different password; bootstrap will not overwrite',
        user,
        ts: new Date().toISOString(),
      }));
      return { status: 'persisted-different-password' };
    }

    logger.log?.(JSON.stringify({
      level: strictUnreachable ? 'error' : 'warn',
      service: 'r-observe-api',
      msg: 'Grafana bootstrap check returned unexpected status',
      status: loginRes.status,
      ts: new Date().toISOString(),
    }));
    if (strictUnreachable) {
      throw new Error(`Grafana bootstrap check returned unexpected status: ${loginRes.status}`);
    }
    return { status: `unexpected-${loginRes.status}` };
  } catch (error) {
    const level = strictUnreachable ? 'error' : 'warn';
    logger.log?.(JSON.stringify({
      level,
      service: 'r-observe-api',
      msg: 'Grafana bootstrap check failed',
      err: error.message,
      ts: new Date().toISOString(),
    }));
    if (strictUnreachable) throw error;
    return { status: 'unreachable' };
  }
}

function parseInitialUsers(env = process.env) {
  const users = [];
  const seen = new Set();

  const pushUser = (user) => {
    const name = String(user.name || user.username || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    users.push({
      name,
      password: String(user.password || ''),
      active: user.active === false ? 0 : 1,
      admin: user.admin !== false,
    });
  };

  if (env.ICINGAWEB_ADMIN_USER && env.ICINGAWEB_ADMIN_PASS) {
    pushUser({
      name: env.ICINGAWEB_ADMIN_USER,
      password: env.ICINGAWEB_ADMIN_PASS,
      active: true,
      admin: true,
    });
  }

  if (env.OBSERVE_INITIAL_USERS_JSON) {
    const parsed = JSON.parse(env.OBSERVE_INITIAL_USERS_JSON);
    if (!Array.isArray(parsed)) {
      throw new Error('OBSERVE_INITIAL_USERS_JSON deve ser um array');
    }
    for (const user of parsed) pushUser(user || {});
  }

  return users;
}

async function bootstrapInitialUsers(pool, env = process.env, logger = console) {
  const users = parseInitialUsers(env).filter((user) => user.password);
  const forcePasswordUpdate = String(env.OBSERVE_BOOTSTRAP_FORCE_PASSWORD_UPDATE || '').toLowerCase() === 'true';
  if (users.length === 0) {
    logger.log?.(JSON.stringify({
      level: 'info',
      service: 'r-observe-api',
      msg: 'No initial users configured',
      ts: new Date().toISOString(),
    }));
  } else {
    // Garante grupo Administrators — compatível com schema Icinga (id serial) e schema simplificado (name PK)
    await pool.query(`
      INSERT INTO icingaweb_group ("name", "ctime", "mtime")
      SELECT 'Administrators', NOW(), NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM icingaweb_group WHERE lower("name") = lower('Administrators')
      )
    `);

    // Busca o id do grupo (Icinga usa id integer; schema simplificado pode não ter)
    const grpRow = await pool.query(
      `SELECT id FROM icingaweb_group WHERE lower("name") = lower('Administrators') LIMIT 1`
    ).catch(() => ({ rows: [] }));
    const groupId = grpRow.rows[0]?.id ?? null;

    for (const user of users) {
      if (forcePasswordUpdate) {
        // UPDATE usa SELECT para evitar ON CONFLICT com index de expressão
        const exists = await pool.query(
          `SELECT 1 FROM icingaweb_user WHERE lower("name") = lower($1::text) LIMIT 1`,
          [user.name]
        );
        if (exists.rowCount) {
          await pool.query(`
            UPDATE icingaweb_user
            SET "active" = $2, "password_hash" = convert_to(crypt($3, gen_salt('bf')), 'UTF8'), "mtime" = NOW()
            WHERE lower("name") = lower($1::text)
          `, [user.name, user.active, user.password]);
        } else {
          await pool.query(`
            INSERT INTO icingaweb_user ("name", "active", "password_hash", "ctime", "mtime")
            VALUES ($1::varchar, $2::smallint, convert_to(crypt($3::text, gen_salt('bf')), 'UTF8'), NOW(), NOW())
          `, [user.name, user.active, user.password]);
        }
      } else {
        const exists = await pool.query(
          `SELECT 1 FROM icingaweb_user WHERE lower("name") = lower($1::text) LIMIT 1`,
          [user.name]
        );
        if (!exists.rowCount) {
          await pool.query(`
            INSERT INTO icingaweb_user ("name", "active", "password_hash", "ctime", "mtime")
            VALUES ($1::varchar, $2::smallint, convert_to(crypt($3::text, gen_salt('bf')), 'UTF8'), NOW(), NOW())
          `, [user.name, user.active, user.password]);
        }
      }

      if (user.admin && groupId !== null) {
        // Schema Icinga: membership usa group_id (integer)
        const memExists = await pool.query(
          `SELECT 1 FROM icingaweb_group_membership WHERE "group_id" = $1::integer AND lower("username") = lower($2::text) LIMIT 1`,
          [groupId, user.name]
        );
        if (!memExists.rowCount) {
          await pool.query(`
            INSERT INTO icingaweb_group_membership ("group_id", "username", "ctime", "mtime")
            VALUES ($1::integer, $2::varchar, NOW(), NOW())
          `, [groupId, user.name]);
        }
      } else if (user.admin && groupId === null) {
        // Schema simplificado sem id: usa group_name como texto
        const memExists = await pool.query(
          `SELECT 1 FROM icingaweb_group_membership WHERE lower("group_name") = lower('Administrators') AND lower("username") = lower($1::text) LIMIT 1`,
          [user.name]
        ).catch(() => ({ rowCount: 1 })); // se coluna não existe, pula
        if (!memExists.rowCount) {
          await pool.query(`
            INSERT INTO icingaweb_group_membership ("group_name", "username", "ctime", "mtime")
            VALUES ('Administrators', $1::varchar, NOW(), NOW())
          `, [user.name]).catch(() => {});
        }
      }
    }

    logger.log?.(JSON.stringify({
      level: 'info',
      service: 'r-observe-api',
      msg: 'Initial users bootstrapped',
      users: users.map((user) => user.name),
      ts: new Date().toISOString(),
    }));
  }

  const grafana = await ensureGrafanaAdminIfNotPersisted(env, logger);

  return { users: users.length, grafana: grafana.status };
}

module.exports = { bootstrapInitialUsers, parseInitialUsers, ensureGrafanaAdminIfNotPersisted };
