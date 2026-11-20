'use strict';

// Einstellungen → Erinnerungen: Schalter und Werte laden, jede Änderung sofort speichern, Test-Benachrichtigung.
(function () {
  const card = document.getElementById('remindCard');
  if (!card) return;
  const $ = (id) => document.getElementById(id);
  const fields = {
    timerLong: $('rmTimerLong'),
    timerHours: $('rmTimerHours'),
    idle: $('rmIdle'),
    idleMinutes: $('rmIdleMinutes'),
    workFrom: $('rmWorkFrom'),
    workTo: $('rmWorkTo'),
    endOfDay: $('rmEnd'),
    endTime: $('rmEndTime'),
    tasks: $('rmTasks'),
  };
  const errorBox = $('rmError');

  function fill(settings) {
    for (const [key, el] of Object.entries(fields)) {
      if (el.type === 'checkbox') el.checked = !!settings[key];
      else el.value = settings[key];
    }
    // Details nur bei eingeschalteter Erinnerung bedienbar
    card.querySelectorAll('.rm-item').forEach((item) => {
      const on = item.querySelector('input[type=checkbox]').checked;
      item.classList.toggle('rm-item--off', !on);
      item.querySelectorAll('.rm-item__detail input').forEach((i) => { i.disabled = !on; });
    });
  }

  async function load() {
    try {
      const { settings } = await Api.get('/api/reminders');
      fill(settings);
    } catch (err) {
      setFormError(errorBox, err.message);
    }
  }

  // Speichern der Reihe nach; die Antwort (mit vom Server korrigierten Werten) wird nur für die letzte Änderung
  // übernommen, sonst würde eine ältere Antwort ein gerade geändertes Feld zurücksetzen.
  let seq = 0;
  let chain = Promise.resolve();
  function save() {
    const mine = ++seq;
    chain = chain.then(async () => {
      const body = {};
      for (const [key, el] of Object.entries(fields)) body[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
      try {
        const { settings } = await Api.put('/api/reminders', body);
        if (mine !== seq) return;
        setFormError(errorBox, '');
        fill(settings);
        showToast('Erinnerungen gespeichert.');
      } catch (err) {
        setFormError(errorBox, err.message);
      }
    });
  }

  for (const el of Object.values(fields)) el.addEventListener('change', save);
  $('rmTestBtn').addEventListener('click', async () => {
    try {
      const { ok } = await Api.post('/api/reminders/test');
      showToast(ok ? 'Test-Benachrichtigung gesendet. Falls nichts erscheint: Benachrichtigungen in Windows erlauben.' : 'Benachrichtigung nicht möglich.');
    } catch (err) {
      showToast(err.message);
    }
  });

  // erst laden, wenn feststeht, dass das Programm lokal läuft (sonst ist die Karte ausgeblendet)
  Api.get('/api/auth/me').then(() => { if (document.body.classList.contains('local-mode')) load(); }).catch(() => {});
})();
