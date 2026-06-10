'use strict';

// ─── Catálogo centralizado de modelos e providers de IA ──────────────────────
// Usado por r-observe-api e r-observe-ai para evitar duplicação.

const VALID_AI_PROVIDERS = ['openai', 'deepseek', 'anthropic', 'mock'];

const AI_AUTO_MODELS = {
  openai: 'gpt-4o-mini',
  deepseek: 'deepseek-chat',
  anthropic: 'claude-haiku-4-5-20251001',
  mock: '',
};

const AI_STATIC_MODELS = {
  openai: [
    'chatgpt-4o-latest',
    'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro',
    'gpt-5.1', 'gpt-5.2', 'gpt-5.4', 'gpt-5.5',
    'gpt-4.5-preview',
    'gpt-4o', 'gpt-4o-mini', 'gpt-4o-search-preview',
    'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
    'gpt-4-turbo', 'gpt-4',
    'gpt-3.5-turbo',
    'o1', 'o1-pro', 'o1-mini', 'o1-preview',
    'o3', 'o3-mini',
    'o4-mini',
  ],
  anthropic: [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229',
    'claude-3-sonnet-20240229',
    'claude-3-haiku-20240307',
  ],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  mock: [],
};

const OPENAI_CHAT_PREFIXES = ['chat-latest', 'chatgpt', 'gpt-3', 'gpt-4', 'gpt-5', 'o1', 'o2', 'o3', 'o4'];
const OPENAI_EXCLUDE_PARTS = ['-audio', '-realtime', '-transcribe', '-tts', '-image', '-search-api', 'babbage', 'davinci', 'whisper', 'embedding', 'moderation', 'sora'];

