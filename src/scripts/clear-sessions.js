'use strict';

// Beendet ALLE aktiven Sitzungen sofort (alle Nutzer muessen sich neu
// anmelden). Fuer Sicherheitsvorfaelle gedacht.
//
// Nutzung:  docker compose exec app npm run clear-sessions

const { db, audit } = require('../db');

const info = db.prepare('DELETE FROM sessions').run();
audit(null, 'all_sessions_cleared', `count=${info.changes}`, 'cli');
console.log(`${info.changes} Sitzung(en) beendet. Alle Nutzer muessen sich neu anmelden.`);
process.exit(0);
