'use strict';

// Einstellungen und Eintragsabfrage fuer "berichtsheft". Pro Person ein verschluesselter JSON-Block
// (Tabelle berichtsheft_settings) mit Anbieter, API-Schluesseln, Namensliste und Stichwoertern.
// db und Verschluesselung werden uebergeben, damit die Funktionen ohne Server testbar sind.

const PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', defaultModel: 'claude-haiku-5-5', env: ['ANTHROPIC_API_KEY'] },
  openai: { label: 'ChatGPT (OpenAI)', defaultModel: 'gpt-6.1-terra', env: ['OPENAI_API_KEY'] },
  gemini: { label: 'Gemini (Google)', defaultModel: 'gemini-3.8-flash', env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  // Fester Anbieter mit eigenen Qwen3-Modellen (OpenAI-kompatibel, https://ai.noahkoning.de/v1)
  noah: {
    label: 'Noah AI (Qwen3)',
    defaultModel: 'Qwen3-30B-A3B-Q4_K_M',
    models: ['Qwen3-30B-A3B-Q4_K_M', 'Qwen3-4B-Q4_K_M'],
    env: ['AI_API_KEY'],
    baseUrl: 'https://ai.noahkoning.de/v1',
  },
  kompatibel: { label: 'OpenAI-kompatibel (z. B. lokales Modell)', defaultModel: '', env: ['BERICHTSHEFT_API_KEY'] },
};

function defaultConfig() {
  return {
    provider: 'anthropic',
    models: {},
    keys: {},
    baseUrls: {},
    keywords: ['Berufsschule', 'Schule', 'Unterricht'],
    names: [],
    allow: ['Lini'],
    reviewed: [],
    lineWidth: 95,
  };
}

function makeStore(db, { encryptField, decryptField }) {
  const getStmt = db.prepare('SELECT config_enc FROM berichtsheft_settings WHERE user_id = ?');
  const putStmt = db.prepare(
    `INSERT INTO berichtsheft_settings (user_id, config_enc, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET config_enc = excluded.config_enc, updated_at = excluded.updated_at`
  );
  const rangeStmt = db.prepare(
    `SELECT * FROM entries
     WHERE user_id = ? AND work_date BETWEEN ? AND ? AND deleted_at IS NULL
     ORDER BY work_date ASC, start_time ASC, id ASC`
  );
  const hasSchoolColumn = db.prepare('PRAGMA table_info(entries)').all().some((c) => c.name === 'school_day');

  function loadConfig(userId) {
    const row = getStmt.get(userId);
    const base = defaultConfig();
    if (!row) return base;
    try {
      const saved = JSON.parse(decryptField(row.config_enc));
      return { ...base, ...saved, models: { ...saved.models }, keys: { ...saved.keys }, baseUrls: { ...saved.baseUrls } };
    } catch {
      return base;
    }
  }

  function saveConfig(userId, config) {
    putStmt.run(userId, encryptField(JSON.stringify(config)));
  }

  function loadEntries(userId, from, to) {
    return rangeStmt.all(userId, from, to).map((row) => ({
      id: row.id,
      date: row.work_date,
      description: decryptField(row.description_enc) || '',
      jiraKey: row.jira_key || '',
      minutes: row.duration_minutes,
      school: hasSchoolColumn ? !!row.school_day : false,
    }));
  }

  return { loadConfig, saveConfig, loadEntries };
}

/** Schluessel eines Anbieters: erst Einstellung, dann Umgebungsvariable. */
function resolveKey(config, provider, env = process.env) {
  if (config.keys && config.keys[provider]) return config.keys[provider];
  for (const name of PROVIDERS[provider].env) if (env[name]) return env[name];
  return '';
}

function resolveModel(config, provider, override) {
  return override || (config.models && config.models[provider]) || PROVIDERS[provider].defaultModel;
}

module.exports = { PROVIDERS, defaultConfig, makeStore, resolveKey, resolveModel };
