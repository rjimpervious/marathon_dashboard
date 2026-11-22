import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SITE_URL = 'https://run.rjlopez.me';
const DEV_VARS = fileURLToPath(new URL('../.dev.vars', import.meta.url));
const TOKEN_NAME = 'ACCESS_TOKEN';
const MIN_TOKEN_LENGTH = 16;

function readToken() {
  let text;
  try {
    text = readFileSync(DEV_VARS, 'utf8');
  } catch {
    return '';
  }
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0 && line.slice(0, index).trim() === TOKEN_NAME) return line.slice(index + 1).trim();
  }
  return '';
}

const token = readToken();
if (token.length < MIN_TOKEN_LENGTH) {
  console.error('No ' + TOKEN_NAME + ' of at least ' + MIN_TOKEN_LENGTH + ' characters in .dev.vars.');
  process.exitCode = 1;
} else {
  console.log(SITE_URL + '/?k=' + token);
}
