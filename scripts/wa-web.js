'use strict';
// Abre o WhatsApp Web num Chromium do Playwright (compatível com WhatsApp),
// com sessão persistente, e aguarda comandos por stdin.
const { chromium } = require('playwright-core');

const PROFILE_DIR = '/tmp/wa-profile';

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  console.log('NAVEGANDO');
  await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Tenta capturar o QR
  for (let i = 0; i < 40; i++) {
    const qr = page.locator('canvas').first();
    if ((await qr.count()) > 0) {
      await page.screenshot({ path: '/tmp/wa-qr.png' });
      console.log('QR_PRONTO /tmp/wa-qr.png');
      break;
    }
    await page.waitForTimeout(1500);
  }

  // Espera o login
  try {
    await page.waitForSelector('[data-testid="chat-list"], #pane-side', { timeout: 300000 });
    console.log('LOGADO');
  } catch (e) {
    console.log('TIMEOUT_LOGIN');
  }

  // Aceita comandos por stdin
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (line) => {
    const cmd = line.trim();
    if (!cmd) return;
    try {
      if (cmd === 'status') {
        console.log('ALIVE ' + page.url());
      } else if (cmd.startsWith('open|')) {
        const url = cmd.split('|').slice(1).join('|');
        const np = await ctx.newPage();
        await np.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log('OPENED ' + url);
      } else if (cmd.startsWith('kbsend|')) {
        const parts = cmd.split('|');
        const phone = parts[1];
        const msg = parts.slice(2).join('|');
        await keyboardSend(page, phone, msg);
        console.log('KB_SENT ' + phone);
      } else if (cmd.startsWith('send|')) {
        const parts = cmd.split('|');
        const phone = parts[1];
        const msg = parts.slice(2).join('|');
        await sendMessage(page, phone, msg);
        console.log('SENT_OK ' + phone);
      } else if (cmd === 'qr' || cmd === 'shot') {
        await page.screenshot({ path: '/tmp/wa-qr.png' });
        console.log('SHOT_SAVED /tmp/wa-qr.png');
      } else if (cmd === 'dump') {
        const info = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button')).map(b => (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim().slice(0, 40)).filter(Boolean);
          const editables = Array.from(document.querySelectorAll('div[contenteditable="true"]')).map(e => e.getAttribute('data-tab') || e.className).slice(0, 10);
          return JSON.stringify({ btns: [...new Set(btns)].slice(0, 40), editables });
        });
        console.log('DUMP ' + info);
      } else if (cmd === 'quit') {
        await ctx.close();
        process.exit(0);
      } else {
        console.log('CMD? ' + cmd);
      }
    } catch (e) {
      console.log('ERR ' + e.message);
    }
  });
}

async function keyboardSend(page, phone, msg) {
  // Nova conversa (atalho), digita o número, Enter para abrir, digita mensagem, Enter para enviar.
  await page.keyboard.press('Control+Alt+N');
  await page.waitForTimeout(2000);
  await page.keyboard.type(phone, { delay: 100 });
  await page.waitForTimeout(2500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  await page.keyboard.type(msg, { delay: 60 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
}

async function sendMessage(page, phone, msg) {
  const newChatSelectors = [
    'button[aria-label*="Nova conversa"]',
    'button[aria-label*="nova conversa"]',
    'button[title*="Nova conversa"]',
    'button[title*="nova conversa"]',
    'button[data-testid="menu"]',
    'div[role="button"][aria-label*="conversa"]',
  ];
  let opened = false;
  for (const sel of newChatSelectors) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click();
      opened = true;
      break;
    }
  }
  if (!opened) await page.keyboard.press('Control+Alt+N');
  await page.waitForTimeout(1500);

  // 2. Digita o número na busca
  const search = page.locator('div[contenteditable="true"]').first();
  await search.click();
  await page.waitForTimeout(500);
  await search.type(phone, { delay: 100 });
  await page.waitForTimeout(2500);

  // 3. Abre o resultado
  const result = page.locator('div[role="button"]').filter({ hasText: phone }).first();
  if ((await result.count()) > 0) {
    await result.click();
  } else {
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(2500);

  // 4. Digita e envia
  const box = page.locator('footer div[contenteditable="true"], div[contenteditable="true"]').last();
  await box.click();
  await page.waitForTimeout(500);
  await box.type(msg, { delay: 50 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
}

main().catch((e) => { console.error('FATAL ' + e.message); process.exit(1); });
