-- Migration 006: consolida duplicatas históricas de observe_assets por identidade lógica
-- Executada pelo fluxo oficial Sequelize + Umzug do r-observe.
-- Qualquer constraint/backfill deste domínio deve permanecer versionado em r-observe/migrations/.

CREATE TEMP TABLE tmp_observe_asset_dedupe AS
WITH asset_identity AS (
  SELECT
    a.id,
    a.tenant_id,
    a.site_id,
    a.edge_id,
    a.asset_name,
    a.primary_ip,
    a.hostname,
    a.vendor,
    a.product,
    a.confidence,
    a.created_at,
    a.updated_at,
    CASE
      WHEN a.asset_name IS NOT NULL
       AND btrim(a.asset_name) <> ''
       AND a.asset_name !~ '^\d{1,3}(\.\d{1,3}){3}$'
       AND a.asset_name !~ '^asset-\d{1,3}(-\d{1,3}){3}$'
        THEN 'name:' || lower(a.asset_name)
      WHEN a.hostname IS NOT NULL AND btrim(a.hostname) <> ''
        THEN 'host:' || lower(a.hostname)
      WHEN a.primary_ip IS NOT NULL AND btrim(a.primary_ip) <> ''
        THEN 'ip:' || a.primary_ip
      ELSE 'key:' || lower(a.asset_key)
    END AS logical_key,
    CASE
      WHEN a.vendor IN ('Não identificado', 'Nao identificado', 'Unknown', '') OR a.vendor IS NULL THEN 1
      ELSE 0
    END AS weak_vendor,
    CASE
      WHEN a.product IN ('Sem sinal de serviço', 'Sem sinal de servico', '') OR a.product IS NULL THEN 1
      ELSE 0
    END AS weak_product
  FROM observe_assets a
),
ranked AS (
  SELECT
    ai.*,
    first_value(ai.id) OVER (
      PARTITION BY ai.tenant_id, ai.site_id, ai.edge_id, ai.logical_key
      ORDER BY ai.weak_product ASC, ai.weak_vendor ASC, ai.confidence DESC, ai.updated_at DESC, ai.created_at DESC, ai.id
    ) AS keep_id,
    count(*) OVER (
      PARTITION BY ai.tenant_id, ai.site_id, ai.edge_id, ai.logical_key
    ) AS group_size
  FROM asset_identity ai
)
SELECT
  tenant_id,
  site_id,
  edge_id,
  logical_key,
  keep_id,
  id AS duplicate_id
FROM ranked
WHERE group_size > 1
  AND id <> keep_id;

CREATE INDEX tmp_observe_asset_dedupe_dup_idx ON tmp_observe_asset_dedupe (duplicate_id);
CREATE INDEX tmp_observe_asset_dedupe_keep_idx ON tmp_observe_asset_dedupe (keep_id);

-- Evita conflitos nas tabelas com UNIQUE por asset_id antes de reatribuir o FK.
DELETE FROM observe_asset_interfaces t
USING (
  SELECT id
  FROM (
    SELECT
      i.id,
      row_number() OVER (
        PARTITION BY i.tenant_id, i.site_id, i.edge_id, COALESCE(m.keep_id, i.asset_id), i.interface_key
        ORDER BY CASE WHEN m.duplicate_id IS NULL THEN 0 ELSE 1 END, i.updated_at DESC, i.id
      ) AS rn
    FROM observe_asset_interfaces i
    LEFT JOIN tmp_observe_asset_dedupe m ON m.duplicate_id = i.asset_id
    WHERE i.asset_id IN (
      SELECT duplicate_id FROM tmp_observe_asset_dedupe
      UNION
      SELECT keep_id FROM tmp_observe_asset_dedupe
    )
  ) ranked
  WHERE rn > 1
) doomed
WHERE t.id = doomed.id;

