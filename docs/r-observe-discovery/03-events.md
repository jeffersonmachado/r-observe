# Eventos Discovery (Redis/Event Bus)

## Eventos emitidos

- `observe.discovery.started`
- `observe.discovery.completed`
- `observe.discovery.asset_found`
- `observe.discovery.asset_changed`
- `observe.discovery.asset_removed` (reservado para ciclo de desaparecimento)
- `observe.discovery.fingerprint.updated` (reservado)
- `observe.discovery.topology.updated`

## Formato base

```json
{
  "type": "observe.discovery.asset_found",
  "ts": "2026-05-19T10:00:00.000Z",
  "run_id": "...",
  "tenant_id": "default",
  "site_id": "default-site",
  "edge_id": "central",
  "asset_id": "...",
  "asset_key": "ip:10.10.2.30"
}
```
