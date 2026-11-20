'use strict';

// Oberflächen-Tests im echten Browser (Playwright): die wichtigsten Abläufe einmal durchklicken.
// Läuft nur, wenn Playwright installiert ist (z. B. in der Entwicklungsumgebung); sonst werden die Tests übersprungen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* nicht installiert */ }
const skip = chromium ? false : 'Playwright ist nicht installiert';

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Server im lokalen Betrieb (ohne Anmeldung) mit leerem Datenordner und ein Browser; fn bekommt eine Seite. */
async function withApp(fn, { width = 1360, height = 900, theme = 'marine-dark' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-ui-'));
  const port = await freePort();
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), LOCAL_MODE: 'true', UPDATE_CHECK: 'false', ZEIT_NO_REMINDERS: '1', OPEN_BROWSER: '0' };
  delete env.ENCRYPTION_KEY;
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  try {
    let ok = false;
    for (let i = 0; i < 80 && !ok; i++) { try { ok = (await fetch(`${base}/api/health`)).ok; } catch { await sleep(150); } }
    assert.ok(ok, 'Server startet');
    const ctx = await browser.newContext({ viewport: { width, height } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('zeit.theme', t); localStorage.setItem('zeit.nav2', 'expanded'); } catch { /* egal */ } }, theme);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('dialog', (d) => d.accept());
    await fn({ page, base, errors });
    assert.deepEqual(errors, [], 'keine Fehler in der Browser-Konsole (z. B. CSP)');
  } finally {
    await browser.close();
    server.kill();
  }
}

const api = (page, method, p, body) => page.evaluate(([m, url, b]) => {
  const fn = { GET: Api.get, POST: Api.post, PUT: Api.put, PATCH: Api.patch, DELETE: Api.del }[m];
  return m === 'GET' || m === 'DELETE' ? fn(url) : fn(url, b);
}, [method, p, body]);

test('Heute: Timer mit Enter starten, unterbrechen, weitermachen, stoppen – ein Eintrag mit zwei Teilen', { skip }, async () => {
  await withApp(async ({ page, base }) => {
    await page.goto(`${base}/index.html`);
    await page.waitForSelector('#composer[data-view="start"]');
    await page.fill('#description', 'Backup prüfen');
    await page.fill('#jiraKey', 'IT-7');
    await page.press('#description', 'Enter');
    await page.waitForSelector('#composer.composer--timer');

    await page.click('#timerPauseBtn');
    await page.waitForSelector('#composer:not(.composer--timer)');
    await page.waitForSelector('#resumeBar .chip--resume');
    await page.click('#resumeBar .chip--resume');
    await page.waitForSelector('#composer.composer--timer');
    await page.click('#timerStopBtn');
    await page.waitForSelector('#composer:not(.composer--timer)');

    const entries = (await api(page, 'GET', `/api/entries?date=${await page.evaluate(() => todayISO())}`)).entries;
    assert.equal(entries.length, 1, 'Unterbrechen + Weitermachen ergibt einen Eintrag');
    assert.equal(entries[0].segments.length, 2, 'beide Teile sind gespeichert');
    await page.waitForSelector('#ledger .entry');
    assert.equal(await page.locator('#timeline .tl-block').count(), 2, 'Zeitstrahl zeigt zwei Blöcke');
  });
});

