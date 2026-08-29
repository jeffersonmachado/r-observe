# @results/whatsapp-qr-bridge

Núcleo compartilhado de bridge WhatsApp via QR Code, extraído/generalizado do
r-agent2 (`api/services/whatsappQrBridgeService.js`). CommonJS, Node >= 18, sem
TypeScript.

O pacote gerencia **somente** o ciclo de vida dos clientes
[whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) (multi-conexão,
QR, status, envio de texto/mídia, eventos). Persistência (banco,
`tenant_settings`), WebSocket, tickets e recuperação de mensagens não-lidas são
responsabilidade do consumidor, que reage aos eventos emitidos.

## Instalação (via `file:`)

No `package.json` do projeto consumidor (r-agent2, r-observe):

```json
{
  "dependencies": {
    "@results/whatsapp-qr-bridge": "file:../packages/whatsapp-qr-bridge",
    "whatsapp-web.js": "^1.34.6"
  }
}
```

`whatsapp-web.js` é **peerDependency opcional**: o pacote só a carrega em
runtime (require lazy dentro da factory padrão), então testes com
`clientFactory` injetado não puxam puppeteer/Chrome. Instale-a no projeto
consumidor. O QR é convertido em data URL localmente com `qrcode` (sem
api.qrserver.com).

## Uso

```js
const { createBridge } = require('@results/whatsapp-qr-bridge');

const bridge = createBridge({
  authDataPath: '/var/lib/meuapp/whatsapp/auth', // dataPath do LocalAuth
  syncIntervalMs: 30000,                          // default 30000; 0 desliga
  // clientFactory: ({ clientId, dataPath, connectionId, puppeteer, webVersion, webVersionCacheDir, userAgent, deviceName }) => client,
  // puppeteer: { headless: true, args: [...] },
  // webVersion: undefined/null → sem pin (WA Web latest, default); '<versao>' → pin custom
  // webVersionCacheDir: '/dir/com/<versao>.html',  // default: wa-web/ do pacote
  // userAgent: undefined/'auto' → UA com a versão real do Chrome (default);
  //   'default' → spoof nativo da lib; false → UA genuíno do binário; string → como está
  // deviceName: 'R-Observe',  // nome do aparelho sugerido no pareamento (só
  //   vale para NOVOS pareamentos; o WhatsApp não devolve à sessão o nome
  //   exibido em "Aparelhos conectados", então fixá-lo é a única forma de a
  //   sessão ser auto-identificável)
  // sendTimeoutMs: 60000,     // timeout anti-zumbi de envio (0 desliga)
  // logger: console,
});

bridge.on('qr', ({ connectionId, qrText, qrDataUrl, expiresAt }) => {
  // persistir/exibir o QR (qrDataUrl é data:image/png;base64,...)
});

bridge.on('status', ({ connectionId, status }) => {
  // status ∈ pairing | connected | ready | disconnected | error
});

bridge.on('ready', ({ connectionId }) => {
  // sessão pronta — aqui o consumidor decide se recupera não-lidas etc.
});

bridge.on('message', ({ connectionId, from, body, hasMedia, raw }) => {
  // mensagens fromMe NÃO são emitidas
});

bridge.on('error', ({ connectionId, error }) => { /* ... */ });

await bridge.addConnection({ id: 'conn-1' });           // inicia o cliente
await bridge.requestQr('conn-1');                        // força novo QR
await bridge.sendText('conn-1', '+55 11 99999-0000', 'olá');
await bridge.sendMedia('conn-1', '5511999990000', {
  data: '<base64 ou Buffer>', mimeType: 'image/png', fileName: 'foto.png', caption: 'opcional',
});
await bridge.disconnect('conn-1');                       // logout + destroy
await bridge.removeConnection('conn-1');                 // remove do bridge
await bridge.stop();                                     // para sync e destrói tudo
```

## Pin de versão do WhatsApp Web (escape hatch)

