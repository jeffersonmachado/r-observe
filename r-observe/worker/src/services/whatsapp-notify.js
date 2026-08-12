'use strict';

const { sendWhatsAppMessage } = require('../shared/whatsapp');

function severityEnabled(filter, severity) {
  if (filter === 'all') return true;
  if (filter === 'warning') return severity === 'critical' || severity === 'warning';
  return severity === 'critical';
}

function createWhatsAppNotifier({ db, log }) {
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
      const text = `${icon} *R-Observe*\n${incident.title}\nSeveridade: ${incident.severity}`;

      await sendWhatsAppMessage({
        accessToken: cfg.access_token,
        phoneNumberId: cfg.phone_number_id,
        to: cfg.recipient,
        text,
      });
      log('info', 'WhatsApp notification sent', { incident_id: incident.id, severity: incident.severity });
    } catch (e) {
      log('warn', 'WhatsApp notification failed', { incident_id: incident.id, err: e.message });
    }
  }

  return { notifyIncident, getConfig };
}

module.exports = { createWhatsAppNotifier };
