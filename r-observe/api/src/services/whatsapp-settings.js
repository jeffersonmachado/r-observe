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
      'SELECT id, enabled, access_token, phone_number_id, recipient, severity_filter, webhook_verify_token, app_secret, prefer_qr FROM observe_whatsapp_settings WHERE id = 1',
    );
    return r.rowCount ? r.rows[0] : null;
  }

  // Nunca expõe tokens completos — apenas máscara + flag.
  async function get() {
    const row = await getRaw();
    return {
      enabled: row?.enabled ?? false,
      phone_number_id: row?.phone_number_id || '',
      recipient: row?.recipient || '',
      severity_filter: row?.severity_filter || 'critical',
      prefer_qr: row?.prefer_qr === true,
      token_set: !!row?.access_token,
      token_masked: row?.access_token ? maskToken(row.access_token) : null,
      webhook_verify_token: row?.webhook_verify_token || '',
      webhook_verify_token_set: !!row?.webhook_verify_token,
      app_secret_set: !!row?.app_secret,
      webhook_path: '/observe/api/whatsapp/webhook',
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
      prefer_qr: typeof patch.prefer_qr === 'boolean' ? patch.prefer_qr : current?.prefer_qr === true,
      access_token: resolveToken(patch.access_token, current?.access_token || null),
      webhook_verify_token: patch.webhook_verify_token !== undefined
        ? String(patch.webhook_verify_token || '').trim()
        : current?.webhook_verify_token || '',
      app_secret: resolveToken(patch.app_secret, current?.app_secret || null),
    };

    await db.query(
      `INSERT INTO observe_whatsapp_settings
         (id, enabled, access_token, phone_number_id, recipient, severity_filter, webhook_verify_token, app_secret, prefer_qr, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         access_token = EXCLUDED.access_token,
         phone_number_id = EXCLUDED.phone_number_id,
         recipient = EXCLUDED.recipient,
         severity_filter = EXCLUDED.severity_filter,
         webhook_verify_token = EXCLUDED.webhook_verify_token,
         app_secret = EXCLUDED.app_secret,
         prefer_qr = EXCLUDED.prefer_qr,
         updated_at = NOW()`,
      [next.enabled, next.access_token, next.phone_number_id, next.recipient, next.severity_filter, next.webhook_verify_token, next.app_secret, next.prefer_qr],
    );

    log('info', 'WhatsApp settings updated', { enabled: next.enabled, recipient_set: !!next.recipient, webhook_set: !!next.webhook_verify_token });
    return get();
  }

  return { get, getRaw, update };
}

module.exports = { createWhatsAppSettingsService };
