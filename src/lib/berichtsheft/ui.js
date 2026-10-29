'use strict';

// Zeilenweise Ein-/Ausgabe fuer den Befehl: funktioniert im Terminal und mit umgeleiteter Eingabe
// (Tests, Skripte). Ein Tippen von Strg+D / Ende der Eingabe bricht die Rueckfrage ab.

const readline = require('readline');

class EndOfInput extends Error {
  constructor() {
    super('Eingabe beendet.');
    this.name = 'EndOfInput';
  }
}

function createUi({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, terminal: false });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => (waiters.length ? waiters.shift()(line) : queue.push(line)));
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  const next = () => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => waiters.push(resolve));
  };

  const ui = {
    interactive: !!input.isTTY,
    print(text = '') {
      output.write(`${text}\n`);
    },
    async ask(question, fallback = '') {
      output.write(question);
      const answer = await next();
      if (answer === null) {
        output.write('\n');
        throw new EndOfInput();
      }
      return answer.trim() || fallback;
    },
    /** Eingabe ohne Anzeige (API-Schluessel). */
    async askSecret(question) {
      output.write(question);
      const raw = input.isTTY && typeof input.setRawMode === 'function';
      if (raw) input.setRawMode(true);
      let answer;
      try {
        answer = await next();
      } finally {
        if (raw) input.setRawMode(false);
        output.write('\n');
      }
      if (answer === null) throw new EndOfInput();
      if (answer.includes('\u0003')) throw new EndOfInput();
      let out = '';
      for (const ch of answer) out = ch === '\u007f' || ch === '\b' ? out.slice(0, -1) : out + ch;
      return out.trim();
    },
    /** Fragt, bis eine der erlaubten Eingaben (Kleinbuchstabe) kommt; Enter = Standard. */
    async choose(question, keys, fallback) {
      for (;;) {
        const answer = (await ui.ask(question, fallback)).toLowerCase();
        const hit = keys.find((k) => answer === k || (answer && k.startsWith(answer) && answer.length >= 1 && keys.filter((x) => x.startsWith(answer)).length === 1));
        if (hit) return hit;
        ui.print(`Bitte eines von: ${keys.join(', ')}`);
      }
    },
    close() {
      rl.close();
    },
  };
  return ui;
}

module.exports = { createUi, EndOfInput };
