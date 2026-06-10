# API Discovery

Base interna do servico discovery: `/api/discovery`

Compatibilidade pela API principal: `/observe/api/discovery/*`

## Endpoints

- `POST /api/discovery/scan`
- `GET /api/discovery/runs`
- `GET /api/discovery/assets`
- `GET /api/discovery/findings`
- `GET /api/discovery/topology`
- `GET /api/discovery/fingerprints`
- `GET /api/discovery/policies`
- `POST /api/discovery/policies`
- `GET /api/discovery/history?asset_id=...`
- `POST /api/discovery/passive/events`
- `GET /api/discovery/prometheus/http-sd`

## UI

- `GET /observe/discovery`

## Exemplo de scan

```json
{
  "tenant_id": "default",
  "site_id": "default-site",
  "edge_id": "central",
  "profile": "safe",
  "trigger": "manual",
  "targets": [
    { "address": "10.10.2.30", "discovery_type": "ip" }
  ]
}
```
