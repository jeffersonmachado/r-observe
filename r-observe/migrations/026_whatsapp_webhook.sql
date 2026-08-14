-- Interação bidirecional via WhatsApp (webhook + bot de comandos).
-- Adiciona ao singleton (id = 1) de observe_whatsapp_settings:
--   webhook_verify_token  — token usado na verificação GET do webhook da Meta
--   app_secret            — App Secret da Meta, para validar X-Hub-Signature-256
-- Nenhum dos dois é devolvido pela API (apenas máscara/flag).
ALTER TABLE observe_whatsapp_settings
  ADD COLUMN IF NOT EXISTS webhook_verify_token TEXT,
  ADD COLUMN IF NOT EXISTS app_secret TEXT;
