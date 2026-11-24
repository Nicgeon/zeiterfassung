// Testdaten für den Stil-Schnappschuss (siehe stil-schnappschuss.js). Aufruf: node stil-testdaten.js <port> <datenordner>
const base = `http://localhost:${process.argv[2]}`;
const access = `zeit.zugang=${JSON.parse(require('fs').readFileSync(require('path').join(process.argv[3], 'keys.json'), 'utf8')).accessToken}`;
(async () => {
  const t = await fetch(`${base}/api/csrf-token`, { headers: { cookie: access } });
  const cookie = [access, ...t.headers.getSetCookie().map((c) => c.split(';')[0])].join('; ');
  const { csrfToken } = await t.json();
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return r.json(); };
  await call('PATCH', '/api/account/settings', { isApprentice: true });
  const task = (await call('POST', '/api/tasks', { title: 'Netzwerkdoku 2. OG', jira_key: 'ITPKK-215', due_date: '2026-11-23', note: 'Switch-Ports fehlen noch' })).task;
  await call('POST', '/api/tasks', { title: 'Rückruf Kunde wegen Drucker', jira_key: 'ITSUP-33180', due_date: '2026-11-20', priority: 1 });
  await call('POST', '/api/tasks', { title: 'Lizenzen prüfen', due_date: '2026-11-27' });
  await call('POST', '/api/tasks', { title: 'Ohne Datum' });
  const add = async (day, s, e, d, k, tr, real = true, extra = {}) => { const r = (await call('POST', '/api/entries', { work_date: day, start_time: s, end_time: e, description: d, jira_key: k, real_times: real, ...extra })).entry; if (tr) await call('PATCH', `/api/entries/${r.id}/transferred`, { transferred: true }); return r; };
  for (const day of ['2026-11-16', '2026-11-17', '2026-11-19', '2026-11-20']) {
    await add(day, '07:45', '09:30', 'Monitoring-Alarme geprüft', 'ITPKK-210', true);
    await add(day, '10:00', '12:00', 'Laptop-Rollout Buchhaltung', 'ITPKK-212', day !== '2026-11-20');
    await add(day, '12:45', '15:30', 'Netzwerkdoku ergänzt', 'ITPKK-215', true);
  }
  await add('2026-11-18', '08:00', '14:00', 'Subnetting und VLANs', '', false, false, { school: true });
  await add('2026-11-23', '07:55', '08:40', 'Monitoring-Alarme geprüft', 'ITPKK-210', true);
  await add('2026-11-23', '08:40', '10:10', 'Updates einspielen', 'ITPKK-123', false);
  await add('2026-11-23', '10:20', '11:20', 'Switch-Ports dokumentiert', '', false, true, { task_id: task.id });
  await add('2026-11-23', '11:00', '11:30', 'Teammeeting', '', false, false);
  console.log('ok');
})();
