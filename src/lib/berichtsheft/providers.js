'use strict';

// Anbindung der KI-Anbieter. Alle bekommen dieselbe Eingabe (bereits anonymisierter Text) und
// liefern den Antworttext (JSON) zurück. Claude läuft über das offizielle SDK, ChatGPT/OpenAI und
// Gemini über ihre REST-Schnittstellen; "kompatibel" spricht jede OpenAI-kompatible Adresse an
// (z. B. ein lokales Modell, dann verlässt nichts den Rechner).

const Anthropic = require('@anthropic-ai/sdk');
const { SCHEMA } = require('./prompt');
const { log, level, snippet, secs } = require('./debug');

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_TOKENS = 4000;

const BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  noah: 'https://ai.noahkoning.de/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

class ProviderError extends Error {
  constructor(message, { status, retryable, final } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = !!retryable;
    this.final = !!final; // ein weiterer Versuch (ohne Datenstrom) wuerde nichts aendern
    this.trace = [];
  }
}

const NAMES = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini', noah: 'Noah AI', kompatibel: 'Der Anbieter' };

// Selbst gehostete Modelle (Qwen3 ...) sind langsam und denken oft laut: viel Zeit, viel Platz, ruhige
// Ausgabe. Die Antwort wird als Datenstrom gelesen, damit Proxys zwischen hier und dem Modell die
// Verbindung nicht wegen "keine Daten seit 120 s" kappen.
const LOCAL_MODEL_TIMEOUT_MS = 900_000;
const LOCAL_MODEL_MAX_TOKENS = 16000;

function explainStatus(provider, status, detail, model) {
  const name = NAMES[provider] || 'Der Anbieter';
  const tail = detail ? ` (${String(detail).slice(0, 300)})` : '';
  if (status === 401 || status === 403) return `${name} lehnt den API-Schlüssel ab (${status}). Bitte "berichtsheft einrichten" ausführen oder den Schlüssel prüfen${tail}.`;
  if (status === 404) return `${name} kennt das Modell "${model}" nicht oder es ist für diesen Schlüssel nicht freigeschaltet. "berichtsheft modelle" zeigt die verfügbaren Modelle${tail}.`;
  if (status === 429) return `${name}: Zu viele Anfragen oder das Guthaben/Kontingent ist aufgebraucht (429). Später erneut versuchen${tail}.`;
  if (status === 402) return `${name}: Abrechnungsproblem (402). Bitte das Konto des Anbieters prüfen${tail}.`;
  if (status === 408 || status === 504 || status === 502) {
    return `${name}: Zeitüberschreitung auf dem Server (${status}) – die Anfrage hat zu lange gedauert. Bitte das schnellere Modell wählen oder es später erneut versuchen${tail}.`;
  }
  if (status >= 500) return `${name} ist gerade gestört (${status}). Später erneut versuchen${tail}.`;
  return `${name} meldet einen Fehler (${status})${tail}.`;
}

