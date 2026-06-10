-- 010_topology_evidence.sql
-- Adiciona confidence, evidence e last_seen à tabela de topologia
-- Necessário para suportar edges com evidências reais (LLDP/CDP/VLAN/ARP)

ALTER TABLE observe_topology_edges
  ADD COLUMN IF NOT EXISTS confidence  NUMERIC(4,3) NOT NULL DEFAULT 0.500,
  ADD COLUMN IF NOT EXISTS evidence    JSONB        NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS last_seen   TIMESTAMPTZ  NOT NULL DEFAULT NOW();

-- Atualizar o índice único para incluir o novo esquema
-- O índice já existe, mas pode precisar ser recriado se a constraint mudou
-- (sem DROP pois pode já não existir com esse nome)
CREATE INDEX IF NOT EXISTS idx_topology_edges_confidence
  ON observe_topology_edges (tenant_id, site_id, edge_type, confidence DESC);