DELETE FROM observe_asset_services t
USING (
  SELECT id
  FROM (
    SELECT
      s.id,
      row_number() OVER (
        PARTITION BY s.tenant_id, s.site_id, s.edge_id, COALESCE(m.keep_id, s.asset_id), s.service_key
        ORDER BY CASE WHEN m.duplicate_id IS NULL THEN 0 ELSE 1 END, s.updated_at DESC, s.id
      ) AS rn
    FROM observe_asset_services s
    LEFT JOIN tmp_observe_asset_dedupe m ON m.duplicate_id = s.asset_id
    WHERE s.asset_id IN (
      SELECT duplicate_id FROM tmp_observe_asset_dedupe
      UNION
      SELECT keep_id FROM tmp_observe_asset_dedupe
    )
  ) ranked
  WHERE rn > 1
) doomed
WHERE t.id = doomed.id;

DELETE FROM observe_service_fingerprints t
USING (
  SELECT id
  FROM (
    SELECT
      sf.id,
      row_number() OVER (
        PARTITION BY sf.tenant_id, sf.site_id, sf.edge_id, COALESCE(m.keep_id, sf.asset_id), sf.service_key
        ORDER BY CASE WHEN m.duplicate_id IS NULL THEN 0 ELSE 1 END, sf.observed_at DESC, sf.id
      ) AS rn
    FROM observe_service_fingerprints sf
    LEFT JOIN tmp_observe_asset_dedupe m ON m.duplicate_id = sf.asset_id
    WHERE sf.asset_id IN (
      SELECT duplicate_id FROM tmp_observe_asset_dedupe
      UNION
      SELECT keep_id FROM tmp_observe_asset_dedupe
    )
  ) ranked
  WHERE rn > 1
) doomed
WHERE t.id = doomed.id;

-- observe_interface_metrics só existe a partir da migration 013; sem dados para dedup aqui.

DELETE FROM observe_topology_edges t
USING (
  SELECT id
  FROM (
    SELECT
      e.id,
      row_number() OVER (
        PARTITION BY e.tenant_id, e.site_id, e.edge_id, COALESCE(m.keep_id, e.from_asset_id), e.to_asset_ref, e.edge_type, COALESCE(e.protocol, '')
        ORDER BY CASE WHEN m.duplicate_id IS NULL THEN 0 ELSE 1 END, e.observed_at DESC, e.id
      ) AS rn
    FROM observe_topology_edges e
    LEFT JOIN tmp_observe_asset_dedupe m ON m.duplicate_id = e.from_asset_id
    WHERE e.from_asset_id IN (
      SELECT duplicate_id FROM tmp_observe_asset_dedupe
      UNION
      SELECT keep_id FROM tmp_observe_asset_dedupe
    )
  ) ranked
  WHERE rn > 1
) doomed
WHERE t.id = doomed.id;

-- Reatribui referências para o registro canônico.
UPDATE observe_asset_interfaces t
SET asset_id = m.keep_id
FROM tmp_observe_asset_dedupe m
WHERE t.asset_id = m.duplicate_id;

UPDATE observe_asset_services t
SET asset_id = m.keep_id
FROM tmp_observe_asset_dedupe m
WHERE t.asset_id = m.duplicate_id;

UPDATE observe_service_fingerprints t
SET asset_id = m.keep_id
FROM tmp_observe_asset_dedupe m
WHERE t.asset_id = m.duplicate_id;

UPDATE observe_topology_edges t
SET from_asset_id = m.keep_id
FROM tmp_observe_asset_dedupe m
WHERE t.from_asset_id = m.duplicate_id;

UPDATE observe_dependencies t
SET upstream_asset_id = m.keep_id
FROM tmp_observe_asset_dedupe m
WHERE t.upstream_asset_id = m.duplicate_id;

UPDATE observe_dependencies t
SET downstream_asset_id = m.keep_id
FROM tmp_observe_asset_dedupe m
WHERE t.downstream_asset_id = m.duplicate_id;

UPDATE observe_asset_changes t
SET asset_id = m.keep_id
FROM tmp_observe_asset_dedupe m
WHERE t.asset_id = m.duplicate_id;

UPDATE observe_asset_history t
SET asset_id = m.keep_id
FROM tmp_observe_asset_dedupe m
WHERE t.asset_id = m.duplicate_id;

-- Remove os assets duplicados após mover dependências.
DELETE FROM observe_assets a
USING tmp_observe_asset_dedupe m
WHERE a.id = m.duplicate_id;