// ─── Catálogo de referência de remediação (generalista) ─────────────────────
// A IA pode sugerir qualquer ação, inclusive fora desta lista.
// O namespace é livre: "categoria:alvo" ou "categoria:alvo:subalvo".
// Use este catálogo como inspiração, não como limite.
const REMEDIATION_CATALOG = [
  // ── Containers (Docker/Podman) ──
  { action: 'docker:start',            description: 'Inicia container parado',                     risk: 'low' },
  { action: 'docker:restart',          description: 'Reinicia container (com downtime)',            risk: 'medium' },
  { action: 'docker:stop',             description: 'Para container em execução',                   risk: 'medium' },
  { action: 'docker:kill',             description: 'Força parada do container (SIGKILL)',          risk: 'high' },
  { action: 'docker:logs',             description: 'Coleta logs recentes do container',            risk: 'none' },
  { action: 'docker:inspect',          description: 'Inspeciona configuração do container',         risk: 'none' },
  { action: 'docker:prune',            description: 'Remove containers/imagens/volumes órfãos',     risk: 'medium' },
  { action: 'docker:pull',             description: 'Atualiza imagem (pull) do container',          risk: 'low' },
  { action: 'docker:exec',             description: 'Executa comando arbitrário dentro do container', risk: 'high' },
  { action: 'docker:stats',            description: 'Coleta métricas de CPU/memória do container',  risk: 'none' },

  // ── Systemd / Init ──
  { action: 'systemd:restart',         description: 'Reinicia unidade systemd',                    risk: 'medium' },
  { action: 'systemd:stop',            description: 'Para unidade systemd',                         risk: 'medium' },
  { action: 'systemd:start',           description: 'Inicia unidade systemd',                       risk: 'low' },
  { action: 'systemd:reload',          description: 'Recarrega configuração (SIGHUP)',              risk: 'low' },
  { action: 'systemd:status',          description: 'Verifica status da unidade systemd',           risk: 'none' },
  { action: 'systemd:enable',          description: 'Habilita unidade para iniciar no boot',        risk: 'low' },
  { action: 'systemd:disable',         description: 'Desabilita unidade do boot',                   risk: 'low' },
  { action: 'systemd:daemon-reload',   description: 'Recarrega definições de unidades systemd',     risk: 'low' },
  { action: 'systemd:journal',         description: 'Coleta logs do journal (journalctl)',          risk: 'none' },

  // ── Processos ──
  { action: 'process:restart',         description: 'Reinicia processo por PID ou nome',           risk: 'medium' },
  { action: 'process:kill',            description: 'Encerra processo (SIGTERM ou SIGKILL)',       risk: 'high' },
  { action: 'process:signal',          description: 'Envia sinal específico a um processo',        risk: 'medium' },
  { action: 'process:strace',          description: 'Rastreia chamadas de sistema do processo',    risk: 'none' },
  { action: 'process:lsof',            description: 'Lista arquivos abertos pelo processo',        risk: 'none' },

  // ── Rede ──
  { action: 'network:check',           description: 'Testa conectividade (ping/traceroute/nc)',    risk: 'none' },
  { action: 'network:bandwidth',       description: 'Mede largura de banda disponível',            risk: 'none' },
  { action: 'network:restart-iface',   description: 'Reinicia interface de rede',                  risk: 'high' },
  { action: 'network:flush-routes',    description: 'Limpa tabela de rotas',                       risk: 'high' },
  { action: 'network:firewall-allow',  description: 'Adiciona regra temporária no firewall',       risk: 'high' },

  // ── DNS ──
  { action: 'dns:flush',               description: 'Limpa cache DNS local',                      risk: 'low' },
  { action: 'dns:test-resolution',     description: 'Testa resolução de nome específico',         risk: 'none' },
  { action: 'dns:switch-server',       description: 'Troca servidor DNS temporariamente',         risk: 'medium' },

  // ── HTTP / APIs ──
  { action: 'http:retry',              description: 'Re-tenta requisição HTTP com backoff',       risk: 'none' },
  { action: 'http:healthcheck',        description: 'Verifica endpoint de health',                 risk: 'none' },
  { action: 'http:circuit-break',      description: 'Abre circuit breaker para o serviço',        risk: 'medium' },
  { action: 'http:flush-cache',        description: 'Limpa cache HTTP (Varnish/Nginx/CF)',        risk: 'low' },
  { action: 'http:rate-limit',         description: 'Ajusta limite de taxa temporário',           risk: 'medium' },

  // ── Bancos de Dados ──
  { action: 'postgres:vacuum',         description: 'Executa VACUUM no PostgreSQL',               risk: 'low' },
  { action: 'postgres:analyze',        description: 'Atualiza estatísticas (ANALYZE)',             risk: 'low' },
  { action: 'postgres:reindex',        description: 'Reconstrói índices (REINDEX)',                risk: 'medium' },
  { action: 'postgres:kill-query',     description: 'Cancela query longa (pg_terminate_backend)', risk: 'medium' },
  { action: 'postgres:connection-pool', description: 'Ajusta pool de conexões',                   risk: 'medium' },
  { action: 'mysql:flush-tables',      description: 'Flush de tabelas/query cache',               risk: 'medium' },
  { action: 'mysql:repair',            description: 'Repara tabela corrompida',                    risk: 'high' },
  { action: 'mysql:kill-query',        description: 'Mata query bloqueada',                        risk: 'medium' },
  { action: 'redis:ping',              description: 'Verifica conectividade Redis',                risk: 'none' },
  { action: 'redis:flush-db',          description: 'Limpa banco Redis (cuidado: destrutivo)',    risk: 'high' },
  { action: 'redis:failover',          description: 'Força failover no Redis Sentinel/Cluster',    risk: 'high' },
  { action: 'mongodb:stepdown',        description: 'Força stepdown do primary MongoDB',           risk: 'high' },
  { action: 'elasticsearch:flush',     description: 'Força flush de segmentos do ES',              risk: 'low' },

  // ── Armazenamento / Disco ──
  { action: 'disk:cleanup',            description: 'Remove arquivos temporários e logs antigos', risk: 'medium' },
  { action: 'disk:resize',             description: 'Expande volume/partição',                     risk: 'high' },
  { action: 'disk:fsck',               description: 'Verifica e repara sistema de arquivos',      risk: 'high' },
  { action: 'disk:mount',              description: 'Remonta volume com opções diferentes',       risk: 'medium' },
  { action: 'disk:iostat',             description: 'Coleta estatísticas de I/O',                 risk: 'none' },
  { action: 'disk:inode-check',        description: 'Verifica uso de inodes',                      risk: 'none' },

  // ── Memória ──
  { action: 'memory:drop-caches',      description: 'Libera cache de páginas do kernel',          risk: 'medium' },
  { action: 'memory:oom-score',        description: 'Ajusta prioridade OOM de processo',          risk: 'high' },
  { action: 'memory:swap-toggle',      description: 'Ativa/desativa swap temporariamente',        risk: 'high' },

  // ── Kubernetes ──
  { action: 'kubernetes:rollout',      description: 'Rollout restart de deployment/statefulset',  risk: 'medium' },
  { action: 'kubernetes:scale',        description: 'Ajusta réplicas de deployment',              risk: 'medium' },
  { action: 'kubernetes:cordon',       description: 'Isola nó (cordon) para manutenção',          risk: 'medium' },
  { action: 'kubernetes:drain',        description: 'Drena pods de um nó',                        risk: 'high' },
  { action: 'kubernetes:delete-pod',   description: 'Remove pod problemático (será recriado)',    risk: 'medium' },
  { action: 'kubernetes:describe',     description: 'Coleta describe de recurso',                  risk: 'none' },
  { action: 'kubernetes:top',          description: 'Coleta uso de recursos (kubectl top)',        risk: 'none' },
  { action: 'kubernetes:cert-rotate',  description: 'Rotaciona certificados do cluster',          risk: 'high' },

  // ── Cloud (AWS/GCP/Azure) ──
  { action: 'cloud:reboot-instance',   description: 'Reinicia instância cloud',                    risk: 'high' },
  { action: 'cloud:resize-instance',   description: 'Altera tipo de instância (scale up/down)',    risk: 'high' },
  { action: 'cloud:snapshot',          description: 'Cria snapshot de volume antes de operação',  risk: 'low' },
  { action: 'cloud:restore-snapshot',  description: 'Restaura volume de snapshot',                 risk: 'high' },
  { action: 'cloud:failover-region',   description: 'Ativa failover para outra região',            risk: 'high' },
  { action: 'cloud:update-dns',        description: 'Atualiza registro DNS (Route53/CloudDNS)',   risk: 'medium' },
  { action: 'cloud:detach-disk',       description: 'Desanexa volume problemático',                risk: 'high' },

  // ── Load Balancers / Proxy ──
  { action: 'lb:drain-backend',        description: 'Remove backend do pool de balanceamento',    risk: 'medium' },
  { action: 'lb:add-backend',          description: 'Adiciona backend ao pool',                    risk: 'low' },
  { action: 'lb:health-check',         description: 'Força health check no backend',              risk: 'low' },
  { action: 'nginx:reload',            description: 'Recarrega configuração do Nginx',            risk: 'low' },
  { action: 'nginx:rotate-logs',       description: 'Rotaciona logs do Nginx',                     risk: 'none' },
  { action: 'haproxy:enable-backend',  description: 'Habilita backend no HAProxy',                risk: 'low' },
  { action: 'haproxy:disable-backend', description: 'Desabilita backend no HAProxy (drain)',      risk: 'medium' },

  // ── Mensageria / Filas ──
  { action: 'rabbitmq:purge-queue',    description: 'Limpa fila acumulada no RabbitMQ',           risk: 'medium' },
  { action: 'rabbitmq:restart-vhost',  description: 'Reinicia vhost do RabbitMQ',                  risk: 'medium' },
  { action: 'kafka:reassign',          description: 'Reatribui partições no Kafka',                risk: 'medium' },
  { action: 'kafka:throttle',          description: 'Aplica throttle em producer/consumer',        risk: 'medium' },

  // ── Monitoramento / Observabilidade ──
  { action: 'prometheus:reload',       description: 'Recarrega configuração do Prometheus',       risk: 'low' },
  { action: 'prometheus:snapshot',     description: 'Cria snapshot TSDB do Prometheus',           risk: 'low' },
  { action: 'prometheus:delete-series',description: 'Remove séries temporais problemáticas',      risk: 'medium' },
  { action: 'grafana:reset-alert',     description: 'Reseta estado de alerta no Grafana',         risk: 'low' },
  { action: 'icinga:reschedule',       description: 'Reagenda check no Icinga2',                  risk: 'none' },
  { action: 'icinga:acknowledge',      description: 'Reconhece alerta no Icinga2',                risk: 'none' },
  { action: 'icinga:silence',          description: 'Silencia alertas por período (downtime)',    risk: 'low' },
  { action: 'icinga:add-comment',      description: 'Adiciona comentário a host/serviço',         risk: 'none' },
  { action: 'icinga:add-host',         description: 'Registra host descoberto no Icinga2',        risk: 'low' },
  { action: 'alertmanager:silence',    description: 'Cria silence no Alertmanager',                risk: 'low' },

  // ── Segurança / Certificados ──
  { action: 'cert:renew',              description: 'Força renovação de certificado TLS',         risk: 'medium' },
  { action: 'cert:revoke',             description: 'Revoga certificado comprometido',             risk: 'high' },
  { action: 'firewall:block-ip',       description: 'Bloqueia IP malicioso temporariamente',       risk: 'medium' },
  { action: 'firewall:unblock-ip',     description: 'Remove bloqueio de IP',                       risk: 'low' },
  { action: 'ssh:rotate-keys',         description: 'Rotaciona chaves SSH do host',                risk: 'high' },

  // ── Aplicação (genérico) ──
  { action: 'app:deploy-rollback',     description: 'Rollback para versão anterior',               risk: 'high' },
  { action: 'app:feature-flag',        description: 'Desativa feature via flag (circuit break)',   risk: 'medium' },
  { action: 'app:clear-cache',         description: 'Limpa cache da aplicação',                    risk: 'low' },
  { action: 'app:run-migration',       description: 'Executa migração pendente de banco',          risk: 'high' },
  { action: 'app:restart-workers',     description: 'Reinicia workers de background',              risk: 'medium' },
  { action: 'app:maintenance-on',      description: 'Ativa modo de manutenção',                     risk: 'medium' },
  { action: 'app:maintenance-off',     description: 'Desativa modo de manutenção',                  risk: 'low' },

  // ── Sistema Operacional ──
  { action: 'os:reboot',               description: 'Reinicia o sistema operacional',              risk: 'high' },
  { action: 'os:update-packages',      description: 'Atualiza pacotes do SO (security patches)',   risk: 'medium' },
  { action: 'os:kernel-param',         description: 'Ajusta parâmetro do kernel (sysctl)',         risk: 'high' },
  { action: 'os:ntp-sync',             description: 'Força sincronização de relógio (NTP)',       risk: 'low' },
  { action: 'os:limits',               description: 'Ajusta ulimits (nofile/nproc)',              risk: 'medium' },
];

