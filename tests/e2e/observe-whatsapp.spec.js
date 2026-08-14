'use strict';

// @ts-check
const { test, expect } = require('@playwright/test');

const USER = process.env.ICINGAWEB_ADMIN_USER || '';
const PASS = process.env.ICINGAWEB_ADMIN_PASS || '';

test.skip(!USER || !PASS, 'Defina ICINGAWEB_ADMIN_USER e ICINGAWEB_ADMIN_PASS para os testes autenticados.');

async function login(page) {
  await page.goto('/observe/login?next=/observe/settings');
  await page.getByLabel('Usuário').fill(USER);
  await page.getByLabel('Senha').fill(PASS);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(url => url.pathname === '/observe/settings' && !url.searchParams.has('next'));
}

async function openWhatsAppTab(page) {
  const tab = page.getByRole('tab', { name: /WhatsApp/ });
  await expect(tab).toBeEnabled();
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toContainText('Notificações via WhatsApp Business');
}

test.describe('R-Observe · integração WhatsApp', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('aba WhatsApp reflete a configuração salva no banco', async ({ page }) => {
    await openWhatsAppTab(page);

    await expect(page.locator('#tog-wa_enabled')).toBeChecked();
    await expect(page.locator('#wa-phone')).not.toHaveValue('');
    await expect(page.locator('#wa-recipient')).toHaveValue(/^\d{10,15}$/);
    await expect(page.locator('#wa-severity')).toHaveValue('critical');
    // Token salvo nunca é exibido: campo vazio com placeholder "mantido".
    await expect(page.locator('#wa-token')).toHaveValue('');
    await expect(page.locator('#wa-token')).toHaveAttribute('placeholder', /mantido/);
    await expect(page.locator('#wa-webhook-url')).toHaveValue(/\/observe\/api\/whatsapp\/webhook$/);
    await expect(page.locator('#wa-webhook-url')).toHaveAttribute('readonly', '');
    // Verify token é visível; app secret nunca é reexibido (campo vazio).
    await expect(page.locator('#wa-verify-token')).toBeVisible();
    await expect(page.locator('#wa-app-secret')).toHaveValue('');
  });

  test('card de status consolida o estado do canal WhatsApp', async ({ page }) => {
    const card = page.locator('#st-whatsapp');
    await expect(card).not.toHaveText('—', { timeout: 15000 });
    const value = (await card.textContent() || '').trim();
    console.log(`STATUS_CARD_WHATSAPP=${value}`);
    expect(['Ativo', 'Inativo', 'Incompleto', 'Token inválido']).toContain(value);
  });

  test('lista de auditoria de mensagens é exibida na aba Mensagens', async ({ page }) => {
    const tab = page.getByRole('tab', { name: /Mensagens/ });
    await expect(tab).toBeEnabled();
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#wa-msg-direction')).toBeVisible();
    await expect(page.locator('#wa-msg-kind')).toBeVisible();
    await expect(page.locator('#wa-msg-status')).toBeVisible();
    await expect(page.locator('#wa-msg-q')).toBeVisible();
    const box = page.locator('#wa-messages');
    await expect(box).toBeVisible();
    // Com registros: tabela com colunas de auditoria. Sem registros: hint informativo.
    const table = box.locator('table');
    if (await table.count()) {
      await expect(table.first()).toContainText('Quando');
      await expect(table.first()).toContainText('Status');
    } else {
      await expect(box).toContainText(/Nenhuma mensagem|Falha ao carregar/);
    }
  });

  test('seção Canal QR (alternativo) é exibida na aba WhatsApp', async ({ page }) => {
    await openWhatsAppTab(page);

    await expect(page.locator('#wa-qr-box')).toBeVisible();
    // O input do toggle é oculto pelo CSS (o slider é o elemento visual).
    await expect(page.locator('#tog-wa_qr_enabled')).toBeAttached();
    await expect(page.locator('#wa-qr-connect-btn')).toBeVisible();
    await expect(page.locator('#wa-qr-disconnect-btn')).toBeVisible();
    await expect(page.locator('#wa-qr-status')).toContainText(/Aguardando|Autenticado|Conectado|Desconectado|Erro|—/, { timeout: 15000 });

    // Endpoint de status responde (sem pareamento real: enabled=false/status inicial).
    const resp = await page.request.get('/observe/api/system/whatsapp/qr/status');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(typeof body.enabled).toBe('boolean');
    expect(typeof body.status).toBe('string');
  });

  test('seção Log de conexões é exibida na aba WhatsApp e o endpoint responde', async ({ page }) => {
    await openWhatsAppTab(page);

    await expect(page.locator('#wa-conn-channel')).toBeVisible();
    const box = page.locator('#wa-conn-log');
    await expect(box).toBeVisible();
    // Com eventos: tabela com as colunas do log. Sem eventos: hint informativo.
    const table = box.locator('table');
    await expect.poll(async () => (await table.count()) || ((await box.textContent()) || ''), { timeout: 15000 })
      .toBeTruthy();
    if (await table.count()) {
      await expect(table.first()).toContainText('Quando');
      await expect(table.first()).toContainText('Evento');
    } else {
      await expect(box).toContainText(/Nenhum evento|Falha ao carregar/);
    }

    const resp = await page.request.get('/observe/api/system/whatsapp/connections/log?limit=50');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(Array.isArray(body.events)).toBe(true);
  });

  test('modal de teste abre e cancela sem enviar', async ({ page }) => {    await openWhatsAppTab(page);
    await page.locator('#wa-test-btn').click();
    await expect(page.locator('#wa-test-modal')).toBeVisible();
    await expect(page.locator('#wa-test-text')).toHaveValue(/R-Observe/);
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.locator('#wa-test-modal')).toHaveCount(0);
  });

  test('envio de mensagem de teste via API Meta (canal real)', async ({ page }) => {
    await openWhatsAppTab(page);
    await page.locator('#wa-test-btn').click();
    await expect(page.locator('#wa-test-modal')).toBeVisible();

    const responsePromise = page.waitForResponse(resp =>
      resp.url().includes('/observe/api/system/whatsapp/test') && resp.request().method() === 'POST');
    await page.locator('#wa-test-send').click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    console.log(`TEST_SEND_HTTP=${response.status()} BODY=${JSON.stringify(body)}`);

    // O canal deve responder de forma definitiva (sucesso ou erro da Meta), nunca travar.
    // 502 = a API propaga o erro retornado pela Graph API da Meta.
    expect([200, 400, 502]).toContain(response.status());
    if (response.status() === 200) {
      expect(body.ok).toBe(true);
      await expect(page.locator('#wa-test-modal')).toHaveCount(0);
    } else {
      expect(body.error).toBeTruthy();
    }
  });
});