async function rawFetch(provider, url, { method = 'POST', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }) {
  try {
    return await fetchImpl(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw mapNetworkError(provider, err, timeoutMs);
  }
}

function mapNetworkError(provider, err, timeoutMs) {
  if (err instanceof ProviderError) return err;
  const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return new ProviderError(
    timedOut ? `${NAMES[provider]}: Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s.` : `${NAMES[provider]} nicht erreichbar: ${err.message}`,
    { retryable: true }
  );
}

function parseJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function failFromResponse(provider, res, text, model) {
  const data = parseJson(text);
  const detail = (data && (data.error && (data.error.message || data.error))) || text;
  return new ProviderError(explainStatus(provider, res.status, typeof detail === 'string' ? detail : JSON.stringify(detail), model), {
    status: res.status,
    retryable: res.status === 429 || res.status >= 500,
  });
}

async function httpJson(provider, url, opts) {
  const res = await rawFetch(provider, url, opts);
  let text;
  try { text = await res.text(); } catch (err) { throw mapNetworkError(provider, err, opts.timeoutMs || DEFAULT_TIMEOUT_MS); }
  if (!res.ok) throw failFromResponse(provider, res, text, opts.model);
  return parseJson(text);
}

// --- Claude (offizielles SDK) -------------------------------------------------

function anthropicClient({ apiKey, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Anthropic({ apiKey, baseURL: baseUrl || undefined, timeout: timeoutMs, maxRetries: 2 });
}

/** Niedrigen Denkaufwand nur dort senden, wo die Modelle den Parameter kennen. */
function supportsEffort(model) {
  return /^claude-(haiku-5|sonnet-5|opus-5|opus-4-[6-9]|fable|mythos)/.test(model);
}

function mapAnthropicError(err, model) {
  if (err instanceof Anthropic.APIError && err.status) {
    return new ProviderError(explainStatus('anthropic', err.status, err.message, model), {
      status: err.status,
      retryable: err.status === 429 || err.status >= 500,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`Claude nicht erreichbar: ${err.message}`, { retryable: true });
  }
  return err;
}

async function callAnthropic({ apiKey, model, system, user, baseUrl, timeoutMs }) {
  log(1, `Claude-Anfrage | Modell ${model} | System ${system.length} + Nutzer ${user.length} Zeichen`);
  const client = anthropicClient({ apiKey, baseUrl, timeoutMs });
  const outputConfig = { format: { type: 'json_schema', schema: SCHEMA } };
  if (supportsEffort(model)) outputConfig.effort = 'low';
  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: outputConfig,
    });
  } catch (err) {
    throw mapAnthropicError(err, model);
  }
  log(1, `Claude-Antwort: Ende ${response.stop_reason}, Tokens ein ${response.usage && response.usage.input_tokens} / aus ${response.usage && response.usage.output_tokens}`);
  if (response.stop_reason === 'refusal') throw new ProviderError('Claude hat die Anfrage abgelehnt (Sicherheitsfilter).');
  if (response.stop_reason === 'max_tokens') throw new ProviderError('Die Antwort wurde abgeschnitten (max_tokens erreicht).', { retryable: true });
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// --- OpenAI und kompatible -----------------------------------------------------

/** Qwen3 & Co. liefern vor der Antwort einen <think>-Block; er gehoert nicht zum Text. */
function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

/** Liest eine "text/event-stream"-Antwort (OpenAI-Format) und sammelt den Text. */
async function readEventStream(provider, res, timeoutMs) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const started = Date.now();
  const out = { content: '', finish: null, refusal: null, done: false, chunks: 0, bytes: 0, firstTokenMs: null };
  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { out.done = true; return; }
    if (!payload) return;
    const json = parseJson(payload);
    if (!json) return;
    if (json.error) throw new ProviderError(`${NAMES[provider]}: ${typeof json.error === 'string' ? json.error : json.error.message || 'Fehler im Datenstrom'}`, { retryable: true });
    const choice = json.choices && json.choices[0];
    if (!choice) return;
    if (choice.delta && typeof choice.delta.content === 'string' && choice.delta.content) {
      if (out.firstTokenMs === null) out.firstTokenMs = Date.now() - started;
      out.content += choice.delta.content;
    }
    if (choice.delta && choice.delta.refusal) out.refusal = choice.delta.refusal;
    if (choice.finish_reason) out.finish = choice.finish_reason;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.chunks += 1;
      out.bytes += value.length;
      if (out.chunks === 1) log(1, `Datenstrom: erster Block nach ${secs(Date.now() - started)}`);
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, nl).trim());
        buffer = buffer.slice(nl + 1);
      }
    }
    handle(buffer.trim());
  } catch (err) {
    log(0, `Datenstrom abgebrochen nach ${secs(Date.now() - started)} (${out.chunks} Blöcke, ${out.bytes} Bytes, ${out.content.length} Zeichen Text): ${err.message}`);
    throw mapNetworkError(provider, err, timeoutMs);
  }
  log(1, `Datenstrom beendet nach ${secs(Date.now() - started)}: ${out.chunks} Blöcke, ${out.bytes} Bytes, ${out.content.length} Zeichen Text, erstes Token nach ${out.firstTokenMs === null ? '-' : secs(out.firstTokenMs)}, [DONE]: ${out.done ? 'ja' : 'nein'}`);
  if (!out.done && !out.finish) {
    throw new ProviderError('Der Datenstrom wurde vorzeitig beendet (kein Abschluss vom Server).', { retryable: true });
  }
  return out;
}

function finishOpenAi(provider, { content, finish, refusal }) {
  if (refusal) throw new ProviderError(`Die Anfrage wurde abgelehnt: ${refusal}`, { final: true });
  if (finish === 'length') {
    throw new ProviderError('Die Antwort wurde abgeschnitten (Längenlimit erreicht – das Modell hat zu lange "nachgedacht" oder zu viel geschrieben).', { retryable: true, final: true });
  }
  const text = stripThinking(content);
  const stripped = String(content || '').length - text.length;
  log(1, `Antwort: ${String(content || '').length} Zeichen roh, davon ${stripped} Zeichen <think>-Block entfernt, Ende: ${finish || 'unbekannt'}`);
  log(2, `Rohantwort:\n${content}`);
  if (!text) throw new ProviderError(`${NAMES[provider] || 'Der Anbieter'} lieferte eine leere Antwort.`, { retryable: true });
  return text;
}

