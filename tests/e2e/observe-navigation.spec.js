'use strict';

// @ts-check
const { test, expect } = require('@playwright/test');

const USER = process.env.ICINGAWEB_ADMIN_USER || '';
const PASS = process.env.ICINGAWEB_ADMIN_PASS || '';

test.skip(!USER || !PASS, 'Defina as credenciais administrativas para os testes autenticados.');

async function login(page, next = '/observe/home') {
  await page.goto(`/observe/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Usuário').fill(USER);
  await page.getByLabel('Senha').fill(PASS);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(url => url.pathname === next);
}

test('links navegáveis do R-Observe não terminam em 404 ou 5xx', async ({ page, request }) => {
  await login(page);
  const paths = new Set(['/observe/home', '/observe/settings', '/observe/ai', '/observe/discovery']);

  for (const source of [...paths]) {
    await page.goto(source);
    await expect(page.locator('body')).not.toContainText('404 Not Found');
    const discovered = await page.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href')));
    for (const href of discovered) {
      if (!href || !href.startsWith('/observe/') || href.startsWith('/observe/api/')) continue;
      paths.add(new URL(href, 'http://localhost').pathname);
    }
  }

  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  for (const path of paths) {
    const response = await request.get(path, { headers: { Cookie: cookieHeader }, maxRedirects: 0 });
    expect(response.status(), `${path} não deve retornar erro`).toBeLessThan(400);
  }
});

test('telas principais não criam overflow horizontal em celular', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await login(page);

  for (const path of ['/observe/home', '/observe/settings', '/observe/ai']) {
    await page.goto(path);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow, `${path} não deve exigir rolagem horizontal`).toBe(false);
  }
});
