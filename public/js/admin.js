'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);

  const els = {
    userLabel: $('#userLabel'),
    logoutBtn: $('#logoutBtn'),
    createForm: $('#createForm'),
    createError: $('#createError'),
    tempPasswordBox: $('#tempPasswordBox'),
    usersError: $('#usersError'),
    usersTableBody: $('#usersTableBody'),
    auditTableBody: $('#auditTableBody'),
  };

  const EVENT_LABELS = {
    login_success: 'Anmeldung erfolgreich',
    login_failed: 'Anmeldung fehlgeschlagen',
    login_failed_totp: '2FA-Code falsch',
    login_failed_passkey: 'Passkey-Anmeldung fehlgeschlagen',
    login_blocked_locked: 'Anmeldung blockiert (gesperrt)',
    logout: 'Abmeldung',
    password_changed: 'Passwort geaendert',
    password_reset_by_admin: 'Passwort durch Admin zurueckgesetzt',
    totp_enabled: '2FA aktiviert',
    totp_disabled: '2FA deaktiviert',
    backup_codes_regenerated: 'Backup-Codes neu erzeugt',
    passkey_registered: 'Passkey registriert',
    passkey_deleted: 'Passkey entfernt',
    user_created: 'Nutzer angelegt',
    user_activated: 'Nutzer aktiviert',
    user_deactivated: 'Nutzer deaktiviert',
    user_role_changed: 'Rolle geaendert',
    user_2fa_reset_by_admin: '2FA/Passkeys durch Admin zurueckgesetzt',
    all_sessions_cleared: 'Alle Sitzungen beendet',
    user_unlocked: 'Sperre aufgehoben',
    user_apprentice_enabled: 'Azubi-Kennzeichnung gesetzt',
    user_apprentice_disabled: 'Azubi-Kennzeichnung entfernt',
    data_exported: 'Eigene Daten exportiert',
    data_imported: 'Daten importiert',
  };

  async function init() {
    let me;
    try {
      me = await Api.get('/api/auth/me');
    } catch {
      return;
    }
    if (me.user.role !== 'admin') {
      window.location.href = '/index.html';
      return;
    }
    els.userLabel.textContent = me.user.displayName;
    await Api.primeCsrf();
    await Promise.all([loadUsers(), loadAuditLog()]);
  }

  function fmtDateTime(iso) {
    if (!iso) return '–';
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  }

  async function loadUsers() {
    setFormError(els.usersError, '');
    try {
      const data = await Api.get('/api/admin/users');
      els.usersTableBody.innerHTML = data.users.map((u) => `
        <tr data-id="${u.id}">
          <td>${escapeHtml(u.displayName)}</td>
          <td class="mono">${escapeHtml(u.username)}</td>
          <td>
            ${u.role === 'admin' ? 'Administrator:in' : 'Mitarbeiter:in'}
            ${u.isApprentice ? '<br><span class="badge badge--accent">Azubi</span>' : ''}
          </td>
          <td>
            ${u.active ? '<span class="badge badge--success">Aktiv</span>' : '<span class="badge badge--danger">Deaktiviert</span>'}
            ${u.mustChangePassword ? '<span class="badge" title="Muss Passwort beim naechsten Login aendern">PW ausstehend</span>' : ''}
          </td>
          <td>${u.totpEnabled ? '<span class="badge badge--accent">An</span>' : '<span class="badge">Aus</span>'}</td>
          <td>${u.passkeyCount}</td>
          <td>
            <div class="flex gap-sm flex-wrap">
              <button type="button" class="btn btn--ghost btn--sm toggle-apprentice-btn">${u.isApprentice ? 'Azubi entfernen' : 'Als Azubi'}</button>
              <button type="button" class="btn btn--ghost btn--sm toggle-active-btn">${u.active ? 'Deaktivieren' : 'Aktivieren'}</button>
              <button type="button" class="btn btn--ghost btn--sm reset-pw-btn">PW zuruecksetzen</button>
              <button type="button" class="btn btn--ghost btn--sm reset-2fa-btn">2FA zuruecksetzen</button>
            </div>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      setFormError(els.usersError, err.message);
    }
  }

  async function loadAuditLog() {
    try {
      const data = await Api.get('/api/admin/audit-log?limit=100');
      els.auditTableBody.innerHTML = data.entries.map((e) => `
        <tr>
          <td class="mono">${fmtDateTime(e.created_at)}</td>
          <td>${escapeHtml(EVENT_LABELS[e.event] || e.event)}</td>
          <td>${e.username ? escapeHtml(e.username) : '–'}</td>
          <td class="field-hint">${e.detail ? escapeHtml(e.detail) : ''}</td>
          <td class="mono field-hint">${e.ip ? escapeHtml(e.ip) : ''}</td>
        </tr>
      `).join('');
    } catch { /* Audit-Log ist nice-to-have, kein harter Fehler */ }
  }

  els.createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError(els.createError, '');
    els.tempPasswordBox.classList.add('hidden');
    const username = $('#newUsername').value.trim();
    const displayName = $('#newDisplayName').value.trim();
    const role = $('#newRole').value;
    try {
      const data = await Api.post('/api/admin/users', { username, displayName, role });
      els.createForm.reset();
      els.tempPasswordBox.textContent =
        `Nutzer "${data.user.username}" angelegt. Temporaeres Passwort: ${data.tempPassword} ` +
        `(bitte persoenlich/sicher uebermitteln, muss beim ersten Login geaendert werden)`;
      els.tempPasswordBox.classList.remove('hidden');
      await loadUsers();
    } catch (err) {
      setFormError(els.createError, err.message);
    }
  });

  els.usersTableBody.addEventListener('click', async (e) => {
    const row = e.target.closest('tr');
    if (!row) return;
    const id = row.dataset.id;

    if (e.target.closest('.toggle-apprentice-btn')) {
      const enable = e.target.textContent.trim() === 'Als Azubi';
      try {
        await Api.patch(`/api/admin/users/${id}`, { isApprentice: enable });
        showToast(enable ? 'Azubi-Kennzeichnung gesetzt.' : 'Azubi-Kennzeichnung entfernt.');
        await loadUsers();
      } catch (err) {
        setFormError(els.usersError, err.message);
      }
    } else if (e.target.closest('.toggle-active-btn')) {
      const isActivating = e.target.textContent.trim() === 'Aktivieren';
      if (!isActivating && !confirm('Diesen Nutzer wirklich deaktivieren? Login ist danach nicht mehr moeglich.')) return;
      try {
        await Api.patch(`/api/admin/users/${id}`, { active: isActivating });
        await loadUsers();
      } catch (err) {
        setFormError(els.usersError, err.message);
      }
    } else if (e.target.closest('.reset-pw-btn')) {
      if (!confirm('Neues temporaeres Passwort erzeugen? Das alte Passwort wird ungueltig.')) return;
      try {
        const data = await Api.post(`/api/admin/users/${id}/reset-password`, {});
        els.tempPasswordBox.textContent = `Neues temporaeres Passwort: ${data.tempPassword} (bitte sicher uebermitteln)`;
        els.tempPasswordBox.classList.remove('hidden');
        await loadUsers();
      } catch (err) {
        setFormError(els.usersError, err.message);
      }
    } else if (e.target.closest('.reset-2fa-btn')) {
      if (!confirm('2FA und alle Passkeys dieses Nutzers zuruecksetzen? Login ist danach nur noch per Passwort moeglich, bis neu eingerichtet wird.')) return;
      try {
        await Api.post(`/api/admin/users/${id}/reset-2fa`, {});
        showToast('2FA/Passkeys zurueckgesetzt.');
        await loadUsers();
      } catch (err) {
        setFormError(els.usersError, err.message);
      }
    }
  });

  els.logoutBtn.addEventListener('click', async () => {
    try { await Api.post('/api/auth/logout'); } catch { /* egal */ }
    window.location.href = '/login.html';
  });

  init();
})();
