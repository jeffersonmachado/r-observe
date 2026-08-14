'use strict';

const { sendWhatsAppMessage } = require('../shared/whatsapp');
const { createWhatsAppMessageLog } = require('../shared/whatsapp-message-log');
const { createWhatsAppConnectionLog } = require('../shared/whatsapp-connection-log');

function severityEnabled(filter, severity) {
  if (filter === 'all') return true;
  if (filter === 'warning') return severity === 'critical' || severity === 'warning';
  return severity === 'critical';
}

function createWhatsAppNotifier({ db, log, qr = null }) {
  const msgLog = createWhatsAppMessageLog({ db, log });
  const connLog = createWhatsAppConnectionLog({ db, log });

  async function getConfig() {
    try {
      const r = await db.query(
        'SELECT enabled, access_token, phone_number_id, recipient, severity_filter FROM observe_whatsapp_settings WHERE id = 1',
      );
      return r.rowCount ? r.rows[0] : null;
    } catch (e) {
      log('warn', 'WhatsApp settings unavailable', { err: e.message });
      return null;
    }
  }

  async function notifyIncident(incident) {
    try {
      const cfg = await getConfig();
      if (!cfg || !cfg.enabled) return;
      if (!severityEnabled(cfg.severity_filter || 'critical', incident.severity)) return;

      const icon = incident.severity === 'critical' ? '\u{1F6A8}' : incident.severity === 'warning' ? '\u26A0\uFE0F' : '\u2139\uFE0F';
      const causeLine = incident.cause ? `\nCausa: ${incident.cause}` : '';
      const text = `${icon} *R-Observe*\n${incident.title}\nSeveridade: ${incident.severity}${causeLine}`;

      // Canal: Cloud API quando configurada; senão, fallback para o canal QR
      // (bridge no worker) se a sessão estiver pronta. O destinatário do QR é
      // o mesmo `recipient` das settings (normalizado para @c.us pelo bridge).
      const cloudConfigured = !!(cfg.access_token && cfg.phone_number_id && cfg.recipient);
      const useQr = !cloudConfigured && !!qr && qr.qrReady();

      if (useQr) {
        try {
          if (!cfg.recipient) throw new Error('Destinatário (recipient) não configurado');
          const res = await qr.sendText(cfg.recipient, text);
          if (!res || res.ok !== true) throw new Error((res && (res.message || res.error)) || 'qr_send_failed');
          await msgLog.record({ direction: 'out', kind: 'incident_notification', channel: 'qr', phone: cfg.recipient, body: text, status: 'sent', metaMessageId: res.externalMessageId || null, incidentId: incident.id || null });
          await connLog.record({ channel: 'qr', event: 'send_qr_ok', detail: `to=${cfg.recipient}` });
          log('info', 'WhatsApp notification sent (QR)', { incident_id: incident.id, severity: incident.severity });
        } catch (sendErr) {
          await msgLog.record({ direction: 'out', kind: 'incident_notification', channel: 'qr', phone: cfg.recipient || null, body: text, status: 'failed', error: sendErr.message, incidentId: incident.id || null });
          await connLog.record({ channel: 'qr', event: 'send_qr_fail', detail: `to=${cfg.recipient || '—'} err=${sendErr.message}` });
          log('warn', 'WhatsApp QR notification failed', { incident_id: incident.id, err: sendErr.message });
        }
        return;
      }

      try {
        const sent = await sendWhatsAppMessage({
          accessToken: cfg.access_token,
          phoneNumberId: cfg.phone_number_id,
          to: cfg.recipient,
          text,
        });
        await msgLog.record({ direction: 'out', kind: 'incident_notification', phone: cfg.recipient, body: text, status: 'sent', metaMessageId: sent.message_id, incidentId: incident.id || null });
        await connLog.record({ channel: 'cloud', event: 'send_cloud_ok', detail: `to=${cfg.recipient} http=${sent.status || '—'}` });
        log('info', 'WhatsApp notification sent', { incident_id: incident.id, severity: incident.severity });
      } catch (sendErr) {
        await msgLog.record({ direction: 'out', kind: 'incident_notification', phone: cfg.recipient, body: text, status: 'failed', error: sendErr.message, incidentId: incident.id || null });
        await connLog.record({ channel: 'cloud', event: 'send_cloud_fail', detail: `to=${cfg.recipient || '—'} err=${sendErr.message}` });
        throw sendErr;
      }
    } catch (e) {
      log('warn', 'WhatsApp notification failed', { incident_id: incident.id, err: e.message });
    }
  }

  return { notifyIncident, getConfig };
}

module.exports = { createWhatsAppNotifier };