O whatsapp-web.js já sofreu quebras por rollout de builds novos do WhatsApp
Web (ex.: wwebjs#127084 — `authenticated` dispara, `ready` nunca). Para esses
casos o pacote permite pinar um build específico:

- `webVersion` **não informado** → **sem pin** (default; WA Web mais recente);
- `webVersion: '<versao>'` → pin custom; exige `<versao>.html` em
  `webVersionCacheDir` (default: `wa-web/` do pacote).

ATENÇÃO: pin só funciona enquanto o WhatsApp mantiver os assets do build no
CDN. Builds antigos são removidos e a página morre no boot (sem CSS, o
initialize falha com `auth timeout`). Use pin apenas como medida temporária,
com um build recente o bastante para ainda estar no ar.

`resolveWebVersionOptions({ webVersion, webVersionCacheDir })` é exportada
para que `clientFactory` customizadas apliquem a mesma lógica:

```js
const { resolveWebVersionOptions } = require('@results/whatsapp-qr-bridge');
const client = new Client({
  authStrategy: new LocalAuth({ clientId, dataPath }),
  ...resolveWebVersionOptions({ webVersion, webVersionCacheDir }),
});
```

Sem pin, passe também o `dataPath`
(`resolveWebVersionOptions({ dataPath })`): o default da lib é persistir o
`index.html` servido em `./.wwebjs_cache` (relativo ao CWD) — em container
com CWD read-only o persist morre com EACCES no meio do handler de
`authenticated` e a sessão fica presa em `connected` sem erro (prod,
ago/2026). Com `dataPath` o cache vai para `<dataPath>/.wwebjs_cache`.

## User-Agent do Chrome (anti-LOGOUT da Meta)

O default do whatsapp-web.js é um fingerprint congelado (Chrome 101 em macOS
10.14, de 2022). Desde o endurecimento anti-automação da Meta (2025-11 em
diante), sessões pareadas com esse UA impossível (binário real Chrome 14x + UA
Chrome 101) são derrubadas com LOGOUT minutos após o pareamento — verificado
em prod e local (ago/2026), enquanto o WA Web oficial (UA real do browser)
permanece estável.

Por isso o pacote resolve o `userAgent` assim:

- `userAgent` **não informado** ou `'auto'` → **detecta a versão real** do
  binário do Chrome (`--version`) e monta um UA coerente com a plataforma
  (default); se nenhum binário for encontrado, usa `false` (UA genuíno do
  binário, sem spoof da lib);
- `userAgent: 'default'` → spoof nativo da lib (escape hatch p/ comparar);
- `userAgent: false` → desliga o spoof da lib;
- qualquer outra string → usada como está.

`resolveUserAgent({ userAgent, executablePath })` é exportada para que
`clientFactory` customizadas apliquem a mesma lógica.

## Watchdog de `ready` (anti-race de injeção)

Há um race no whatsapp-web.js em que `authenticated` dispara mas a injeção do
`window.WWebJS` (LoadUtils) falha uma única vez no meio do sync inicial e a
lib não tenta de novo — a sessão fica presa em `connected` para sempre
(observado em prod ago/2026, WA Web 2.3000.1045288154 + wwebjs main 942d236).

O bridge arma um watchdog a cada `authenticated`: se `ready` não disparar em
`readyWatchdogMs` (default **60s**, `0` desliga), ele chama
`window.onAppStateHasSyncedEvent()` na página, o que refaz o fluxo de injeção
da própria lib. Até 3 tentativas, com log a cada kick.

## Timeout de envio (anti-sessão-zumbi)

Uma sessão morta remotamente (ex.: aparelho removido em "Aparelhos
conectados" do celular) pode **não disparar evento algum** — o cliente segue
`ready` na tela, mas `sendMessage` trava para sempre (verificado em prod,
ago/2026: remoção do aparelho → `sendText` pendente por 10min+, sem erro).

O bridge envolve `sendText`/`sendMedia` com `sendTimeoutMs` (default **60s**,
`0` desliga). No timeout:

1. o envio falha com `qr_send_failed` / `send_timeout_<ms>ms`;
2. a conexão vai para status `error` e o cliente é destruído;
3. o sync periódico o reinicia: sessão ainda válida volta ao `ready`; sessão
   invalidada pela Meta gera **QR novo** automaticamente.

## API

`createBridge(options)` → bridge (EventEmitter + métodos):

- `addConnection({ id, sessionPath? })` → registra e inicia o cliente.
  `sessionPath` sobrescreve o `authDataPath` do bridge para esta conexão.
- `removeConnection(id)` → destrói o cliente e remove o registro.
- `listConnections()` → `[{ id, clientId, status, ready, sessionPath, createdAt, updatedAt }]`.
- `getStatus(id)` → `{ ok, connectionId, status, ready, updatedAt }` ou `{ ok: false, error: 'not_found' }`.
- `requestQr(id)` → destrói o cliente atual e inicia um novo (novo QR via evento).
- `sendText(id, to, text)` → `to` é normalizado para `<digits>@c.us`
  (JIDs com `@` são preservados). Rejeita com `client_not_ready` se a conexão
  não está `ready`.
- `sendMedia(id, to, { data, mimeType, fileName, caption? })` → idem.
- `disconnect(id)` → `logout()` + `destroy()`; a conexão fica registrada mas
  inativa (o sync não a reinicia).
- `stop()` → para o sync periódico e destrói todos os clientes.

Eventos (`bridge.on(...)`):

| Evento    | Payload                                                        |
|-----------|----------------------------------------------------------------|
| `qr`      | `{ connectionId, qrText, qrDataUrl, expiresAt }`               |
| `status`  | `{ connectionId, status, reason? }`                            |
| `ready`   | `{ connectionId }`                                             |
| `message` | `{ connectionId, from, body, hasMedia, raw }`                  |
| `error`   | `{ connectionId, error }`                                      |

Notas:

- O `clientId` do LocalAuth é sanitizado (`waqr_<id>`, apenas `[a-zA-Z0-9_-]`).
- Locks do Chrome (`SingletonLock`, `SingletonSocket`, `SingletonCookie`,
  `DevToolsActivePort`) são removidos do diretório de sessão antes de cada
  `initialize()`.
- `syncIntervalMs` (default 30000, `0` desliga) reconcilia clientes ativos com
  as conexões registradas, reiniciando clientes de conexões ativas que ficaram
  sem cliente.
- Com `clientFactory` injetado, `sendMedia` usa um objeto simples
  `{ mimetype, data, filename }` em vez de `MessageMedia` (que exige a lib real).

## Testes

```bash
npm install
npm test   # node --test tests/*.test.js — usa FakeClient, sem Chrome/rede
```
