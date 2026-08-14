-- Correção: incident_id passa de BIGINT para TEXT.
-- Os incidentes do R-Observe usam UUID (ex: observe_incidents.id), não inteiros.
ALTER TABLE observe_whatsapp_messages
  ALTER COLUMN incident_id TYPE TEXT;
