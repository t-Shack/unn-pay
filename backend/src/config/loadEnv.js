'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal .env loader. Avoids a dependency for something this small and keeps
 * the precedence rule explicit: a real environment variable always wins over a
 * file, so a deployed process can never be overridden by a stray checked in file.
 */
function parse(contents) {
  const out = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1).replace(/\\n/g, '\n');
    }
    out[key] = value;
  }
  return out;
}

let loaded = false;

module.exports = function loadEnv(file) {
  if (loaded) return;
  loaded = true;
  const candidates = file
    ? [file]
    : [
        process.env.ENV_FILE,
        process.env.NODE_ENV === 'test'
          ? path.resolve(process.cwd(), '.env.test')
          : null,
        path.resolve(process.cwd(), '.env'),
      ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const values = parse(fs.readFileSync(candidate, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
};

module.exports.parse = parse;