test('Heute: Klick in eine Lücke öffnet "Nachtragen" mit genau diesem Zeitraum', { skip }, async () => {
  await withApp(async ({ page, base }) => {
    await page.goto(`${base}/index.html`);
    await page.waitForSelector('#composer');
    const day = await page.evaluate(() => todayISO());
    await api(page, 'POST', '/api/entries', { work_date: day, start_time: '00:05', end_time: '00:20', description: 'A', real_times: true });
    await api(page, 'POST', '/api/entries', { work_date: day, start_time: '00:50', end_time: '01:10', description: 'B', real_times: true });
    await page.reload();
    await page.waitForSelector('#timeline .tl-gap');
    await page.locator('#timeline .tl-gap').first().click();
    assert.equal(await page.getAttribute('#composer', 'data-view'), 'add');
    assert.equal(await page.inputValue('#startTime'), '00:20');
    assert.equal(await page.inputValue('#duration'), '30 Min');
    await page.fill('#description', 'Lücke gefüllt');
    await page.click('#saveBtn');
    await page.waitForFunction(() => document.querySelectorAll('#ledger .entry').length === 3);
    const entries = (await api(page, 'GET', `/api/entries?date=${day}`)).entries;
    const filled = entries.find((e) => e.description === 'Lücke gefüllt');
    assert.deepEqual(filled.segments, [['00:20', '00:50']], 'echte Uhrzeit gespeichert');
  });
});

test('Aufgaben: anlegen, Notiz automatisch speichern, Timer starten; Stoppen fragt nach Erledigt', { skip }, async () => {
  await withApp(async ({ page, base }) => {
    await page.goto(`${base}/aufgaben.html`);
    await page.waitForSelector('#tpAdd');
    await page.fill('#tpTitle', 'Netzwerkdoku ITPKK-210');
    await page.press('#tpTitle', 'Enter');
    await page.waitForSelector('.tp-row');
    assert.match(await page.locator('.tp-row__sub').first().innerText(), /ITPKK-210/);

    await page.click('.tp-row__main');
    await page.fill('textarea[name="note"]', 'Switch fehlt noch');
    await page.waitForSelector('#tpSaved:text("Gespeichert")', { timeout: 5000 });
    const task = (await api(page, 'GET', '/api/tasks')).tasks[0];
    assert.equal(task.note, 'Switch fehlt noch');

    await page.click('.tp-actions__start');
    await page.waitForSelector('#toast:has-text("Timer läuft")');
    assert.equal((await api(page, 'GET', '/api/timer')).timer.taskId, task.id);

    await page.goto(`${base}/index.html`);
    await page.waitForSelector('#composer.composer--timer');
    await page.click('#timerStopBtn');
    await page.waitForSelector('#toast:has-text("damit erledigt")');
    await page.click('#toast button');
    await page.waitForSelector('#toast:has-text("erledigt.")');
    assert.equal((await api(page, 'GET', '/api/tasks')).tasks.length, 0, 'Aufgabe abgehakt');
  });
});

test('Einstellungen: Unterreiter, Adresse merkt den Reiter; lokal kein Reiter "Sicherheit"', { skip }, async () => {
  await withApp(async ({ page, base }) => {
    await page.goto(`${base}/account.html#jira`);
    await page.waitForSelector('.st-tab.is-active');
    assert.equal(await page.locator('.st-tab.is-active .st-tab__label').innerText(), 'Jira');
    assert.ok(await page.isVisible('#jiraCard'));
    assert.ok(!(await page.isVisible('#settingsCard')));
    const labels = await page.locator('.st-tab__label').allInnerTexts();
    assert.ok(!labels.includes('Sicherheit'));
    await page.click('[data-tab-id="allgemein"]');
    assert.ok(await page.isVisible('#settingsCard'));
  });
});

test('Mini-Fenster und übrige Seiten laden ohne Fehler', { skip }, async () => {
  await withApp(async ({ page, base }) => {
    for (const p of ['/uebersicht.html', '/account.html', '/aufgaben.html', '/index.html']) {
      await page.goto(base + p);
      await page.waitForLoadState('networkidle');
    }
    await page.setViewportSize({ width: 460, height: 700 });
    await page.goto(`${base}/index.html?mini=1`);
    await page.waitForSelector('#composer');
    assert.equal(await page.getAttribute('#composer', 'data-view'), 'add', 'Mini zeigt immer das ganze Formular');
    assert.ok(!(await page.isVisible('#timelineCard')));
  });
});
