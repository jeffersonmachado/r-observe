'use strict';

/**
 * Contexto operacional (RAG) para o assistente do R-Observe.
 *
 * Monta um snapshot compacto do estado atual do sistema a partir do banco,
 * usado como contexto "grounded" para que a IA responda perguntas sobre o
 * ambiente sem alucinar.
 */

async function queryOne(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rowCount ? r.rows[0] : null;
}

function createRagContext({ db, log }) {
  async function build() {
    const lines = ['# Contexto operacional do R-Observe (snapshot atual)', ''];

    try {
      const agents = await queryOne(
        db,
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'online')::int AS online
         FROM observe_discovery_agents`
      );
      const assets = await queryOne(db, `SELECT COUNT(*)::int AS total FROM observe_assets`);
      const inc = await queryOne(
        db,
        `SELECT COUNT(*)::int AS open FROM observe_incidents WHERE status NOT IN ('resolved', 'closed')`
      );
      lines.push(
        '## Status',
        `- Agentes Discovery: ${agents?.online ?? 0}/${agents?.total ?? 0} online`,
        `- Ativos monitorados: ${assets?.total ?? 0}`,
        `- Incidentes abertos: ${inc?.open ?? 0}`,
        ''
      );
    } catch (e) {
      log('warn', 'RAG: status indisponível', { err: e.message });
    }

    try {
      const incidents = await db.query(
        `SELECT title, severity, status, created_at
         FROM observe_incidents
         WHERE status NOT IN ('resolved', 'closed')
         ORDER BY created_at DESC LIMIT 10`
      );
      lines.push('## Incidentes abertos (mais recentes)');
      if (!incidents.rowCount) {
        lines.push('- Nenhum incidente aberto.', '');
      } else {
        for (const row of incidents.rows) {
          const dt = new Date(row.created_at).toISOString().slice(0, 16).replace('T', ' ');
          lines.push(`- [${row.severity}] ${row.title} (${row.status}, ${dt})`);
        }
        lines.push('');
      }
    } catch (e) {
      log('warn', 'RAG: incidentes indisponíveis', { err: e.message });
    }

    try {
      const assets = await db.query(
        `SELECT asset_name, primary_ip, vendor
         FROM observe_assets
         WHERE primary_ip IS NOT NULL
         ORDER BY updated_at DESC LIMIT 15`
      );
      lines.push('## Ativos recentes');
      if (!assets.rowCount) {
        lines.push('- Nenhum ativo catalogado.', '');
      } else {
        for (const row of assets.rows) {
          lines.push(`- ${row.asset_name || row.primary_ip} (${row.primary_ip})${row.vendor ? ` — ${row.vendor}` : ''}`);
        }
        lines.push('');
      }
    } catch (e) {
      log('warn', 'RAG: ativos indisponíveis', { err: e.message });
    }

    return lines.join('\n');
  }

  return { build };
}

module.exports = { createRagContext };
