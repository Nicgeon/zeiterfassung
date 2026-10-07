'use strict';

// Gleiche Bezeichnungen wie im Team-Bereich der Website (public/js/admin.js).
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
  update_installed: 'Update installiert',
};

function labelFor(event) {
  return EVENT_LABELS[event] || event;
}

// Einheitliches Zeitformat fuer Konsole und CLI, z.B. "22.09.2026, 12:49:10"
const FORMAT_OPTIONS = {
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
};
let formatter;
try {
  formatter = new Intl.DateTimeFormat('de-DE', { ...FORMAT_OPTIONS, timeZone: process.env.LOG_TIMEZONE || 'Europe/Berlin' });
} catch {
  formatter = new Intl.DateTimeFormat('de-DE', { ...FORMAT_OPTIONS, timeZone: 'UTC' });
}
function formatTimestamp(date) {
  return formatter.format(date);
}

module.exports = { EVENT_LABELS, labelFor, formatTimestamp };
