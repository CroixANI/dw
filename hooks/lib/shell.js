'use strict';
// Tiny shell-ish tokenizer good enough for classifying Bash / PowerShell commands.
// Splits on ; && || | & and newlines outside quotes, then tokenizes each segment.

function splitSegments(cmd) {
  const segs = [];
  let cur = '';
  let q = null; // current quote char
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      cur += ch;
      if (ch === q && cmd[i - 1] !== '\\') q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      // keep 2>&1 / >&2 redirections intact
      if (ch === '&' && (cmd[i - 1] === '>' || cmd[i + 1] === '>')) {
        cur += ch;
        continue;
      }
      if (cur.trim()) segs.push(cur.trim());
      cur = '';
      if ((ch === '|' || ch === '&') && cmd[i + 1] === ch) i++;
      continue;
    }
    // $( ... ) and backticks: treat contents as their own segment too
    if (ch === '(' || ch === ')' || ch === '`' || ch === '{' || ch === '}') {
      if (cur.trim()) segs.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) segs.push(cur.trim());
  return segs;
}

function tokenize(seg) {
  const toks = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) toks.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return toks;
}

const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'nohup', 'time', 'nice', 'stdbuf', 'exec', 'env', '&', '.']);

// Strip env assignments, wrappers, path prefixes and .exe so tokens[0] is the program name.
function normalizeTokens(toks) {
  let t = toks.slice();
  for (;;) {
    if (!t.length) break;
    const h = t[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(h) || /^\$env:[A-Za-z_]+=?/i.test(h)) {
      t.shift();
      continue;
    }
    if (h === 'timeout') {
      t.shift();
      while (t.length && /^-|^\d/.test(t[0])) t.shift();
      continue;
    }
    if (WRAPPERS.has(h.toLowerCase())) {
      t.shift();
      continue;
    }
    break;
  }
  if (t.length) {
    let prog = t[0].replace(/\\/g, '/').split('/').pop();
    prog = prog.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    t[0] = prog;
  }
  return t;
}

// Return the first non-option words after the program (skipping options and their values).
// valueOpts: options that take a separate value (e.g. git -C <dir>, -c <k=v>).
function subcommands(t, valueOpts, count) {
  const out = [];
  for (let i = 1; i < t.length && out.length < count; i++) {
    const w = t[i];
    if (w.startsWith('-')) {
      if (valueOpts.has(w)) i++;
      continue;
    }
    out.push(w.toLowerCase());
  }
  return out;
}

function hasFlag(t, names) {
  return t.some((w) => names.some((n) => w === n || w.startsWith(n + '=')));
}

function flagValue(t, names) {
  for (let i = 0; i < t.length; i++) {
    for (const n of names) {
      if (t[i] === n && i + 1 < t.length) return t[i + 1];
      if (t[i].startsWith(n + '=')) return t[i].slice(n.length + 1);
      // curl -XPOST style
      if (n.length === 2 && t[i].startsWith(n) && t[i].length > 2 && !t[i].startsWith('--')) return t[i].slice(2);
    }
  }
  return null;
}

module.exports = { splitSegments, tokenize, normalizeTokens, subcommands, hasFlag, flagValue };
