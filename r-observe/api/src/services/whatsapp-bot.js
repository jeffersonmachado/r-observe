'use strict';

/**
 * Bot de comandos do WhatsApp para o R-Observe.
 *
 * Camadas de interpretação:
 *   1. Comandos determinísticos (rápidos, sem IA): status / alertas / ativos / help.
 *   2. Intenção por IA: para mensagens fora do padrão, a IA classifica a intenção.
 *   3. Inferência (RAG): perguntas livres são respondidas com base no contexto
 *      operacional atual (status, incidentes e ativos) — sem alucinar.
 */

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/^[^a-z0-9]+/, '')   // remove pontuação inicial (ex: "!", "/")
    .replace(/[^a-z0-9\s]+$/, ''); // remove pontuação final
}

// Retorna um comando explícito ou null (quando a mensagem não é óbvia).
function explicitCommand(text) {
  const first = normalize(text).split(/\s+/)[0] || '';
  if (['help', 'menu', 'ajuda', 'oi', 'ola', 'ping', 'start'].includes(first)) return 'help';
  if (['status', 'resumo', 'resumen', 'summary'].includes(first)) return 'status';
  if (['alertas', 'alerta', 'incidentes', 'incidents', 'incidente'].includes(first)) return 'incidents';
  if (['ativos', 'assets', 'hosts', 'inventario', 'inventário'].includes(first)) return 'assets';
  return null;
}

// Fallback keyword (mantido por compatibilidade): nunca retorna null.
function pickCommand(text) {
  return explicitCommand(text) || 'help';
}

function createWhatsAppBot({ db, log, aiChat = null, ragContext = null }) {
  async function queryOne(sql, params = []) {
    const r = await db.query(sql, params);
    return r.rowCount ? r.rows[0] : null;
  }

  async function buildStatus() {
    const agents = await queryOne(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'online')::int AS online
       FROM observe_discovery_agents`
    ) || { total: 0, online: 0 };

    const assets = await queryOne(`SELECT COUNT(*)::int AS total FROM observe_assets`) || { total: 0 };

    const incidents = await queryOne(
      `SELECT COUNT(*)::int AS open
       FROM observe_incidents
       WHERE status NOT IN ('resolved', 'closed')`
    ) || { open: 0 };

    const lines = [
      '\u{1F4CA} *R-Observe — Status*',
      `\u{1F4E1} Agentes Discovery: ${agents.online}/${agents.total} online`,
      `\u{1F5A5} Ativos monitorados: ${assets.total}`,
      `\u{1F6A8} Incidentes abertos: ${incidents.open}`,
    ];
    return lines.join('\n');
  }

  async function buildIncidents() {
    const r = await db.query(
      `SELECT title, severity, status, created_at
       FROM observe_incidents
       WHERE status NOT IN ('resolved', 'closed')
       ORDER BY created_at DESC
       LIMIT 5`
    );
    const rows = r.rows || [];
    if (!rows.length) return '\u2705 Nenhum incidente aberto no momento.';

    const icon = (sev) => (sev === 'critical' ? '\u{1F6A8}' : sev === 'warning' ? '\u26A0\uFE0F' : '\u2139\uFE0F');
    const lines = ['\u{1F6A8} *Incidentes abertos*'];
    rows.forEach((row, i) => {
      lines.push(`${i + 1}. ${icon(row.severity)} [${row.severity}] ${row.title}`);
    });
    return lines.join('\n');
  }

  async function buildAssets() {
    const total = await queryOne(`SELECT COUNT(*)::int AS total FROM observe_assets`) || { total: 0 };
    const r = await db.query(
      `SELECT asset_name, primary_ip
       FROM observe_assets
       WHERE primary_ip IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 5`
    );
    const rows = r.rows || [];
    const lines = [`\u{1F5A5} *Ativos monitorados: ${total.total}*`];
    rows.forEach((row, i) => {
      lines.push(`${i + 1}. ${row.asset_name || row.primary_ip} (${row.primary_ip})`);
    });
    return lines.join('\n');
  }

  function buildMenu() {
    return [
      '\u{1F916} *R-Observe via WhatsApp*',
      'Envie um comando ou uma pergunta:',
      '\u2022 *status* — resumo do sistema',
      '\u2022 *alertas* — incidentes abertos',
      '\u2022 *ativos* — ativos monitorados',
      '\u2022 ou pergunte em linguagem natural (ex: "quantos incidentes críticos temos?")',
    ].join('\n');
  }

  async function classifyIntent(text) {
    if (!aiChat) return null;
    try {
      const prompt = [
        'Classifique a intenção da mensagem abaixo em UMA destas categorias:',
        '- "status": resumo/estado do sistema',
        '- "incidents": incidentes ou alertas',
        '- "assets": ativos ou hosts',
        '- "help": saudação, ajuda ou menu',
        '- "question": qualquer outra pergunta ou pedido',
        'Responda SOMENTE com JSON válido: {"intent":"<categoria>"}',
        '',
        `Mensagem: "${String(text).slice(0, 500)}"`,
      ].join('\n');
      const res = await aiChat([{ role: 'user', content: prompt }]);
      if (!res || !res.content) return null;
      const match = res.content.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : res.content);
      return ['status', 'incidents', 'assets', 'help', 'question'].includes(parsed.intent) ? parsed.intent : null;
    } catch {
      return null;
    }
  }

  async function ragAnswer(text) {
    if (!aiChat || !ragContext) return null;
    try {
      const context = await ragContext.build();
      const res = await aiChat([
        {
          role: 'user',
          content: `Use o contexto abaixo para responder.\n\n${context}\n\nPergunta do usuário: ${text}\n\nResponda de forma curta e objetiva, apenas com dados do contexto.`,
        },
      ]);
      return res && res.content ? res.content : null;
    } catch {
      return null;
    }
  }

  async function handleMessage({ text }) {
    try {
      const cmd = explicitCommand(text);
      if (cmd === 'status') return await buildStatus();
      if (cmd === 'incidents') return await buildIncidents();
      if (cmd === 'assets') return await buildAssets();
      if (cmd === 'help') return buildMenu();

      // Mensagem fora do padrão → IA infere a intenção.
      const intent = await classifyIntent(text);
      if (intent === 'status') return await buildStatus();
      if (intent === 'incidents') return await buildIncidents();
      if (intent === 'assets') return await buildAssets();
      if (intent === 'help') return buildMenu();

      // Pergunta livre → resposta fundamentada no contexto (RAG).
      const answer = await ragAnswer(text);
      if (answer) return answer;

      return buildMenu();
    } catch (e) {
      log('warn', 'WhatsApp bot command failed', { err: e.message });
      return '\u26A0\uFE0F Não consegui consultar o R-Observe agora. Tente novamente em instantes.';
    }
  }

  return { handleMessage, pickCommand, explicitCommand };
}

module.exports = { createWhatsAppBot, pickCommand, explicitCommand };
