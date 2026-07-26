'use strict';
// inbox/<PAIR>/*.txt の簡易記入形式パーサ。
// 形式: 「キー: 値」の行 + 「メモ:」以降は末尾まで全てメモ本文(複数行可)。
// 「#」で始まる行はコメントとして無視する(メモ本文内は除く)。

function parseEntry(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const fields = {};
  let memoLines = null;
  for (const line of lines) {
    if (memoLines !== null) { memoLines.push(line); continue; }
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const m = t.match(/^([^:：]+)[:：](.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key === 'メモ') { memoLines = val === '' || val === '|' ? [] : [val]; continue; }
    fields[key] = val;
  }
  if (memoLines !== null) {
    // 先頭・末尾の空行を除去(インデントは保持)
    while (memoLines.length && memoLines[0].trim() === '') memoLines.shift();
    while (memoLines.length && memoLines[memoLines.length - 1].trim() === '') memoLines.pop();
    fields['メモ'] = memoLines.join('\n');
  }
  return fields;
}

function isFilled(v) { return v !== undefined && String(v).trim() !== ''; }

function asNumber(v, label) {
  const n = Number(String(v).replace(/[%％,、]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`${label} が数値として読み取れません: "${v}"`);
  return n;
}

module.exports = { parseEntry, isFilled, asNumber };
