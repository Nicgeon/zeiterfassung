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
    // wie der Starter: einmal mit dem Zugangsschlüssel öffnen, danach trägt das Fenster ihn als Cookie
    const token = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')).accessToken;
    await page.goto(`${base}/?zugang=${token}`);
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

    // Erinnerungen: Änderungen werden sofort gespeichert
    await page.click('[data-tab-id="erinnerungen"]');
    await page.waitForFunction(() => document.getElementById('rmIdleMinutes').value === '45');
    await page.uncheck('#rmIdle');
    await page.fill('#rmEndTime', '17:15');
    await page.dispatchEvent('#rmEndTime', 'change');
    await page.waitForFunction(() => document.querySelector('#rmIdleMinutes').disabled);
    await page.waitForTimeout(300);
    const saved = (await api(page, 'GET', '/api/reminders')).settings;
    assert.equal(saved.idle, false);
    assert.equal(saved.endTime, '17:15');
  });
});

test('Auswertung: Zeitstrahl je Tag filtert die Einträge, Kalender öffnet die Woche; Berichte für alle', { skip }, async () => {
  await withApp(async ({ page, base }) => {
    await page.goto(`${base}/index.html`);
    await page.waitForSelector('#composer');
    const today = await page.evaluate(() => todayISO());
    await api(page, 'POST', '/api/entries', { work_date: today, start_time: '08:00', end_time: '09:30', description: 'Monitoring geprüft', jira_key: 'IT-1', real_times: true });
    const e2 = (await api(page, 'POST', '/api/entries', { work_date: today, start_time: '10:00', end_time: '10:45', description: 'Drucker eingerichtet', jira_key: 'IT-2', real_times: true })).entry;
    await api(page, 'PATCH', `/api/entries/${e2.id}/transferred`, { transferred: true });

    await page.goto(`${base}/uebersicht.html`);
    await page.waitForSelector(`.day-strip[data-day="${today}"]`);
    assert.equal(await page.locator(`.day-strip[data-day="${today}"] .day-strip__block`).count(), 2, 'zwei Blöcke am Tag');
    assert.equal(await page.textContent('#statOpen'), '1:30');
    await page.click(`.day-strip[data-day="${today}"]`);
    assert.ok(await page.isVisible('#dayFilter'), 'Tagesfilter sichtbar');
    await page.fill('#searchInput', 'drucker');
    assert.equal(await page.locator('#entriesTableBody tr').count(), 1, 'Suche filtert');
    await page.click('[data-group=task]');
    assert.equal(await page.locator('.group-row').count(), 2);

    await page.click('[data-mode=month]');
    await page.waitForSelector('.calendar');
    await page.click(`.cal-day[data-week="${today}"]`);
    await page.waitForSelector('.day-strips');
    assert.equal(await page.getAttribute('[data-mode=week]', 'class'), 'seg__btn is-active');

    // Berichte: auch ohne Azubi-Kennzeichnung erreichbar, Berichtsheft-Text nur für Azubis
    await page.goto(`${base}/wochenbericht.html`);
    await page.waitForSelector('#reportPreview');
    assert.match(await page.textContent('#reportPreview'), /Monitoring geprüft/);
    assert.ok(!(await page.isVisible('#bhCard')));
    await page.click('[data-toggle=jira]');
    assert.match(await page.textContent('#reportPreview'), /Monitoring geprüft \(IT-1\)/);
  });
});

test('Mini-Fenster und übrige Seiten laden ohne Fehler', { skip }, async () => {
  await withApp(async ({ page, base }) => {
    for (const p of ['/uebersicht.html', '/wochenbericht.html', '/account.html', '/aufgaben.html', '/index.html']) {
      await page.goto(base + p);
      await page.waitForLoadState('networkidle');
    }
    await page.setViewportSize({ width: 460, height: 700 });
    await page.goto(`${base}/index.html?mini=1`);
    await page.waitForSelector('#composer');
    assert.equal(await page.getAttribute('#composer', 'data-view'), 'start', 'Mini startet mit "Jetzt starten"');
    assert.ok(!(await page.isVisible('#timelineCard')), 'großer Zeitstrahl fehlt im Mini');
    assert.ok(!(await page.isVisible('#miniTimelineCard')), 'ohne Einträge kein schmaler Zeitstrahl');
    await page.click('[data-compose=add]');
    assert.equal(await page.getAttribute('#composer', 'data-view'), 'add');
    const today = await page.evaluate(() => todayISO());
    await api(page, 'POST', '/api/entries', { work_date: today, start_time: '08:00', end_time: '09:00', description: 'Mini-Test', real_times: true });
    await page.reload();
    await page.waitForSelector('#miniTimelineCard:not(.hidden)');
    assert.equal(await page.locator('#miniTimeline .tl-block').count(), 1);
    assert.equal(await page.textContent('#miniTlTotal'), '1:00');
  });
});
