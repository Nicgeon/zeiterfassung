'use strict';

process.env.BERICHTSHEFT_DEBUG = 'aus'; // Tests ohne Diagnose-Ausgabe

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
    assert.equal(r.body.stream, true);
    assert.equal(r.body.temperature, 0.3);
    assert.ok(r.body.max_tokens >= 12000);
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

/** Fake-Server, der Datenstrom (SSE) liefert; chunks werden einzeln mit kleiner Pause geschrieben. */
async function withStreamServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ url: req.url, body: parsed });
      await handler({ req, res, body: parsed, count: requests.length });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`, requests); } finally { server.closeAllConnections(); server.close(); }
}

const sse = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;

test('Noah AI: Antwort als Datenstrom wird zusammengesetzt (auch mit <think> und zerstückelten Zeilen)', async () => {
  await withStreamServer(async ({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const whole = sse({ content: '<think>hm</think>' }) + sse({ content: ANSWER.slice(0, 20) }) + sse({ content: ANSWER.slice(20) }, 'stop') + 'data: [DONE]\n\n';
    for (let i = 0; i < whole.length; i += 37) { res.write(whole.slice(i, i + 37)); await new Promise((r) => setTimeout(r, 2)); }
    res.end();
  }, async (baseUrl, requests) => {
    assert.equal(await generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl }), ANSWER);
    assert.equal(requests[0].body.stream, true);
  });
});

test('Noah AI: antwortet der Server trotz stream:true mit JSON, wird das normal gelesen', async () => {
  await withStreamServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: ANSWER } }] }));
  }, async (baseUrl) => {
    assert.equal(await generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl }), ANSWER);
  });
});

test('Noah AI: kann der Server nicht streamen (400), wird einmal ohne Datenstrom wiederholt', async () => {
  await withStreamServer(({ res, body }) => {
    if (body.stream) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'stream not supported' })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: ANSWER } }] }));
  }, async (baseUrl, requests) => {
    assert.equal(await generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl }), ANSWER);
    assert.deepEqual(requests.map((r) => r.body.stream), [true, false]);
  });
});

test('Datenstrom: Längenlimit, Fehler im Strom, Abbruch und Gateway-Timeout werden verständlich gemeldet', async () => {
  await withStreamServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse({ content: '{"a":' }, 'length'));
  }, async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl }), /Längenlimit/);
  });
  await withStreamServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ error: { message: 'Modell überlastet' } })}\n\n`);
  }, async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl }), /Modell überlastet/);
  });
  await withStreamServer(({ res }) => {
    res.writeHead(504, { 'content-type': 'text/html' });
    res.end('<html>504 Gateway Time-out</html>');
  }, async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl }), (e) => e.status === 504 && /Zeitüberschreitung auf dem Server/.test(e.message) && e.retryable);
  });
  await withStreamServer(async ({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ content: 'x' })); // und dann nichts mehr
  }, async (baseUrl) => {
    await assert.rejects(generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl, timeoutMs: 200 }), /Zeitüberschreitung/);
  });
});

test('Datenstrom schlägt fehl (504, leerer Strom, abgebrochener Strom) -> zweiter Versuch ohne Datenstrom', async () => {
  const jsonOk = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: ANSWER } }] })); };
  for (const brokenStream of [
    (res) => { res.writeHead(504, { 'content-type': 'text/html' }); res.end('Gateway Time-out'); },
    (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: [DONE]\n\n'); }, // nichts geliefert
    (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse({ content: '{"a"' })); }, // ohne Abschluss
  ]) {
    await withStreamServer(({ res, body }) => (body.stream ? brokenStream(res) : jsonOk(res)), async (baseUrl, requests) => {
      assert.equal(await generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl }), ANSWER);
      assert.deepEqual(requests.map((r) => r.body.stream), [true, false]);
    });
  }
});

test('kein zweiter Versuch bei falschem Schlüssel, unbekanntem Modell, Kontingent und Verweigerung; Verlauf hängt am Fehler', async () => {
  for (const status of [401, 404, 429]) {
    await withStreamServer(({ res }) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":"nein"}'); }, async (baseUrl, requests) => {
      await assert.rejects(generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl }), (e) => e.status === status && e.trace.length === 1 && /Versuch mit Datenstrom/.test(e.trace[0]));
      assert.equal(requests.length, 1);
    });
  }
  // beide Versuche scheitern: Verlauf nennt beide
  await withStreamServer(({ res }) => { res.writeHead(502, { 'content-type': 'text/html' }); res.end('bad gateway'); }, async (baseUrl, requests) => {
    await assert.rejects(generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl }), (e) => {
      assert.equal(e.trace.length, 2);
      assert.match(e.trace[0], /^Versuch mit Datenstrom: Fehler/);
      assert.match(e.trace[1], /^Versuch ohne Datenstrom: Fehler/);
      return true;
    });
    assert.equal(requests.length, 2);
  });
});

