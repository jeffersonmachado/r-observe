-- Configurações de notificação via WhatsApp Business Cloud API.
-- Singleton (id = 1), editável pela UI (/observe/settings → aba WhatsApp).
-- O access_token é armazenado cifrado? Não — fica em coluna text; o endpoint
-- de leitura (GET /observe/api/system/whatsapp) nunca o devolve, apenas máscara.
CREATE TABLE IF NOT EXISTS observe_whatsapp_settings (
  id               INTEGER PRIMARY KEY,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  access_token     TEXT,
  phone_number_id  TEXT,
  recipient        TEXT,
  severity_filter  TEXT NOT NULL DEFAULT 'critical',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
