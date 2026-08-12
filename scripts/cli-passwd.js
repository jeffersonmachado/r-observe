#!/usr/bin/env node
'use strict';

/**
 * CLI: Altera a senha de um usuário no R-Observe/IcingaWeb2.
 * 
 * Uso:
 *   node scripts/cli-passwd.js <username> <nova-senha>
 *   node scripts/cli-passwd.js admin MinhaSenha123
 * 
 * Requer acesso ao PostgreSQL (variáveis de ambiente ou .env.observe).
 */

const path = require('path');
const fs = require('fs');

// Tenta carregar o db client de onde estiver (local ou container)
let createDbClient;
try { createDbClient = require('../r-observe/api/src/db').createDbClient; } catch (_) {}
try { createDbClient = createDbClient || require('../r-observe/shared/db').createDbClient; } catch (_) {}
try { createDbClient = createDbClient || require('./db').createDbClient; } catch (_) {}
try { createDbClient = createDbClient || require('../src/db').createDbClient; } catch (_) {}
try { createDbClient = createDbClient || require('/app/src/db').createDbClient; } catch (_) {}

if (!createDbClient) {
  console.error('Erro: não foi possível carregar o módulo db. Execute dentro do container ou no diretório do projeto.');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso: node scripts/cli-passwd.js <username> <nova-senha>');
    console.log('');
    console.log('  Altera a senha de um usuário no IcingaWeb2 / R-Observe.');
    console.log('  A mesma credencial é usada para login no R-Observe, IcingaWeb2 e Grafana.');
    console.log('');
    console.log('  Requer acesso ao PostgreSQL. Le as variaveis de ambiente:');
    console.log('    OBSERVE_DB_HOST, OBSERVE_DB_PORT, OBSERVE_DB_USER, OBSERVE_DB_PASSWORD, OBSERVE_DB_NAME');
    console.log('');
    console.log('Exemplos:');
    console.log('  node scripts/cli-passwd.js admin novaSenha123');
    console.log('  # Em produção (via SSH):');
    console.log('  ssh root@10.10.2.30 "docker exec -i r-observe-api node scripts/cli-passwd.js admin novaSenha123"');
    process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
  }

  const [username, newPassword] = args;

  if (!username || username.length < 2) {
    console.error('Erro: username deve ter pelo menos 2 caracteres.');
    process.exit(1);
  }
  if (!newPassword || newPassword.length < 4) {
    console.error('Erro: senha deve ter pelo menos 4 caracteres.');
    process.exit(1);
  }

  console.log(`Alterando senha para: ${username}`);

  // Carregar .env se existir (procura em vários locais)
  const possibleEnvFiles = [
    path.join(__dirname, '..', '.env.observe'),
    path.join(__dirname, '..', '..', '.env.observe'),
    '/app/.env.observe',
    '/opt/results/infra/.env.observe',
  ];
  for (const envFile of possibleEnvFiles) {
    if (fs.existsSync(envFile)) {
      const lines = fs.readFileSync(envFile, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx < 0) continue;
        const key = trimmed.substring(0, idx).trim();
        const val = trimmed.substring(idx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
      break; // usa o primeiro encontrado
    }
  }

  // Mapear OBSERVE_DB_* → DB_* (padrão do createDbClient)
  if (process.env.OBSERVE_DB_HOST && !process.env.DB_HOST) process.env.DB_HOST = process.env.OBSERVE_DB_HOST;
  if (process.env.OBSERVE_DB_PORT && !process.env.DB_PORT) process.env.DB_PORT = process.env.OBSERVE_DB_PORT;
  if (process.env.OBSERVE_DB_USER && !process.env.DB_USER) process.env.DB_USER = process.env.OBSERVE_DB_USER;
  if (process.env.OBSERVE_DB_PASSWORD && !process.env.DB_PASSWORD) process.env.DB_PASSWORD = process.env.OBSERVE_DB_PASSWORD;
  if (process.env.OBSERVE_DB_NAME && !process.env.DB_NAME) process.env.DB_NAME = process.env.OBSERVE_DB_NAME;

  const pool = createDbClient(process.env);
  
  try {
    // 1. Verifica se o usuário existe
    const exists = await pool.query(
      `SELECT name, active FROM icingaweb_user WHERE lower(name) = lower($1::text) LIMIT 1`,
      [username]
    );

    if (!exists.rowCount) {
      console.error(`Erro: usuário "${username}" não encontrado.`);
      await pool.end().catch(() => {});
      process.exit(1);
    }

    const user = exists.rows[0];
    console.log(`  Usuário: ${user.name} (ativo: ${user.active})`);

    // 2. Atualiza a senha usando pgcrypto (mesmo método do bootstrap)
    await pool.query(
      `UPDATE icingaweb_user 
       SET password_hash = convert_to(crypt($2::text, gen_salt('bf', 12)), 'UTF8'),
           mtime = NOW()
       WHERE lower(name) = lower($1::text)`,
      [username, newPassword]
    );

    console.log(`  ✅ Senha alterada com sucesso para "${username}".`);
    console.log('');
    
    // Detecta ambiente para mostrar URLs corretas
    // --prod seta OBSERVE_CLI_TARGET=prod; ou defina OBSERVE_PUBLIC_URL
    const isProd = process.env.OBSERVE_CLI_TARGET === 'prod'
      || (process.env.OBSERVE_PUBLIC_URL || '').includes('results.com.br');
    const publicUrl = isProd ? 'https://r-observe.results.com.br' : 'http://localhost:3080';
    const grafanaUrl = isProd ? 'https://r-observe.results.com.br/grafana/' : 'http://localhost:3001';
    
    console.log('A nova senha é válida para:');
    console.log(`  • R-Observe:  ${publicUrl}/observe/login`);
    console.log(`  • IcingaWeb2: ${publicUrl}/icinga/`);
    console.log(`  • Grafana:    ${grafanaUrl} (se configurado)`);

  } catch (e) {
    console.error('Erro ao alterar senha:', e.message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
