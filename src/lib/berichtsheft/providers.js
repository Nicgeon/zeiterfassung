'use strict';

// Anbindung der KI-Anbieter. Alle bekommen dieselbe Eingabe (bereits anonymisierter Text) und
// liefern den Antworttext (JSON) zurück. Claude läuft über das offizielle SDK, ChatGPT/OpenAI und
// Gemini über ihre REST-Schnittstellen; "kompatibel" spricht jede OpenAI-kompatible Adresse an
// (z. B. ein lokales Modell, dann verlässt nichts den Rechner).

const Anthropic = require('@anthropic-ai/sdk');
const { SCHEMA } = require('./prompt');

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_TOKENS = 4000;

const BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  noah: 'https://ai.noahkoning.de/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

class ProviderError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = !!retryable;
  }
}

const NAMES = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini', noah: 'Noah AI', kompatibel: 'Der Anbieter' };

// Selbst gehostete Modelle (Qwen3 ...) denken oft laut und sind langsamer: mehr Zeit und Platz, ruhigere Ausgabe.
const LOCAL_MODEL_TIMEOUT_MS = 180_000;
const LOCAL_MODEL_MAX_TOKENS = 8000;

function explainStatus(provider, status, detail, model) {
  const name = NAMES[provider] || 'Der Anbieter';
  const tail = detail ? ` (${String(detail).slice(0, 300)})` : '';
  if (status === 401 || status === 403) return `${name} lehnt den API-Schlüssel ab (${status}). Bitte "berichtsheft einrichten" ausführen oder den Schlüssel prüfen${tail}.`;
  if (status === 404) return `${name} kennt das Modell "${model}" nicht oder es ist für diesen Schlüssel nicht freigeschaltet. "berichtsheft modelle" zeigt die verfügbaren Modelle${tail}.`;
  if (status === 429) return `${name}: Zu viele Anfragen oder das Guthaben/Kontingent ist aufgebraucht (429). Später erneut versuchen${tail}.`;
  if (status === 402) return `${name}: Abrechnungsproblem (402). Bitte das Konto des Anbieters prüfen${tail}.`;
  if (status >= 500) return `${name} ist gerade gestört (${status}). Später erneut versuchen${tail}.`;
  return `${name} meldet einen Fehler (${status})${tail}.`;
}

async function httpJson(provider, url, { method = 'POST', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, model, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ProviderError(
      timedOut ? `${NAMES[provider]}: Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s.` : `${NAMES[provider]} nicht erreichbar: ${err.message}`,
      { retryable: true }
    );
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
  if (!res.ok) {
    const detail = (data && (data.error && (data.error.message || data.error))) || text;
    throw new ProviderError(explainStatus(provider, res.status, typeof detail === 'string' ? detail : JSON.stringify(detail), model), {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  return data;
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
  if (response.stop_reason === 'refusal') throw new ProviderError('Claude hat die Anfrage abgelehnt (Sicherheitsfilter).');
  if (response.stop_reason === 'max_tokens') throw new ProviderError('Die Antwort wurde abgeschnitten (max_tokens erreicht).', { retryable: true });
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// --- OpenAI und kompatible -----------------------------------------------------

/** Qwen3 & Co. liefern vor der Antwort einen <think>-Block; er gehoert nicht zum Text. */
function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

async function callOpenAi({ provider, apiKey, model, system, user, baseUrl, timeoutMs, fetchImpl }) {
  const base = (baseUrl || BASE_URLS[provider] || BASE_URLS.openai).replace(/\/+$/, '');
  const strict = provider === 'openai';
  const selfHosted = provider !== 'openai'; // Noah AI und "kompatibel"
  const body = {
    model,
    // Qwen3: "/no_think" schaltet das laute Nachdenken aus (andere Modelle behandeln es als normalen Text)
    messages: [{ role: 'system', content: system }, { role: 'user', content: provider === 'noah' ? `${user}\n\n/no_think` : user }],
    response_format: strict
      ? { type: 'json_schema', json_schema: { name: 'berichtsheft', strict: true, schema: SCHEMA } }
      : { type: 'json_object' },
  };
  if (selfHosted) {
    body.max_tokens = LOCAL_MODEL_MAX_TOKENS;
    body.temperature = 0.3;
    body.stream = false;
  } else {
    body.max_completion_tokens = MAX_OUTPUT_TOKENS;
  }
  const data = await httpJson(provider, `${base}/chat/completions`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    timeoutMs: timeoutMs || (selfHosted ? LOCAL_MODEL_TIMEOUT_MS : undefined),
    model,
    fetchImpl,
    body,
  });
  const message = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!message) throw new ProviderError('Die Antwort enthielt keinen Text.');
  if (message.refusal) throw new ProviderError(`Die Anfrage wurde abgelehnt: ${message.refusal}`);
  if (data.choices[0].finish_reason === 'length') throw new ProviderError('Die Antwort wurde abgeschnitten (Längenlimit).', { retryable: true });
  const content = stripThinking(message.content);
  if (!content) throw new ProviderError(`${NAMES[provider] || 'Der Anbieter'} lieferte eine leere Antwort.`, { retryable: true });
  return content;
}

// --- Gemini ----------------------------------------------------------------------

async function callGemini({ apiKey, model, system, user, baseUrl, timeoutMs, fetchImpl }) {
  const base = (baseUrl || BASE_URLS.gemini).replace(/\/+$/, '');
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
  switch (opts.provider) {
    case 'anthropic': return callAnthropic(opts);
    case 'openai':
    case 'noah':
    case 'kompatibel': return callOpenAi(opts);
    case 'gemini': return callGemini(opts);
    default: throw new ProviderError(`Unbekannter Anbieter "${opts.provider}".`);
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
