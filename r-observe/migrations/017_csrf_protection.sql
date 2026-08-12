-- Migration: 017_csrf_protection.sql
-- Adiciona suporte a CSRF tokens nas sessões e melhora hash de senhas.

-- 1. Coluna csrf_token na tabela de sessões
ALTER TABLE observe_sessions
  ADD COLUMN IF NOT EXISTS csrf_token VARCHAR(128);

-- 2. Índice para busca rápida de CSRF tokens
CREATE INDEX IF NOT EXISTS idx_observe_sessions_csrf
  ON observe_sessions(csrf_token)
  WHERE csrf_token IS NOT NULL;

-- 3. A aplicação aceita exclusivamente bcrypt cost=12. Este produto ainda não
--    possui base instalada; portanto não há caminho de compatibilidade legado.
