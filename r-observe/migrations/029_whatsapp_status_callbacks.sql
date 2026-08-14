-- Recibos de entrega da Meta (status callbacks: sent/delivered/read/failed).
-- Novo kind 'status_callback' e novos status 'delivered'/'read' na auditoria.
ALTER TABLE observe_whatsapp_messages
  DROP CONSTRAINT IF EXISTS observe_whatsapp_messages_status_check;
ALTER TABLE observe_whatsapp_messages
  ADD CONSTRAINT observe_whatsapp_messages_status_check
  CHECK (status IN ('received', 'sent', 'failed', 'delivered', 'read'));

ALTER TABLE observe_whatsapp_messages
  DROP CONSTRAINT IF EXISTS observe_whatsapp_messages_kind_check;
ALTER TABLE observe_whatsapp_messages
  ADD CONSTRAINT observe_whatsapp_messages_kind_check
  CHECK (kind IN ('webhook_in', 'bot_reply', 'incident_notification', 'test_send', 'status_callback'));
