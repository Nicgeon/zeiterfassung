// Stil-Schnappschuss für Umbauten am CSS: alle Seiten in allen Designs und Breiten öffnen und für jedes Element die
// berechneten Stile (Auswahl) und die Lage aufschreiben. Uhr im Browser fest auf 23.11.2026 11:30.
//
// Ablauf (nicht Teil von npm test, braucht Playwright):
//   1. Server mit leerem Datenordner starten:  DATA_DIR=/tmp/stil LOCAL_MODE=true ZEIT_NO_REMINDERS=1 PORT=4790 node src/server.js
//   2. Testdaten anlegen:                     node test/tools/stil-testdaten.js 4790
//   3. vorher:  node test/tools/stil-schnappschuss.js 4790 vorher.json
//   4. CSS ändern, dann: node test/tools/stil-schnappschuss.js 4790 nachher.json
//   5. node test/tools/stil-vergleich.js vorher.json nachher.json   (Exit 0 = keine sichtbare Änderung)
const { chromium } = require('playwright');
const fs = require('fs');

const PORT = process.argv[2];
const OUT = process.argv[3];
const BASE = `http://localhost:${PORT}`;
const PROPS = ['display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'color', 'background-color', 'background-image', 'border-top-width', 'border-top-color',
  'border-top-style', 'border-bottom-width', 'border-left-width', 'border-left-color', 'border-top-left-radius', 'border-bottom-right-radius', 'font-size', 'font-weight', 'font-family',
  'line-height', 'gap', 'row-gap', 'grid-template-columns', 'grid-template-rows', 'grid-column-start', 'grid-row-start', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'align-items',
  'justify-content', 'align-self', 'opacity', 'visibility', 'box-shadow', 'text-transform', 'letter-spacing', 'overflow-x', 'overflow-y', 'z-index', 'white-space',
  'text-align', 'transform', 'order', 'zoom', 'text-overflow', 'text-decoration-line', 'cursor', 'outline-style', 'max-width', 'min-height', 'resize', 'content'];

const THEMES = ['light', 'dark', 'marine', 'marine-dark'];
const PAGES = [
  { name: 'heute', url: '/index.html', sizes: [[1360, 900], [800, 900], [390, 844]] },
  { name: 'heute-nachtragen', url: '/index.html', sizes: [[1360, 900]], act: async (p) => { await p.click('[data-compose=add]'); } },
  { name: 'mini', url: '/index.html?mini=1', sizes: [[460, 700]] },
  { name: 'mini-nachtragen', url: '/index.html?mini=1', sizes: [[460, 700]], act: async (p) => { await p.click('[data-compose=add]'); } },
  { name: 'aufgaben', url: '/aufgaben.html#aufgabe-1', sizes: [[1360, 900], [390, 844]] },
  { name: 'auswertung-woche', url: '/uebersicht.html', sizes: [[1360, 900], [390, 844]], ls: { 'zeit.report.mode': 'week' } },
  { name: 'auswertung-monat', url: '/uebersicht.html', sizes: [[1360, 900]], ls: { 'zeit.report.mode': 'month' } },
  { name: 'berichte', url: '/wochenbericht.html', sizes: [[1360, 900], [390, 844]] },
  ...['allgemein', 'erinnerungen', 'programm', 'jira', 'ki', 'daten'].map((t) => ({ name: `einstellungen-${t}`, url: `/account.html#${t}`, sizes: [[1360, 900]] })),
];

(async () => {
  const browser = await chromium.launch();
  const result = {};
  for (const theme of THEMES) {
    for (const pg of PAGES) {
      for (const [w, h] of pg.sizes) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
        await ctx.addInitScript(([t, ls]) => {
          try {
            localStorage.setItem('zeit.theme', t);
            localStorage.setItem('zeit.nav2', 'expanded');
            localStorage.setItem('zeit.tasksPageView', 'all');
            for (const [k, v] of Object.entries(ls || {})) localStorage.setItem(k, v);
          } catch { /* egal */ }
        }, [theme, pg.ls]);
        const page = await ctx.newPage();
        await page.clock.setFixedTime(new Date('2026-11-23T11:30:00+01:00'));
        await page.goto(BASE + pg.url);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(700);
        if (pg.act) { await pg.act(page); await page.waitForTimeout(300); }
        // Mauszeiger aus dem Weg (Hover-Zustände nicht mitnehmen), Hinweise ausblenden
        await page.mouse.move(w - 1, h - 1);
        await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.remove(); });
        await page.waitForTimeout(200);
        const data = await page.evaluate((props) => {
          const out = [];
          const walk = (el, pathStr) => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            const style = props.map((p) => cs.getPropertyValue(p)).join('|');
            const before = getComputedStyle(el, '::before');
            const after = getComputedStyle(el, '::after');
            const pseudo = [before.content, before.backgroundColor, before.width, after.content, after.backgroundColor].join('|');
            out.push([pathStr, el.tagName + (el.id ? `#${el.id}` : '') + (el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''),
              style, pseudo, [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(',')]);
            [...el.children].forEach((c, i) => walk(c, `${pathStr}/${i}`));
          };
          walk(document.body, 'body');
          return out;
        }, PROPS);
        result[`${theme}|${pg.name}|${w}`] = data;
        await ctx.close();
      }
    }
  }
  await browser.close();
  fs.writeFileSync(OUT, JSON.stringify(result));
  console.log('Seiten:', Object.keys(result).length, 'Elemente:', Object.values(result).reduce((n, d) => n + d.length, 0));
})();
