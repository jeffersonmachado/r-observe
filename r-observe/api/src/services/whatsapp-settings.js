'use strict';

const { normalizeRecipient } = require('../shared/whatsapp');

const MASKED_PREFIX = '\u25CF\u25CF\u25CF\u25CF';

function maskToken(token) {
  if (!token) return null;
  if (token.length <= 8) return MASKED_PREFIX;
  return `${MASKED_PREFIX}${token.slice(-4)}`;
}

function createWhatsAppSettingsService({ db, log }) {
  async function getRaw() {
    const r = await db.query(
      'SELECT id, enabled, access_token, phone_number_id, recipient, severity_filter FROM observe_whatsapp_settings WHERE id = 1',
    );
    return r.rowCount ? r.rows[0] : null;
  }

  // Nunca expõe o token completo — apenas máscara + flag.
  async function get() {
    const row = await getRaw();
    return {
      enabled: row?.enabled ?? false,
      phone_number_id: row?.phone_number_id || '',
      recipient: row?.recipient || '',
      severity_filter: row?.severity_filter || 'critical',
      token_set: !!row?.access_token,
      token_masked: row?.access_token ? maskToken(row.access_token) : null,
    };
  }

  function resolveToken(patchToken, currentToken) {
    if (patchToken === undefined || patchToken === null) return currentToken || null;
    const value = String(patchToken).trim();
    if (!value) return currentToken || null; // em branco → mantém
    if (/^[\u25CF*\u2022]/.test(value)) return currentToken || null; // mascarado → mantém
    return value;
  }

  async function update(patch = {}) {
    const current = await getRaw();
    const next = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current?.enabled ?? false,
      phone_number_id: patch.phone_number_id !== undefined ? String(patch.phone_number_id || '') : current?.phone_number_id || '',
      recipient: patch.recipient !== undefined ? normalizeRecipient(patch.recipient) || '' : current?.recipient || '',
      severity_filter: patch.severity_filter || current?.severity_filter || 'critical',
      access_token: resolveToken(patch.access_token, current?.access_token || null),
    };

    await db.query(
      `INSERT INTO observe_whatsapp_settings
         (id, enabled, access_token, phone_number_id, recipient, severity_filter, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         access_token = EXCLUDED.access_token,
         phone_number_id = EXCLUDED.phone_number_id,
         recipient = EXCLUDED.recipient,
         severity_filter = EXCLUDED.severity_filter,
         updated_at = NOW()`,
      [next.enabled, next.access_token, next.phone_number_id, next.recipient, next.severity_filter],
    );

    log('info', 'WhatsApp settings updated', { enabled: next.enabled, recipient_set: !!next.recipient });
    return get();
  }

  return { get, getRaw, update };
}

module.exports = { createWhatsAppSettingsService };
