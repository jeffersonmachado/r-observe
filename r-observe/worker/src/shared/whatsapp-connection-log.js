'use strict';

/**
 * Log persistente de eventos de conexão WhatsApp (canais QR e Cloud) —
 * ciclo de vida do pareamento, comandos aplicados e resultados de envio.
 * Mesmo contrato do whatsapp-message-log: nunca lança exceção (falha de
 * auditoria não pode quebrar o fluxo principal) e filtros whitelistados.
 *
 * ATENÇÃO: este arquivo tem uma cópia idêntica em
 * r-observe/api/src/shared/ e r-observe/worker/src/shared/ — manter sincronizadas.
 */

const MAX_DETAIL = 1000;
const MAX_EVENT = 60;
const MAX_CONNECTION_ID = 100;

// Eventos conhecidos (whitelist do filtro `event` no listRecent).
const KNOWN_EVENTS = [
  'service_started',
  'command_applied',
  'connect_requested',
  'disconnect_requested',
  'qr_generated',
  'status_changed',
  'ready',
  'error',
  'lock_cleared',
  'send_qr_ok',
  'send_qr_fail',
  'send_cloud_ok',
  'send_cloud_fail',
];

function createWhatsAppConnectionLog({ db, log }) {
  async function record({ channel, connectionId = 'default', event, detail = null }) {
    try {
      await db.query(
        `INSERT INTO observe_whatsapp_connection_events
           (channel, connection_id, event, detail)
         VALUES ($1, $2, $3, $4)`,
        [
          channel === 'qr' ? 'qr' : 'cloud',
          String(connectionId || 'default').slice(0, MAX_CONNECTION_ID),
          String(event || 'unknown').slice(0, MAX_EVENT),
          detail ? String(detail).slice(0, MAX_DETAIL) : null,
        ],
      );
    } catch (e) {
      log('warn', 'WhatsApp connection event audit failed', { err: e.message });
    }
  }

  async function listRecent({ limit = 50, offset = 0, channel, event, q } = {}) {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const where = [];
    const params = [];
    if (channel === 'qr' || channel === 'cloud') {
      params.push(channel);
      where.push(`channel = $${params.length}`);
    }
    if (event && KNOWN_EVENTS.includes(event)) {
      params.push(event);
      where.push(`event = $${params.length}`);
    }
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim().slice(0, 100)}%`);
      where.push(`detail ILIKE $${params.length}`);
    }
    params.push(safeLimit);
    const limitIdx = params.length;
    params.push(safeOffset);
    const offsetIdx = params.length;
    const r = await db.query(
      `SELECT id, channel, connection_id, event, detail, created_at,
              COUNT(*) OVER() AS total
       FROM observe_whatsapp_connection_events
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    return r.rows || [];
  }

  return { record, listRecent };
}

module.exports = { createWhatsAppConnectionLog, KNOWN_EVENTS };
