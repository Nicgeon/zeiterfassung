'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);
  const stepPassword = $('#step-password');
  const stepChangePassword = $('#step-change-password');
  const stepTotp = $('#step-totp');
  const passkeyArea = $('#passkeyArea');
  const errorBox = $('#formError');

  function showStep(step) {
    stepPassword.classList.toggle('hidden', step !== 'password');
    stepChangePassword.classList.toggle('hidden', step !== 'change-password');
    stepTotp.classList.toggle('hidden', step !== 'totp');
    passkeyArea.classList.toggle('hidden', step !== 'password');
  }

  function handleResult(result) {
    if (result.status === 'ok') {
      window.location.href = '/index.html';
      return;
    }
    if (result.status === 'pending') {
      if (result.needsPasswordChange) return showStep('change-password');
      if (result.needsTotp) return showStep('totp');
    }
  }

  // Bereits angemeldet? Dann direkt weiter.
  Api.get('/api/auth/me')
    .then(() => { window.location.href = '/index.html'; })
    .catch(() => { /* nicht angemeldet - Login-Formular zeigen */ });

  if (!window.SimpleWebAuthnBrowser || !SimpleWebAuthnBrowser.browserSupportsWebAuthn()) {
    passkeyArea.classList.add('hidden');
  }

  stepPassword.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError(errorBox, '');
    const username = $('#username').value.trim();
    const password = $('#password').value;
    const btn = $('#loginBtn');
    btn.disabled = true;
    try {
      const result = await Api.post('/api/auth/login', { username, password });
      handleResult(result);
    } catch (err) {
      setFormError(errorBox, err.message);
    } finally {
      btn.disabled = false;
    }
  });

  stepChangePassword.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError(errorBox, '');
    const p1 = $('#newPassword').value;
    const p2 = $('#newPasswordRepeat').value;
    if (p1.length < 10) return setFormError(errorBox, 'Neues Passwort muss mindestens 10 Zeichen haben.');
    if (p1 !== p2) return setFormError(errorBox, 'Passwoerter stimmen nicht ueberein.');
    try {
      const result = await Api.post('/api/auth/login/change-password', { newPassword: p1 });
      handleResult(result);
    } catch (err) {
      setFormError(errorBox, err.message);
    }
  });

  let useBackup = false;
  $('#toggleBackupBtn').addEventListener('click', () => {
    useBackup = !useBackup;
    $('#totpCodeField').classList.toggle('hidden', useBackup);
    $('#backupCodeField').classList.toggle('hidden', !useBackup);
    $('#toggleBackupBtn').textContent = useBackup
      ? 'Authenticator-Code stattdessen verwenden'
      : 'Backup-Code stattdessen verwenden';
  });

  stepTotp.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError(errorBox, '');
    const body = useBackup
      ? { backupCode: $('#backupCode').value.trim() }
      : { code: $('#totpCode').value.trim() };
    try {
      const result = await Api.post('/api/auth/login/verify-totp', body);
      handleResult(result);
    } catch (err) {
      setFormError(errorBox, err.message);
    }
  });

  $('#passkeyBtn').addEventListener('click', async () => {
    setFormError(errorBox, '');
    try {
      const options = await Api.post('/api/auth/passkey/login-options', {});
      const authResp = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
      const result = await Api.post('/api/auth/passkey/login-verify', authResp);
      handleResult(result);
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        setFormError(errorBox, 'Passkey-Anmeldung abgebrochen oder Zeit abgelaufen.');
      } else {
        setFormError(errorBox, (err && err.message) || 'Passkey-Anmeldung fehlgeschlagen.');
      }
    }
  });
})();
