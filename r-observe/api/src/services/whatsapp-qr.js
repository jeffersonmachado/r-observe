'use strict';

/**
 * Canal WhatsApp via QR Code — lado da API.
 * A API não fala com o bridge (que roda no worker): lê o estado e escreve o
 * comando desejado na tabela `observe_whatsapp_qr_connections`, que o worker
 * consome via poll. QR expirado não é exposto (a UI pediria um novo).
 */

const CONNECTION_ID = 'default';

function createWhatsAppQrService({ db, log }) {
  async function getRow() {
    const r = await db.query(
      `SELECT enabled, desired_state, status, qr_data_url, qr_expires_at, last_error, updated_at
       FROM observe_whatsapp_qr_connections WHERE id = $1`,
      [CONNECTION_ID],
    );
    return r.rowCount ? r.rows[0] : null;
  }

  async function getStatus() {
    const row = await getRow();
    if (!row) {
      return { enabled: false, status: 'disconnected', qrDataUrl: null, qrExpiresAt: null, lastError: null };
    }
    const qrValid = row.qr_data_url && row.qr_expires_at && new Date(row.qr_expires_at).getTime() > Date.now();
    return {
      enabled: !!row.enabled,
      status: row.status || 'disconnected',
      qrDataUrl: qrValid ? row.qr_data_url : null,
      qrExpiresAt: qrValid ? row.qr_expires_at : null,
      lastError: row.last_error || null,
      updatedAt: row.updated_at || null,
    };
  }

  // Conectar/habilitar: o worker gera um novo QR (evento) ao aplicar o comando.
  async function connect() {
    await db.query(
      `INSERT INTO observe_whatsapp_qr_connections (id, enabled, desired_state, updated_at)
       VALUES ($1, TRUE, 'connected', NOW())
       ON CONFLICT (id) DO UPDATE SET enabled = TRUE, desired_state = 'connected', updated_at = NOW()`,
      [CONNECTION_ID],
    );
    log('info', 'WhatsApp QR: conexão solicitada');
    return getStatus();
  }

  // disconnect: para a sessão. { enabled:false } também desliga o canal;
  // sem o flag, o valor atual de `enabled` é preservado.
  async function disconnect({ enabled } = {}) {
    const disable = enabled === false;
    await db.query(
      `INSERT INTO observe_whatsapp_qr_connections (id, enabled, desired_state, status, qr_text, qr_data_url, qr_expires_at, updated_at)
       VALUES ($1, FALSE, 'disconnected', 'disconnected', NULL, NULL, NULL, NOW())
       ON CONFLICT (id) DO UPDATE SET
         enabled = CASE WHEN $2 THEN FALSE ELSE observe_whatsapp_qr_connections.enabled END,
         desired_state = 'disconnected',
         status = 'disconnected',
         qr_text = NULL, qr_data_url = NULL, qr_expires_at = NULL,
         updated_at = NOW()`,
      [CONNECTION_ID, disable],
    );
    log('info', 'WhatsApp QR: desconexão solicitada', { disabled: disable });
    return getStatus();
  }

  return { getStatus, connect, disconnect };
}

module.exports = { createWhatsAppQrService };
