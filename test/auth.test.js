'use strict';

// Anmeldung im Serverbetrieb (echter Server): Passwort, 2FA mit Authenticator-App, ein Code gilt nur einmal,
// Sperre nach zu vielen falschen Codes, gleiche Antwort für unbekannte Namen. Dazu die 2FA-Hilfen selbst.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const otplib = require('otplib');
const Database = require('better-sqlite3');
const argon2 = require('argon2');

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const code = (secret, offsetSeconds = 0) => otplib.generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + offsetSeconds });

test('2FA-Hilfen: neue Geheimnisse 160 Bit, alte 80-Bit-Geheimnisse gelten weiter, Code nur einmal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-totp-'));
  const env = { ...process.env };
  process.env.LOCAL_MODE = 'true';
  process.env.DATA_DIR = dir;
  delete process.env.ENCRYPTION_KEY;
  const totp = require('../src/lib/totp');
  Object.assign(process.env, env);

  const secret = totp.generateSecret();
  assert.equal(secret.length, 32, '32 Base32-Zeichen = 160 Bit');
  const step = totp.verifyToken(code(secret), secret);
  assert.equal(typeof step, 'number');
  assert.equal(totp.verifyToken(code(secret), secret, { afterTimeStep: step }), false, 'derselbe Code kein zweites Mal');
  assert.equal(typeof totp.verifyToken(code(secret, 30), secret, { afterTimeStep: step }), 'number', 'der nächste Code schon');
  assert.equal(totp.verifyToken(code(secret, 120), secret), false, 'zu weit in der Zukunft');
  for (const bad of ['', 'abcdef', '12345', '1234567', null]) assert.equal(totp.verifyToken(bad, secret), false);
  const legacy = 'JBSWY3DPEHPK3PXP'; // 80 Bit, wie otplib 12 sie erzeugt hat
  assert.equal(typeof totp.verifyToken(otplib.generateSync({ secret: legacy, guardrails: otplib.createGuardrails({ MIN_SECRET_BYTES: 10 }) }), legacy), 'number');
});

test('Serverbetrieb: Anmeldung mit 2FA, Wiederholung abgelehnt, Sperre nach falschen Codes, unbekannte Namen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-auth-'));
  const port = await freePort();
  const env = {
    ...process.env, DATA_DIR: dir, PORT: String(port), LOCAL_MODE: 'false', NODE_ENV: 'test',
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    RP_ID: 'localhost', RP_ORIGIN: `http://localhost:${port}`, COOKIE_SECURE: 'false', TRUST_PROXY: 'false',
    LOGIN_MAX_ATTEMPTS: '5', LOGIN_LOCK_MINUTES: '15',
  };
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: 'ignore' });
  const base = `http://localhost:${port}`;
  try {
    let ok = false;
    for (let i = 0; i < 80 && !ok; i++) { try { ok = (await fetch(`${base}/api/health`)).ok; } catch { await sleep(150); } }
    assert.ok(ok, 'Server startet');

    // Konto direkt in der Datenbank anlegen
    const db = new Database(path.join(dir, 'app.db'));
    db.prepare("INSERT INTO users (username, display_name, password_hash, role, must_change_password) VALUES ('max', 'Max', ?, 'user', 0)").run(await argon2.hash('richtiges-passwort-1', { type: argon2.argon2id }));
    db.close();

    // kleiner Browser: Cookies merken, CSRF-Token holen
    const jar = new Map();
    const remember = (res) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let csrf = '';
    const refreshCsrf = async () => { const r = await fetch(`${base}/api/csrf-token`, { headers: { cookie: cookie() } }); remember(r); csrf = (await r.json()).csrfToken; };
    const post = async (p, body) => {
      const r = await fetch(base + p, { method: 'POST', headers: { cookie: cookie(), 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
      remember(r);
      return { status: r.status, body: await r.json() };
    };
    const login = async (password = 'richtiges-passwort-1') => { await refreshCsrf(); const r = await post('/api/auth/login', { username: 'max', password }); await refreshCsrf(); return r; };

    // unbekannter Name: gleiche Meldung wie falsches Passwort
    await refreshCsrf();
    const unknown = await post('/api/auth/login', { username: 'gibtsnicht', password: 'x'.repeat(12) });
    const wrong = await post('/api/auth/login', { username: 'max', password: 'falsch-falsch' });
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, wrong.body);

    // 2FA einrichten
    let r = await login();
    assert.equal(r.body.status, 'ok');
    r = await post('/api/account/totp/setup');
    const secret = r.body.secret;
    assert.equal(secret.length, 32);
    r = await post('/api/account/totp/confirm', { code: code(secret) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await post('/api/auth/logout');
    jar.clear();

    // Anmelden: der Code der Einrichtung gilt nicht noch einmal, der nächste schon
    r = await login();
    assert.equal(r.body.status, 'pending');
    r = await post('/api/auth/login/verify-totp', { code: code(secret) });
    assert.equal(r.status, 401, 'schon benutzter Code');
    const next = code(secret, 30);
    r = await post('/api/auth/login/verify-totp', { code: next });
    assert.equal(r.body.status, 'ok');
    await post('/api/auth/logout');
    jar.clear();

    // derselbe Code ein zweites Mal (mitgelesen): abgelehnt
    r = await login();
    r = await post('/api/auth/login/verify-totp', { code: next });
    assert.equal(r.status, 401, 'Wiederholung abgelehnt');

    // falsche Codes: nach fünf Fehlversuchen zurück zum Passwort, Konto danach gesperrt
    for (let i = 0; i < 3; i++) r = await post('/api/auth/login/verify-totp', { code: '000000' });
    r = await post('/api/auth/login/verify-totp', { code: '000001' });
    assert.equal(r.body.restart, true, 'nach fünf falschen Codes neu anmelden');
    r = await post('/api/auth/login/verify-totp', { code: code(secret, 30) });
    assert.equal(r.status, 400, 'kein 2FA-Schritt mehr offen');
    r = await login();
    assert.equal(r.status, 423, 'Konto gesperrt – auch mit richtigem Passwort');
  } finally {
    server.kill();
  }
});
