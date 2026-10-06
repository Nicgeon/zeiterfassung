'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);

  const els = {
    userLabel: $('#userLabel'),
    adminNavLink: $('#adminNavLink'),
    logoutBtn: $('#logoutBtn'),

    pwForm: $('#pwForm'),
    pwError: $('#pwError'),

    totpStatusBadge: $('#totpStatusBadge'),
    totpError: $('#totpError'),
    totpDisabledView: $('#totpDisabledView'),
    totpSetupView: $('#totpSetupView'),
    totpEnabledView: $('#totpEnabledView'),
    backupCodesView: $('#backupCodesView'),
    totpStartBtn: $('#totpStartBtn'),
    totpQr: $('#totpQr'),
    totpSecretText: $('#totpSecretText'),
    totpConfirmCode: $('#totpConfirmCode'),
    totpConfirmBtn: $('#totpConfirmBtn'),
    totpCancelBtn: $('#totpCancelBtn'),
    backupCodesList: $('#backupCodesList'),
    backupCodesAckBtn: $('#backupCodesAckBtn'),
    backupCodesRemaining: $('#backupCodesRemaining'),
    regenBackupBtn: $('#regenBackupBtn'),
    disableTotpBtn: $('#disableTotpBtn'),

    addPasskeyBtn: $('#addPasskeyBtn'),
    passkeyError: $('#passkeyError'),
    passkeyList: $('#passkeyList'),

    confirmOverlay: $('#confirmOverlay'),
    confirmTitle: $('#confirmTitle'),
    confirmPassword: $('#confirmPassword'),
    confirmError: $('#confirmError'),
    confirmOkBtn: $('#confirmOkBtn'),
    confirmCancelBtn: $('#confirmCancelBtn'),
  };

  // --- Passwort-Bestaetigungs-Dialog (Promise-basiert) ------------------

  let confirmResolver = null;
  function askPassword(title) {
    els.confirmTitle.textContent = title;
    els.confirmPassword.value = '';
    setFormError(els.confirmError, '');
    els.confirmOverlay.classList.remove('hidden');
    els.confirmPassword.focus();
    return new Promise((resolve) => { confirmResolver = resolve; });
  }
  function closeConfirmDialog(value) {
    els.confirmOverlay.classList.add('hidden');
    if (confirmResolver) { confirmResolver(value); confirmResolver = null; }
  }
  els.confirmOkBtn.addEventListener('click', () => closeConfirmDialog(els.confirmPassword.value));
  els.confirmCancelBtn.addEventListener('click', () => closeConfirmDialog(null));
  els.confirmPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); closeConfirmDialog(els.confirmPassword.value); }
  });

  // --- Init ---------------------------------------------------------

  async function init() {
    let me;
    try {
      me = await Api.get('/api/auth/me');
    } catch {
      return;
    }
    els.userLabel.textContent = me.user.displayName;
    if (me.user.role === 'admin') els.adminNavLink.classList.remove('hidden');
    if (me.user.isApprentice) document.getElementById('weeklyNavLink').classList.remove('hidden');
    await Api.primeCsrf();
    if (me.localMode) {
      const toggle = document.getElementById('localApprenticeToggle');
      toggle.checked = !!me.user.isApprentice;
      toggle.addEventListener('change', async () => {
        try {
          await Api.patch('/api/account/settings', { isApprentice: toggle.checked });
          document.getElementById('weeklyNavLink').classList.toggle('hidden', !toggle.checked);
        } catch {
          toggle.checked = !toggle.checked;
        }
      });
      return; // Passwort/2FA/Passkeys gibt es lokal nicht
    }
    renderTotpStatus(me.user.totpEnabled);
    if (me.user.totpEnabled) await loadBackupCodeCount();
    await loadPasskeys();
  }

  // --- Passwort aendern ------------------------------------------------

  els.pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError(els.pwError, '');
    const currentPassword = $('#currentPassword').value;
    const p1 = $('#newPassword').value;
    const p2 = $('#newPasswordRepeat').value;
    if (p1 !== p2) return setFormError(els.pwError, 'Neue Passwoerter stimmen nicht ueberein.');
    try {
      await Api.post('/api/account/password', { currentPassword, newPassword: p1 });
      els.pwForm.reset();
      showToast('Passwort geändert. Andere Geräte wurden abgemeldet.');
    } catch (err) {
      setFormError(els.pwError, err.message);
    }
  });

  // --- 2FA ------------------------------------------------------------

  function renderTotpStatus(enabled) {
    els.totpStatusBadge.textContent = enabled ? 'Aktiv' : 'Inaktiv';
    els.totpStatusBadge.className = 'badge ' + (enabled ? 'badge--success' : '');
    els.totpDisabledView.classList.toggle('hidden', enabled);
    els.totpEnabledView.classList.toggle('hidden', !enabled);
    els.totpSetupView.classList.add('hidden');
    els.backupCodesView.classList.add('hidden');
  }

  async function loadBackupCodeCount() {
    try {
      const data = await Api.get('/api/account/totp/backup-codes/status');
      els.backupCodesRemaining.textContent = data.remaining;
    } catch { /* egal */ }
  }

  els.totpStartBtn.addEventListener('click', async () => {
    setFormError(els.totpError, '');
    try {
      const data = await Api.post('/api/account/totp/setup', {});
      els.totpQr.src = data.qrDataUrl;
      els.totpSecretText.textContent = data.secret;
      els.totpConfirmCode.value = '';
      els.totpDisabledView.classList.add('hidden');
      els.totpSetupView.classList.remove('hidden');
    } catch (err) {
      setFormError(els.totpError, err.message);
    }
  });

  els.totpCancelBtn.addEventListener('click', () => renderTotpStatus(false));

  els.totpConfirmBtn.addEventListener('click', async () => {
    setFormError(els.totpError, '');
    try {
      const data = await Api.post('/api/account/totp/confirm', { code: els.totpConfirmCode.value.trim() });
      showBackupCodes(data.backupCodes);
    } catch (err) {
      setFormError(els.totpError, err.message);
    }
  });

  function showBackupCodes(codes) {
    els.totpSetupView.classList.add('hidden');
    els.totpEnabledView.classList.add('hidden');
    els.backupCodesList.innerHTML = codes.map(escapeHtml).join('<br>');
    els.backupCodesView.classList.remove('hidden');
  }

  els.backupCodesAckBtn.addEventListener('click', async () => {
    els.totpStatusBadge.textContent = 'Aktiv';
    els.totpStatusBadge.className = 'badge badge--success';
    els.backupCodesView.classList.add('hidden');
    els.totpEnabledView.classList.remove('hidden');
    await loadBackupCodeCount();
  });

  els.disableTotpBtn.addEventListener('click', async () => {
    const pw = await askPassword('2FA deaktivieren');
    if (pw === null) return;
    try {
      await Api.post('/api/account/totp/disable', { currentPassword: pw });
      showToast('2FA deaktiviert.');
      renderTotpStatus(false);
    } catch (err) {
      setFormError(els.totpError, err.message);
    }
  });

  els.regenBackupBtn.addEventListener('click', async () => {
    const pw = await askPassword('Backup-Codes neu erzeugen');
    if (pw === null) return;
    try {
      const data = await Api.post('/api/account/totp/backup-codes/regenerate', { currentPassword: pw });
      showBackupCodes(data.backupCodes);
    } catch (err) {
      setFormError(els.totpError, err.message);
    }
  });

  // --- Passkeys ---------------------------------------------------------

  function fmtDateTime(iso) {
    if (!iso) return '–';
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  }

  async function loadPasskeys() {
    try {
      const data = await Api.get('/api/account/passkeys');
      if (data.passkeys.length === 0) {
        els.passkeyList.innerHTML = '<p class="text-sm text-faint">Noch keine Passkeys hinterlegt.</p>';
        return;
      }
      els.passkeyList.innerHTML = data.passkeys.map((p) => `
        <div class="ledger-row items-center" data-id="${p.id}">
          <div class="ledger-row__body">
            <div class="passkey-name">${escapeHtml(p.name)}</div>
            <div class="field-hint">
              ${p.rp_id ? `Gilt für: ${escapeHtml(p.rp_id)} · ` : ''}Erstellt: ${fmtDateTime(p.created_at)} · Zuletzt genutzt: ${fmtDateTime(p.last_used_at)}
            </div>
          </div>
          <button type="button" class="btn btn--icon delete-passkey-btn" title="Entfernen">🗑</button>
        </div>
      `).join('');
    } catch (err) {
      setFormError(els.passkeyError, err.message);
    }
  }

  els.passkeyList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.delete-passkey-btn');
    if (!btn) return;
    const row = e.target.closest('.ledger-row');
    const id = row.dataset.id;
    if (!confirm('Diesen Passkey wirklich entfernen?')) return;
    try {
      await Api.del(`/api/account/passkeys/${id}`);
      showToast('Passkey entfernt.');
      await loadPasskeys();
    } catch (err) {
      setFormError(els.passkeyError, err.message);
    }
  });

  els.addPasskeyBtn.addEventListener('click', async () => {
    setFormError(els.passkeyError, '');
    if (!window.SimpleWebAuthnBrowser || !SimpleWebAuthnBrowser.browserSupportsWebAuthn()) {
      return setFormError(els.passkeyError, 'Dieser Browser unterstuetzt keine Passkeys.');
    }
    const name = prompt('Name fuer diesen Passkey (z.B. "Laptop Windows Hello", "YubiKey Buero"):', '');
    if (name === null) return;
    try {
      const options = await Api.post('/api/account/passkeys/register-options', {});
      const regResp = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
      await Api.post('/api/account/passkeys/register-verify', { response: regResp, name: name || 'Passkey' });
      showToast('Passkey hinzugefuegt.');
      await loadPasskeys();
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        setFormError(els.passkeyError, 'Registrierung abgebrochen oder Zeit abgelaufen.');
      } else {
        setFormError(els.passkeyError, (err && err.message) || 'Passkey-Registrierung fehlgeschlagen.');
      }
    }
  });

  els.logoutBtn.addEventListener('click', async () => {
    try { await Api.post('/api/auth/logout'); } catch { /* egal */ }
    window.location.href = '/login.html';
  });

  init();
})();
