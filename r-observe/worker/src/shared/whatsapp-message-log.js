'use strict';

/**
 * Auditoria de mensagens WhatsApp — registra todas as mensagens do canal
 * (entrada via webhook e saída: bot, notificações de incidente e testes).
 * Nunca lança exceção: falha de auditoria não pode quebrar o fluxo principal.
 */

const MAX_BODY = 4096;
const MAX_ERROR = 500;

function createWhatsAppMessageLog({ db, log }) {
  async function record({ direction, kind, phone, body, status, error = null, metaMessageId = null, incidentId = null, channel = 'cloud' }) {
    try {
      await db.query(
        `INSERT INTO observe_whatsapp_messages
           (direction, kind, phone, body, status, error, meta_message_id, incident_id, channel)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          direction,
          kind,
          phone || null,
          body ? String(body).slice(0, MAX_BODY) : null,
          status,
          error ? String(error).slice(0, MAX_ERROR) : null,
          metaMessageId || null,
          incidentId || null,
          channel === 'qr' ? 'qr' : 'cloud',
        ],
      );
    } catch (e) {
      log('warn', 'WhatsApp message audit failed', { err: e.message });
    }
  }

  async function listRecent({ limit = 50, offset = 0, direction, kind, status, q, excludeKind } = {}) {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const where = [];
    const params = [];
    if (direction === 'in' || direction === 'out') {
      params.push(direction);
      where.push(`direction = $${params.length}`);
    }
    if (['webhook_in', 'inbound', 'bot_reply', 'incident_notification', 'test_send', 'status_callback'].includes(kind)) {
      params.push(kind);
      where.push(`kind = $${params.length}`);
    }
    if (excludeKind === 'status_callback') {
      where.push(`kind <> 'status_callback'`);
    }
    if (['received', 'sent', 'failed', 'delivered', 'read'].includes(status)) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim().slice(0, 100)}%`);
      where.push(`(phone ILIKE $${params.length} OR body ILIKE $${params.length})`);
    }
    params.push(safeLimit);
    const limitIdx = params.length;
    params.push(safeOffset);
    const offsetIdx = params.length;
    const r = await db.query(
      `SELECT id, direction, kind, phone, body, status, error, meta_message_id, incident_id, channel, created_at,
              COUNT(*) OVER() AS total
       FROM observe_whatsapp_messages
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    return r.rows || [];
  }

  return { record, listRecent };
}

module.exports = { createWhatsAppMessageLog };
