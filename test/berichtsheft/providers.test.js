'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generate, listModels, ProviderError } = require('../../src/lib/berichtsheft/providers');

const ANSWER = JSON.stringify({ zuordnung: [{ id: 1, block: 'betrieb' }], betrieb: 'Text.', schule: '' });

/** Kleiner Fake-Server; handler(req, body) -> {status, json} */
async function withServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { /* leer */ }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
      const { status = 200, json } = handler({ url: req.url, method: req.method, body: parsed });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { await fn(baseUrl, requests); } finally { server.close(); }
}

const base = { system: 'SYS', user: 'USER', timeoutMs: 5000 };

test('Claude: Anfrage mit JSON-Schema, Antworttext wird zurückgegeben', async () => {
  await withServer(() => ({
    json: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: ANSWER }], usage: { input_tokens: 1, output_tokens: 1 } },
  }), async (baseUrl, requests) => {
    const text = await generate({ ...base, provider: 'anthropic', apiKey: 'sk-test', model: 'claude-haiku-5-5', baseUrl });
    assert.equal(text, ANSWER);
    const r = requests[0];
    assert.equal(r.url, '/v1/messages');
    assert.ok(r.headers['x-api-key'] === 'sk-test' || r.headers.authorization === 'Bearer sk-test'); // das SDK wählt den Header selbst
    assert.equal(r.body.model, 'claude-haiku-5-5');
    assert.equal(r.body.system, 'SYS');
    assert.equal(r.body.output_config.format.type, 'json_schema');
    assert.equal(r.body.output_config.effort, 'low');
    assert.equal(r.body.temperature, undefined);
  });
});

test('Claude: ältere Modelle bekommen keinen effort-Parameter', async () => {
  await withServer(() => ({
    json: { id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: ANSWER }], usage: { input_tokens: 1, output_tokens: 1 } },
  }), async (baseUrl, requests) => {
    await generate({ ...base, provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5', baseUrl });
    assert.equal(requests[0].body.output_config.effort, undefined);
  });
});

test('Claude: 401 und 404 werden verständlich erklärt, Refusal erkannt', async () => {
  await withServer(() => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }), async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'anthropic', apiKey: 'bad', model: 'm', baseUrl }), (e) => e instanceof ProviderError && /Schlüssel/.test(e.message) && e.status === 401);
  });
  await withServer(() => ({ status: 404, json: { type: 'error', error: { type: 'not_found_error', message: 'model: x' } } }), async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'anthropic', apiKey: 'k', model: 'x', baseUrl }), /Modell "x"/);
  });
  await withServer(() => ({ json: { id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'refusal', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }), async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'anthropic', apiKey: 'k', model: 'm', baseUrl }), /abgelehnt/);
  });
});

test('OpenAI: Chat-Completions mit strengem JSON-Schema', async () => {
  await withServer(() => ({ json: { choices: [{ finish_reason: 'stop', message: { content: ANSWER } }] } }), async (baseUrl, requests) => {
    const text = await generate({ ...base, provider: 'openai', apiKey: 'sk-o', model: 'gpt-x', baseUrl });
    assert.equal(text, ANSWER);
    const r = requests[0];
    assert.equal(r.url, '/chat/completions');
    assert.equal(r.headers.authorization, 'Bearer sk-o');
    assert.equal(r.body.response_format.type, 'json_schema');
    assert.equal(r.body.response_format.json_schema.strict, true);
    assert.equal(r.body.messages[0].role, 'system');
  });
});

test('OpenAI-kompatibel: json_object, auch ohne Schlüssel', async () => {
  await withServer(() => ({ json: { choices: [{ finish_reason: 'stop', message: { content: ANSWER } }] } }), async (baseUrl, requests) => {
    await generate({ ...base, provider: 'kompatibel', apiKey: '', model: 'llama', baseUrl });
    assert.equal(requests[0].body.response_format.type, 'json_object');
    assert.equal(requests[0].headers.authorization, undefined);
  });
});

test('OpenAI: Fehlerstatus, Refusal und abgeschnittene Antwort', async () => {
  await withServer(() => ({ status: 429, json: { error: { message: 'quota' } } }), async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'openai', apiKey: 'k', model: 'm', baseUrl }), (e) => e.status === 429 && e.retryable && /Kontingent/.test(e.message));
  });
  await withServer(() => ({ json: { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'nein' } }] } }), async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'openai', apiKey: 'k', model: 'm', baseUrl }), /abgelehnt/);
  });
  await withServer(() => ({ json: { choices: [{ finish_reason: 'length', message: { content: '{' } }] } }), async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'openai', apiKey: 'k', model: 'm', baseUrl }), /abgeschnitten/);
  });
});