/** Wann lohnt nach einem fehlgeschlagenen Streaming-Versuch ein zweiter ohne Datenstrom? */
function worthRetryWithoutStream(err) {
  if (err.final) return false;
  return ![401, 402, 403, 404, 429].includes(err.status);
}

async function callOpenAi({ provider, apiKey, model, system, user, baseUrl, timeoutMs, fetchImpl, stream }) {
  const base = (baseUrl || BASE_URLS[provider] || BASE_URLS.openai).replace(/\/+$/, '');
  const strict = provider === 'openai';
  const selfHosted = provider !== 'openai'; // Noah AI und "kompatibel"
  const url = `${base}/chat/completions`;
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const limit = timeoutMs || (selfHosted ? LOCAL_MODEL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const body = {
    model,
    // Qwen3: "/no_think" schaltet das laute Nachdenken aus (andere Modelle behandeln es als normalen Text)
    messages: [{ role: 'system', content: system }, { role: 'user', content: provider === 'noah' ? `${user}\n\n/no_think` : user }],
    response_format: strict
      ? { type: 'json_schema', json_schema: { name: 'berichtsheft', strict: true, schema: SCHEMA } }
      : { type: 'json_object' },
  };
  log(1, `POST ${url} | Modell ${model} | System ${system.length} + Nutzer ${body.messages[1].content.length} Zeichen | Antwortformat ${body.response_format.type}`);
  log(2, `System-Prompt:\n${system}\n--- Nutzernachricht:\n${body.messages[1].content}`);

  if (!selfHosted) {
    body.max_completion_tokens = MAX_OUTPUT_TOKENS;
    const data = await httpJson(provider, url, { headers, timeoutMs: limit, model, fetchImpl, body });
    return readCompletion(provider, data);
  }

  body.max_tokens = LOCAL_MODEL_MAX_TOKENS;
  body.temperature = 0.3;

  // Erst als Datenstrom; scheitert das aus anderem Grund als Schluessel/Modell/Kontingent, einmal ohne.
  const streamingWanted = stream !== false && !['aus', '0', 'false', 'nein'].includes(String(process.env.BERICHTSHEFT_STREAM || '').toLowerCase());
  if (!streamingWanted) log(0, 'Datenstrom ist abgeschaltet (BERICHTSHEFT_STREAM=aus bzw. --kein-stream): nur ein Versuch ohne Datenstrom.');
  const modes = streamingWanted ? [true, false] : [false];
  const deadline = Date.now() + limit;
  const trace = [];
  let lastError;
  for (let i = 0; i < modes.length; i++) {
    const useStream = modes[i];
    const remaining = deadline - Date.now();
    if (i > 0 && remaining < Math.min(30_000, limit * 0.2)) {
      trace.push(`Zweiter Versuch ausgelassen: nur noch ${secs(remaining)} Gesamtzeit übrig.`);
      break;
    }
    const label = useStream ? 'Versuch mit Datenstrom' : 'Versuch ohne Datenstrom';
    const started = Date.now();
    log(1, `${label} (max_tokens ${body.max_tokens}, Zeitlimit ${secs(remaining)})`);
    try {
      const text = await oneSelfHostedAttempt({ provider, url, headers, body: { ...body, stream: useStream }, timeoutMs: remaining, model, fetchImpl });
      trace.push(`${label}: ok nach ${secs(Date.now() - started)}`);
      return text;
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      trace.push(`${label}: Fehler nach ${secs(Date.now() - started)} – ${reason}`);
      log(0, `${label} fehlgeschlagen nach ${secs(Date.now() - started)}: ${reason}`);
      lastError = err;
      if (!(err instanceof ProviderError)) break;
      if (!useStream || i === modes.length - 1 || !worthRetryWithoutStream(err)) break;
      log(0, 'Datenstrom hat nicht funktioniert – neuer Versuch ohne Datenstrom …');
    }
  }
  if (lastError && typeof lastError === 'object') lastError.trace = trace;
  throw lastError;
}

async function oneSelfHostedAttempt({ provider, url, headers, body, timeoutMs, model, fetchImpl }) {
  const started = Date.now();
  const res = await rawFetch(provider, url, { headers, body, timeoutMs, fetchImpl });
  log(1, `Antwortkopf nach ${secs(Date.now() - started)}: HTTP ${res.status}, ${res.headers.get('content-type') || 'ohne Inhaltstyp'}`);
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch { /* egal */ }
    log(1, `Fehlerantwort: ${snippet(text)}`);
    throw failFromResponse(provider, res, text, model);
  }
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    return finishOpenAi(provider, await readEventStream(provider, res, timeoutMs));
  }
  let text;
  try { text = await res.text(); } catch (err) { throw mapNetworkError(provider, err, timeoutMs); }
  log(1, `Antwort ohne Datenstrom nach ${secs(Date.now() - started)}: ${text.length} Zeichen`);
  return readCompletion(provider, parseJson(text));
}

