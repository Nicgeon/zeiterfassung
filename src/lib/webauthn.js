'use strict';

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const config = require('../config');

const rpName = config.rpName;

/**
 * Ermittelt Domain und Origin fuer die Anfrage. Ist die App unter mehreren
 * Domains erreichbar (RP_ORIGINS), gilt jeweils die, ueber die die Person
 * gerade zugreift. Unbekannte Hostnamen fallen auf die Hauptdomain zurueck.
 */
const warnedHosts = new Set();

function rpFor(req) {
  const host = req && req.hostname;
  const origin = config.originByHost.get(host);
  if (origin) return { rpID: host, origin };

  // Unbekannte Adresse: Rueckfall auf die Hauptdomain. Das fuehrt im Browser
  // zu "'rp.id' cannot be used with the current origin", deshalb hier ein
  // deutlicher Hinweis statt stiller Fehlschlaege.
  if (host && !warnedHosts.has(host)) {
    warnedHosts.add(host);
    // eslint-disable-next-line no-console
    console.warn(
      `[WARNUNG] Passkey-Anfrage von der Adresse "${host}", die nicht konfiguriert ist. ` +
        `Bekannt sind: ${[...config.originByHost.keys()].join(', ')}. ` +
        'Passkeys werden unter dieser Adresse NICHT funktionieren. ' +
        'Bitte "https://' + host + '" in RP_ORIGINS eintragen und den Container neu erstellen ' +
        '(docker compose up -d --force-recreate).'
    );
  }
  return { rpID: config.rpId, origin: config.rpOrigin };
}

function toUserIdBuffer(numericUserId) {
  // simplewebauthn wants a byte handle for the user, not the raw DB id.
  // A deterministic 8-byte encoding of the integer id keeps things simple
  // and stable across registrations for the same account.
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(numericUserId));
  return new Uint8Array(buf);
}

async function buildRegistrationOptions({ req, userId, username, displayName, existingCredentials }) {
  const { rpID } = rpFor(req);
  return generateRegistrationOptions({
    rpName,
    rpID,
    userID: toUserIdBuffer(userId),
    userName: username,
    userDisplayName: displayName,
    attestationType: 'none',
    excludeCredentials: existingCredentials.map((c) => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
}

async function verifyRegistration({ req, response, expectedChallenge }) {
  const { rpID, origin } = rpFor(req);
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });
}

async function buildAuthenticationOptions({ req, allowCredentials } = {}) {
  const { rpID } = rpFor(req);
  return generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials: allowCredentials && allowCredentials.length
      ? allowCredentials.map((c) => ({
          id: c.credential_id,
          transports: c.transports ? JSON.parse(c.transports) : undefined,
        }))
      : undefined,
  });
}

async function verifyAuthentication({ req, response, expectedChallenge, passkeyRow }) {
  const { rpID, origin } = rpFor(req);
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: passkeyRow.credential_id,
      publicKey: new Uint8Array(Buffer.from(passkeyRow.public_key, 'base64')),
      counter: passkeyRow.counter,
      transports: passkeyRow.transports ? JSON.parse(passkeyRow.transports) : undefined,
    },
  });
}

module.exports = {
  rpFor,
  buildRegistrationOptions,
  verifyRegistration,
  buildAuthenticationOptions,
  verifyAuthentication,
};