test('Gemini: generateContent mit Schlüssel im Header und JSON-MIME-Typ', async () => {
  await withServer(() => ({ json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: ANSWER }] } }] } }), async (baseUrl, requests) => {
    const text = await generate({ ...base, provider: 'gemini', apiKey: 'g-key', model: 'gemini-x', baseUrl });
    assert.equal(text, ANSWER);
    const r = requests[0];
    assert.equal(r.url, '/models/gemini-x:generateContent');
    assert.equal(r.headers['x-goog-api-key'], 'g-key');
    assert.equal(r.body.generationConfig.responseMimeType, 'application/json');
    assert.equal(r.body.systemInstruction.parts[0].text, 'SYS');
  });
});

test('Gemini: blockierte Anfrage und fehlende Kandidaten', async () => {
  await withServer(() => ({ json: { promptFeedback: { blockReason: 'SAFETY' } } }), async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'gemini', apiKey: 'k', model: 'm', baseUrl }), /blockiert/);
  });
  await withServer(() => ({ json: {} }), async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'gemini', apiKey: 'k', model: 'm', baseUrl }), /keine Antwort/);
  });
});

test('nicht erreichbar und Zeitüberschreitung sind wiederholbare Fehler', async () => {
  await assert.rejects(generate({ ...base, provider: 'openai', apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1:1' }), (e) => e.retryable && /nicht erreichbar/.test(e.message));
  const server = http.createServer(() => { /* antwortet nie */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      generate({ ...base, provider: 'openai', apiKey: 'k', model: 'm', baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 150 }),
      /Zeitüberschreitung/);
  } finally { server.closeAllConnections(); server.close(); }
});

test('listModels für alle Anbieter', async () => {
  await withServer(() => ({ json: { data: [{ id: 'm1', type: 'model' }], has_more: false, first_id: 'm1', last_id: 'm1' } }), async (baseUrl) => {
    assert.deepEqual(await listModels({ provider: 'anthropic', apiKey: 'k', baseUrl }), ['m1']);
  });
  await withServer(() => ({ json: { data: [{ id: 'gpt-a' }, { id: 'gpt-b' }] } }), async (baseUrl) => {
    assert.deepEqual(await listModels({ provider: 'openai', apiKey: 'k', baseUrl }), ['gpt-a', 'gpt-b']);
  });
  await withServer(() => ({ json: { models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }, { name: 'models/emb', supportedGenerationMethods: ['embedContent'] }] } }), async (baseUrl) => {
    assert.deepEqual(await listModels({ provider: 'gemini', apiKey: 'k', baseUrl }), ['gemini-a']);
  });
});

test('Noah AI: OpenAI-kompatibel, Bearer-Schlüssel, ruhige Ausgabe, <think>-Block wird entfernt', async () => {
  await withServer(() => ({
    json: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `<think>\nIch überlege ...\n</think>\n\n${ANSWER}` } }] },
  }), async (baseUrl, requests) => {
    const text = await generate({ ...base, provider: 'noah', apiKey: 'noah-key', model: 'Qwen3-30B-A3B-Q4_K_M', baseUrl });
    assert.equal(text, ANSWER);
    const r = requests[0];
    assert.equal(r.url, '/chat/completions');
    assert.equal(r.headers.authorization, 'Bearer noah-key');
    assert.equal(r.body.model, 'Qwen3-30B-A3B-Q4_K_M');
    assert.equal(r.body.response_format.type, 'json_object');
    assert.equal(r.body.stream, false);
    assert.equal(r.body.temperature, 0.3);
    assert.ok(r.body.max_tokens >= 4000);
    assert.equal(r.body.max_completion_tokens, undefined);
    assert.match(r.body.messages[1].content, /\/no_think$/);
  });
});

test('Noah AI: nur schließendes </think>, leere Antwort und Fehlerstatus', async () => {
  await withServer(() => ({ json: { choices: [{ finish_reason: 'stop', message: { content: `Nachgedacht.\n</think>\n${ANSWER}` } }] } }), async (baseUrl) => {
    assert.equal(await generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl }), ANSWER);
  });
  await withServer(() => ({ json: { choices: [{ finish_reason: 'stop', message: { content: '<think>nur gedacht</think>' } }] } }), async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl }), /leere Antwort/);
  });
  await withServer(() => ({ status: 401, json: { error: 'Invalid or missing API key' } }), async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'noah', apiKey: 'falsch', model: 'm', baseUrl }), (e) => e.status === 401 && /Noah AI lehnt den API-Schlüssel ab/.test(e.message));
  });
});

test('Noah AI: Modelle auflisten', async () => {
  await withServer(() => ({ json: { data: [{ id: 'Qwen3-4B-Q4_K_M' }, { id: 'Qwen3-30B-A3B-Q4_K_M' }] } }), async (baseUrl, requests) => {
    assert.deepEqual(await listModels({ provider: 'noah', apiKey: 'k', baseUrl }), ['Qwen3-4B-Q4_K_M', 'Qwen3-30B-A3B-Q4_K_M']);
    assert.equal(requests[0].url, '/models');
    assert.equal(requests[0].headers.authorization, 'Bearer k');
  });
});