function readCompletion(provider, data) {
  const choice = data && data.choices && data.choices[0];
  const message = choice && choice.message;
  if (!message) throw new ProviderError('Die Antwort enthielt keinen Text.');
  return finishOpenAi(provider, { content: message.content, finish: choice.finish_reason, refusal: message.refusal });
}

// --- Gemini ----------------------------------------------------------------------

async function callGemini({ apiKey, model, system, user, baseUrl, timeoutMs, fetchImpl }) {
  const base = (baseUrl || BASE_URLS.gemini).replace(/\/+$/, '');
  log(1, `Gemini-Anfrage | Modell ${model} | System ${system.length} + Nutzer ${user.length} Zeichen`);
  const data = await httpJson('gemini', `${base}/models/${encodeURIComponent(model)}:generateContent`, {
    headers: { 'x-goog-api-key': apiKey },
    timeoutMs,
    model,
    fetchImpl,
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
  });
  if (data && data.promptFeedback && data.promptFeedback.blockReason) {
    throw new ProviderError(`Gemini hat die Anfrage blockiert (${data.promptFeedback.blockReason}).`);
  }
  const candidate = data && data.candidates && data.candidates[0];
  if (!candidate) throw new ProviderError('Gemini lieferte keine Antwort.');
  if (candidate.finishReason === 'MAX_TOKENS') throw new ProviderError('Die Antwort wurde abgeschnitten (Längenlimit).', { retryable: true });
  const parts = (candidate.content && candidate.content.parts) || [];
  return parts.map((p) => p.text || '').join('');
}

/**
 * Eine Anfrage an den gewählten Anbieter; liefert den Antworttext.
 * @param {{provider: string, apiKey?: string, model: string, system: string, user: string, baseUrl?: string, timeoutMs?: number, fetchImpl?: Function}} opts
 */
async function generate(opts) {
  const started = Date.now();
  const tag = `${opts.provider}/${opts.model}`;
  try {
    let text;
    switch (opts.provider) {
      case 'anthropic': text = await callAnthropic(opts); break;
      case 'openai':
      case 'noah':
      case 'kompatibel': text = await callOpenAi(opts); break;
      case 'gemini': text = await callGemini(opts); break;
      default: throw new ProviderError(`Unbekannter Anbieter "${opts.provider}".`);
    }
    log(0, `${tag}: ok nach ${secs(Date.now() - started)}, ${text.length} Zeichen Antwort`);
    log(1, `Antwort (Anfang): ${snippet(text, 300)}`);
    return text;
  } catch (err) {
    log(0, `${tag}: FEHLER nach ${secs(Date.now() - started)} – ${err.message}`);
    if (level() >= 1 && err.trace && err.trace.length) log(1, `Verlauf:\n  ${err.trace.join('\n  ')}`);
    throw err;
  }
}

/** Modell-IDs des Anbieters (zum Auswählen und Prüfen des Schlüssels). */
async function listModels({ provider, apiKey, baseUrl, timeoutMs = 20_000, fetchImpl }) {
  if (provider === 'anthropic') {
    try {
      const page = await anthropicClient({ apiKey, baseUrl, timeoutMs }).models.list({ limit: 100 });
      const ids = [];
      for await (const m of page) ids.push(m.id);
      return ids;
    } catch (err) {
      throw mapAnthropicError(err, '');
    }
  }
  if (provider === 'gemini') {
    const base = (baseUrl || BASE_URLS.gemini).replace(/\/+$/, '');
    const data = await httpJson('gemini', `${base}/models?pageSize=200`, { method: 'GET', headers: { 'x-goog-api-key': apiKey }, timeoutMs, fetchImpl });
    return ((data && data.models) || [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''));
  }
  const base = (baseUrl || BASE_URLS[provider] || BASE_URLS.openai).replace(/\/+$/, '');
  const data = await httpJson(provider, `${base}/models`, { method: 'GET', headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, timeoutMs, fetchImpl });
  return ((data && data.data) || []).map((m) => m.id);
}

module.exports = { generate, listModels, ProviderError, supportsEffort, BASE_URLS };