// ─── System prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT =
  'Você é um especialista sênior em SRE e operações de infraestrutura. ' +
  'Analise incidentes de forma objetiva e concisa em português. ' +
  'REGRAS OBRIGATÓRIAS:\n' +
  '1. Sua causa DEVE ser baseada exclusivamente no output do check deste incidente — ' +
  'NUNCA infira causalidade a partir de outros incidentes do histórico.\n' +
  '2. O histórico serve apenas para identificar padrões de recorrência, não como evidência causal.\n' +
  '3. Se o output do check não contiver informação suficiente para determinar a causa, ' +
  'diga "causa indeterminada com os dados disponíveis" e sugira próximos passos de investigação.\n' +
  '4. Nunca invente informações que não estejam no contexto direto do incidente.\n' +
  '5. Suas sugestões devem ser acionáveis, específicas e realistas.\n\n' +
  'REMEDIAÇÃO (IMPORTANTE):\n' +
  '- O catálogo de referência contém EXEMPLOS de ações comuns. Você NÃO está limitado a ele.\n' +
  '- Use o namespace "categoria:alvo" ou "categoria:alvo:subalvo" livremente.\n' +
  '- Exemplos de categorias: docker, systemd, process, network, dns, http, postgres, mysql, redis, ' +
  'mongodb, elasticsearch, kubernetes, cloud, disk, memory, nginx, haproxy, rabbitmq, kafka, ' +
  'prometheus, grafana, icinga, alertmanager, cert, firewall, ssh, app, os, lb.\n' +
  '- Para qualquer tecnologia não listada, invente o namespace apropriado (ex: "tomcat:restart", "cron:disable-job").\n' +
  '- O campo "params" deve ser um objeto com os parâmetros necessários para executar a ação.\n\n' +
  'CONFIDENCE_SCORE:\n' +
  '- Ações de baixo risco e alta certeza: score >= 0.85 (execução automática).\n' +
  '- Ações destrutivas ou situações ambíguas: score <= 0.5 (requer aprovação humana).\n' +
  '- Use "remediation: null" se nenhuma ação for aplicável ou se não houver certeza suficiente.';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveModel(provider, model) {
  if (!model || model === 'auto') return AI_AUTO_MODELS[provider] || '';
  return model;
}

