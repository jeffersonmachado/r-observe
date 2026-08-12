'use strict';

/**
 * Cliente WhatsApp Business Cloud API (Graph API).
 * Usado pela API (teste/manual) e pelo worker (notificações de incidentes).
 */

const DEFAULT_API_VERSION = 'v25.0';
const GRAPH_BASE = 'https://graph.facebook.com';

function normalizeRecipient(input) {
  if (input === null || input === undefined) return null;
  const digits = String(input).replace(/[^0-9]/g, '');
  return digits || null;
}

async function sendWhatsAppMessage({
  accessToken,
  phoneNumberId,
  to,
  text,
  apiVersion = DEFAULT_API_VERSION,
  fetchImpl = global.fetch,
  timeoutMs = 15000,
}) {
  if (!accessToken) throw new Error('Access token não configurado');
  if (!phoneNumberId) throw new Error('Phone Number ID não configurado');
  const recipient = normalizeRecipient(to);
  if (!recipient) throw new Error('Destinatário inválido');

  const url = `${GRAPH_BASE}/${apiVersion}/${phoneNumberId}/messages`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipient,
        type: 'text',
        text: { preview_url: false, body: String(text || '').slice(0, 4096) },
      }),
      signal: ctrl.signal,
    });

    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const message = (body && body.error && body.error.message) || `HTTP ${resp.status}`;
      throw new Error(message);
    }
    return { ok: true, message_id: body && body.messages && body.messages[0] ? body.messages[0].id : null, status: resp.status };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendWhatsAppMessage, normalizeRecipient };
