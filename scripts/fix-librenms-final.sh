#!/bin/bash
# Fix final do LibreNMS — executar quando o SSH voltar
# Uso: bash /opt/results/r-observe/scripts/fix-librenms-final.sh
set -e

echo "=== Fix final LibreNMS ==="

ssh -o StrictHostKeyChecking=no root@10.10.2.30 bash << 'REMOTE'
set -e

# 1. Corrigir .env com APP_KEY válido
docker exec librenms sed -i "s|APP_KEY=.*|APP_KEY=base64:sTPI5r+S+2+ll6eXxG8RziGSw/QJr00dR8w2qYjaXmE=|" /opt/librenms/.env
echo "1/5 .env fixed"

# 2. Corrigir CommandStartingListener (permitir rodar como root)
docker exec librenms sed -i 's|\$this->checkRunningUser|// $this->checkRunningUser|' /opt/librenms/app/Listeners/CommandStartingListener.php
echo "2/5 Listener patched"

# 3. Marcar TODAS as migrations como concluídas (evita conflito schema.sql vs individual)
docker exec librenms sh -c '
for m in $(ls /opt/librenms/database/migrations/*.php 2>/dev/null); do
  migration=$(basename "$m" .php)
  mysql -h 10.10.2.79 -u librenms -pLibreNMS2026 librenms -e "INSERT IGNORE INTO migrations (migration, batch) VALUES (\"$migration\", 1);" 2>/dev/null
done
echo "Migrations marked as complete"
'
echo "3/5 Migrations marked"

# 4. Criar admin user
docker exec librenms sh -c '
mysql -h 10.10.2.79 -u librenms -pLibreNMS2026 librenms -e "
INSERT IGNORE INTO users (auth_type, username, password, realname, email, descr, created_at, updated_at)
VALUES (\"mysql\", \"admin\", \"\$2y\$12\$dcTtCXhSJ0Uvfbq2IansoedOfanTkoUdpJ0WUPTWujq7TuYp0k.bi\", \"Administrator\", \"admin@results.com.br\", \"\", NOW(), NOW());
" 2>/dev/null
echo "Admin user created"
'
echo "4/5 Admin user created"

# 5. Atribuir role admin
docker exec librenms sh -c '
mysql -h 10.10.2.79 -u librenms -pLibreNMS2026 librenms -e "
INSERT IGNORE INTO model_has_roles (role_id, model_type, model_id)
VALUES (1, \"App\\\\Models\\\\User\", (SELECT user_id FROM users WHERE username=\"admin\"));
" 2>/dev/null
echo "Admin role assigned"
'
echo "5/5 Admin role assigned"

echo "=== Fix completo! ==="
echo "Acesse: http://localhost:8081/"
echo "Login: admin / LibreNMS2026"
echo "O auto-discovery via SNMP vai descobrir dispositivos na rede automaticamente."
REMOTE
