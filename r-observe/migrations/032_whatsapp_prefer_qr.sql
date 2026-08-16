-- Preferência de canal de notificação WhatsApp.
-- Quando TRUE e a sessão QR estiver pronta, as notificações saem pelo canal
-- QR mesmo com a Cloud API configurada. Motivo: a Cloud API aceita o envio
-- (http 200) mesmo quando a Meta bloqueia a entrega depois (ex.: erro 130497,
-- conta restrita de enviar para o país) — fallback por falha de envio não
-- captura esse caso; a escolha de canal precisa ser explícita.
ALTER TABLE observe_whatsapp_settings
  ADD COLUMN IF NOT EXISTS prefer_qr BOOLEAN NOT NULL DEFAULT FALSE;
