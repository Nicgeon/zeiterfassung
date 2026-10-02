'use strict';

/**
 * Kleiner fetch-Wrapper:
 *  - haengt bei aenderenden Requests automatisch den CSRF-Token an
 *  - leitet bei 401 automatisch zur Login-Seite um (ausser auf login.html selbst)
 *  - wirft bei Fehlern ein Error-Objekt mit .message aus der API-Antwort
 */
const Api = (() => {
  let csrfToken = null;

  async function fetchCsrfToken(force) {
    if (csrfToken && !force) return csrfToken;
    const res = await fetch('/api/csrf-token', { credentials: 'same-origin' });
    if (!res.ok) {
      throw new Error('Sicherheits-Token konnte nicht geladen werden. Bitte Seite neu laden.');
    }
    const data = await res.json();
    csrfToken = data.csrfToken;
    return csrfToken;
  }

  function isOnLoginPage() {
    return /\/login\.html$/.test(location.pathname);
  }

  async function request(method, path, body, { retry = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const needsCsrf = method !== 'GET';
    if (needsCsrf) headers['X-CSRF-Token'] = await fetchCsrfToken(false);

    const res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && !isOnLoginPage()) {
      window.location.href = '/login.html';
      return new Promise(() => {}); // never resolves; we're navigating away
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.status === 403 && data && data.error && /Sicherheitstoken/.test(data.error) && retry) {
      await fetchCsrfToken(true);
      return request(method, path, body, { retry: false });
    }

    if (!res.ok) {
      const err = new Error((data && data.error) || `Fehler (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body ?? {}),
    put: (path, body) => request('PUT', path, body ?? {}),
    patch: (path, body) => request('PATCH', path, body ?? {}),
    del: (path) => request('DELETE', path),
    primeCsrf: () => fetchCsrfToken(false),
  };
})();