test('BERICHTSHEFT_STREAM=aus und stream:false: nur ein Versuch ohne Datenstrom', async () => {
  await withStreamServer(({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: ANSWER } }] })); }, async (baseUrl, requests) => {
    assert.equal(await generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl, stream: false }), ANSWER);
    process.env.BERICHTSHEFT_STREAM = 'aus';
    try { await generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl }); } finally { delete process.env.BERICHTSHEFT_STREAM; }
    assert.deepEqual(requests.map((r) => r.body.stream), [false, false]);
  });
});

test('Diagnose-Ausgabe: Stufen, kein Schlüssel im Text', async () => {
  const lines = [];
  const orig = console.error;
  console.error = (m) => lines.push(String(m));
  const prev = process.env.BERICHTSHEFT_DEBUG;
  try {
    await withStreamServer(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse({ content: ANSWER }, 'stop') + 'data: [DONE]\n\n');
    }, async (baseUrl) => {
      process.env.BERICHTSHEFT_DEBUG = '1';
      await generate({ ...base, provider: 'noah', apiKey: 'GEHEIMER-SCHLUESSEL', model: 'm', baseUrl });
      const level1 = lines.join('\n');
      assert.match(level1, /POST .*\/chat\/completions \| Modell m/);
      assert.match(level1, /Antwortkopf nach .*HTTP 200, text\/event-stream/);
      assert.match(level1, /Datenstrom beendet nach .* Blöcke/);
      assert.match(level1, /m: ok nach/);
      assert.doesNotMatch(level1, /System-Prompt:/);
      lines.length = 0;
      process.env.BERICHTSHEFT_DEBUG = 'voll';
      await generate({ ...base, provider: 'noah', apiKey: 'GEHEIMER-SCHLUESSEL', model: 'm', baseUrl });
      assert.match(lines.join('\n'), /System-Prompt:\nSYS/);
      assert.match(lines.join('\n'), /Rohantwort:/);
      process.env.BERICHTSHEFT_DEBUG = '0';
      lines.length = 0;
      await generate({ ...base, provider: 'noah', apiKey: 'GEHEIMER-SCHLUESSEL', model: 'm', baseUrl });
      assert.equal(lines.length, 1); // nur die Zusammenfassung
      process.env.BERICHTSHEFT_DEBUG = 'aus';
      lines.length = 0;
      await generate({ ...base, provider: 'noah', apiKey: 'GEHEIMER-SCHLUESSEL', model: 'm', baseUrl });
      assert.equal(lines.length, 0);
    });
    assert.ok(!lines.some((l) => l.includes('GEHEIMER-SCHLUESSEL')));
  } finally {
    console.error = orig;
    process.env.BERICHTSHEFT_DEBUG = prev === undefined ? 'aus' : prev;
  }
});

test('format "text": keine JSON-Vorgabe, eigenes max_tokens (Noah AI)', async () => {
  await withServer(() => ({ json: { choices: [{ finish_reason: 'stop', message: { content: '4, 7' } }] } }), async (baseUrl, requests) => {
    const text = await generate({ ...base, provider: 'noah', apiKey: 'k', model: 'm', baseUrl, format: 'text', maxTokens: 600, stream: false });
    assert.equal(text, '4, 7');
    assert.equal(requests[0].body.response_format, undefined);
    assert.equal(requests[0].body.max_tokens, 600);
  });
});

test('Diagnose zeigt bei jedem Versuch die Anfrage-Parameter (response_format ...) und mit "voll" den ganzen Body ohne Schlüssel', async () => {
  const lines = [];
  const orig = console.error;
  console.error = (m) => lines.push(String(m));
  const prev = process.env.BERICHTSHEFT_DEBUG;
  try {
    await withStreamServer(({ res }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: ANSWER } }] }));
    }, async (baseUrl) => {
      process.env.BERICHTSHEFT_DEBUG = '1';
      await generate({ ...base, provider: 'noah', apiKey: 'GEHEIMER-SCHLUESSEL', model: 'm', baseUrl, stream: false });
      const out1 = lines.join('\n');
      assert.match(out1, /Anfrage-Parameter: \{"model":"m","response_format":\{"type":"json_object"\},"max_tokens":\d+,"temperature":0\.3,"stream":false\}/);
      assert.doesNotMatch(out1, /Vollständiger Anfrage-Body/);
      lines.length = 0;
      process.env.BERICHTSHEFT_DEBUG = 'voll';
      await generate({ ...base, provider: 'noah', apiKey: 'GEHEIMER-SCHLUESSEL', model: 'm', baseUrl, stream: false });
      const out2 = lines.join('\n');
      assert.match(out2, /Vollständiger Anfrage-Body \(ohne Schlüssel\):\n\{/);
      assert.match(out2, /"response_format": \{\s*"type": "json_object"\s*\}/);
      assert.match(out2, /"messages"/);
      assert.ok(!out2.includes('GEHEIMER-SCHLUESSEL'));
    });
  } finally {
    console.error = orig;
    process.env.BERICHTSHEFT_DEBUG = prev === undefined ? 'aus' : prev;
  }
});
