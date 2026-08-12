# Deploy remoto por imagens locais

O deploy de producao do R-Observe segue obrigatoriamente este fluxo:

1. validar o Compose no computador local;
2. construir todas as imagens localmente;
3. obter o inventario de imagens dos perfis ativos;
4. comparar o ID de conteudo de cada imagem com o servidor remoto;
5. transferir somente imagens ausentes ou diferentes com
   `docker save | gzip | ssh ... docker load`;
6. sincronizar somente arquivos alterados, preservando `.env.observe` e
   `secrets/` remotos;
7. iniciar o Compose remoto com `--no-build --pull never`;
8. executar healthcheck e smoke test no servidor.

Build no servidor remoto e proibido. Isso inclui `docker build`,
`docker compose build` e `docker compose up --build`. O servidor de producao
deve apenas carregar e executar artefatos produzidos localmente.

## Comando canonico

```bash
npm run observe:deploy:images
```

O destino padrao e `root@10.10.2.30:/opt/results/r-observe`. Variaveis
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_DIR` e `SSH_PASSWORD` podem alterar a
conexao. Autenticacao por chave SSH e usada quando `SSH_PASSWORD` nao existe.

Para reutilizar imagens locais ja construidas:

```bash
npm run observe:deploy:images -- --skip-build
```

As flags `--skip-sync` e `--skip-smoke` existem para recuperacao operacional.
Nenhuma delas habilita build remoto.

## Garantias do script

- falha se uma imagem declarada pelo Compose nao existir localmente;
- falha se as arquiteturas local e remota forem diferentes;
- preserva configuracao e chaves exclusivas do servidor;
- compara IDs Docker locais e remotos e transfere apenas imagens desatualizadas
  ou ausentes;
- pula completamente o `save/load` quando todas as imagens estao atualizadas;
- usa o comportamento incremental do `rsync` para o codigo;
- evita pulls e builds durante a subida remota;
- nunca imprime senhas ou conteudo de chaves.
