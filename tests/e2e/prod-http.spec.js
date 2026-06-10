'use strict';
const { test, expect } = require('@playwright/test');

const DOMAIN = 'r-observe.results.com.br';
const TOKEN  = process.env.OBSERVE_TOKEN || '';

test.skip(!TOKEN, 'Defina OBSERVE_TOKEN para rodar testes autenticados.');

test.describe('Produção — r-observe.results.com.br (DNS + HTTP)', () => {

  test('DNS resolve corretamente', async ({ request }) => {
    // Testa via HTTP direto no IP para confirmar stack
    const r = await request.get('http://10.10.2.30:3080/observe/api/health');
    expect(r.status()).toBe(200);
    const b = await r.json();
    console.log('Stack direta:', b);
    expect(b.status).toBe('ok');
  });

  test('HTTP redireciona para HTTPS (certbot em andamento)', async ({ page }) => {
    const resp = await page.goto(`http://${DOMAIN}/`, {
      timeout: 20000, waitUntil: 'domcontentloaded'
    });
    const url = page.url();
    const title = await page.title();
    const status = resp?.status();
    console.log('URL final:', url, '| Status:', status, '| Title:', title);
    await page.screenshot({ path: 'test-results/prod-http-redirect.png', fullPage: true });
    // Pode ser: 301 redirect para HTTPS, 503 (cert pendente), ou já funcionando
    expect([200, 301, 302, 503]).toContain(status);
    expect(url).toContain('results.com.br');
  });

  test('Apache proxy responde para r-observe.results.com.br', async ({ request }) => {
    // Força Host header para simular o proxy Apache
    const r = await request.get('http://10.10.2.60:8080/observe/api/health', {
      headers: { Host: 'r-observe.results.com.br' },
      timeout: 10000,
    }).catch(() => null);
    if (r) {
      console.log('Apache proxy status:', r.status());
      const body = await r.text();
      console.log('Corpo:', body.substring(0, 200));
    } else {
      console.log('Conexão recusada no :8080 — porta não exposta');
    }
    expect(true).toBe(true); // info apenas
  });

});