/**
 * Ordena modelos do mais recente para o mais antigo.
 * Score: família × 1000 + versão minor × 100 + variante (pro>base>mini>nano) − penalidade dated.
 */
function sortModelsByRecency(models) {
  function score(id) {
    const dated = /\d{4}-\d{2}/.test(id) ? -2 : 0;
    const variant = id.includes('-pro') || id.includes('-max') ? 3
      : !(id.includes('-mini') || id.includes('-nano') || id.includes('-codex')) ? 2
      : id.includes('-mini') ? 1
      : 0;

    const g5 = id.match(/^gpt-5(?:\.(\d+))?/);
    if (g5) return 5000 + parseInt(g5[1] ?? 0) * 100 + variant + dated;

    const o = id.match(/^o(\d+(?:\.\d+)?)/);
    if (o) return 4500 + parseFloat(o[1]) * 10 + variant + dated;

    if (id.startsWith('chat')) return 4300 + dated;

    const g4x = id.match(/^gpt-4\.(\d+)/);
    if (g4x) return 4100 + parseInt(g4x[1]) * 10 + variant + dated;

    if (id.startsWith('gpt-4o')) return 4020 + variant + dated;
    if (id.startsWith('gpt-4-turbo')) return 4010 + dated;
    if (id.startsWith('gpt-4')) return 4000 + variant + dated;
    if (id.startsWith('gpt-3')) return 3500 + variant + dated;

    return 0;
  }
  return [...models].sort((a, b) => score(b) - score(a));
}

module.exports = {
  VALID_AI_PROVIDERS,
  AI_AUTO_MODELS,
  AI_STATIC_MODELS,
  OPENAI_CHAT_PREFIXES,
  OPENAI_EXCLUDE_PARTS,
  REMEDIATION_CATALOG,
  SYSTEM_PROMPT,
  resolveModel,
  sortModelsByRecency,
};
