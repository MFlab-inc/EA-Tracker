'use strict';
const assert = require('assert');
const { lastCompletedWeekMonday, isMonday, weekStats } = require('../scripts/lib/market');
const { parseEntry, asNumber } = require('../scripts/lib/inbox');

let n = 0;
function t(name, fn) { fn(); n++; console.log(`ok ${n} - ${name}`); }

// --- 週の自動判定 ---
t('土曜は同週の月曜を返す(金曜が過去)', () => {
  assert.equal(lastCompletedWeekMonday(new Date('2026-07-25T10:00:00Z')), '2026-07-20');
});
t('日曜も同週の月曜を返す', () => {
  assert.equal(lastCompletedWeekMonday(new Date('2026-07-26T10:00:00Z')), '2026-07-20');
});
t('月曜は前週の月曜を返す', () => {
  assert.equal(lastCompletedWeekMonday(new Date('2026-07-27T01:00:00Z')), '2026-07-20');
});
t('金曜(週の途中)は前週の月曜を返す', () => {
  assert.equal(lastCompletedWeekMonday(new Date('2026-07-24T10:00:00Z')), '2026-07-13');
});
t('isMonday判定', () => {
  assert.equal(isMonday('2026-07-20'), true);
  assert.equal(isMonday('2026-07-21'), false);
});

// --- 週間統計 ---
const bars = [
  { date: '2026-07-18', open: 1, high: 1, low: 1, close: 1 },          // 土曜アーティファクト(対象外)
  { date: '2026-07-20', open: 0.98, high: 0.9880, low: 0.9800, close: 0.985 }, // 80.0pips
  { date: '2026-07-21', open: 0.98, high: 0.9905, low: 0.9800, close: 0.985 }, // 105.0pips
  { date: '2026-07-22', open: 0.98, high: 0.9900, low: 0.9800, close: 0.985 }, // 100.0pips(境界: 超に含めない)
  { date: '2026-07-24', open: 0.98, high: 0.9830, low: 0.9800, close: 0.981 }, // 30.0pips(木曜欠損の週)
];
t('週間統計: 最大値・100pips超回数(>100の厳密判定)・土曜除外・欠損日耐性', () => {
  const s = weekStats(bars, '2026-07-20', 0.0001, 100);
  assert.equal(s.max_daily_pips, 105);
  assert.equal(s.over_count, 1); // 100.0ちょうどは含めない
  assert.equal(s.bar_count, 4);  // 土曜バーは含まれない・木曜欠損
});
t('週間統計: データなし週はnull', () => {
  assert.equal(weekStats(bars, '2026-06-01', 0.0001, 100), null);
});

// --- inboxパーサ ---
t('パーサ: 基本+複数行メモ+コメント無視+全角コロン', () => {
  const f = parseEntry('# コメント\n対象週: 2026-07-20\nDD率：0.29\n記録者: 錦野\nメモ: \n一行目\n\n二行目\n');
  assert.equal(f['対象週'], '2026-07-20');
  assert.equal(f['DD率'], '0.29');
  assert.equal(f['記録者'], '錦野');
  assert.equal(f['メモ'], '一行目\n\n二行目');
});
t('パーサ: 未記入テンプレートは空値', () => {
  const f = parseEntry('# コメント\n対象週: \nDD率: \n記録者: \nメモ: \n');
  assert.equal(f['対象週'], '');
  assert.equal(f['メモ'], '');
});
t('パーサ: メモ内のコロン行はキー扱いしない', () => {
  const f = parseEntry('DD率: 0.1\n記録者: 田中\nメモ: \nBoC: 2.25%据え置き\n次回: 9/3');
  assert.equal(f['メモ'], 'BoC: 2.25%据え置き\n次回: 9/3');
  assert.equal(f['DD率'], '0.1');
});
t('asNumber: %記号や全角を除去して数値化・非数値は例外', () => {
  assert.equal(asNumber('0.29%', 'x'), 0.29);
  assert.equal(asNumber('85.94', 'x'), 85.94);
  assert.throws(() => asNumber('abc', 'x'));
});

// --- 設定・データ整合 ---
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/pairs.json'), 'utf8'));
t('設定: AUDCADのモード判定境界とフェーズ定義', () => {
  assert.equal(cfg.AUDCAD.mode_switch_vola_pips, 80);
  assert.deepEqual(cfg.AUDCAD.phase_order, ['25', '50', '100']);
  assert.equal(cfg.AUDCAD.phases['25'].pass_max, 6.3);
  assert.equal(cfg.AUDCAD.phases['100'].caution_max, 33);
});
t('移行データ: 週間確認10件・週順・数値型', () => {
  const w = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/AUDCAD/weekly.json'), 'utf8'));
  assert.equal(w.rows.length, 10);
  assert.equal(w.rows[0].week, '2026-05-18');
  assert.equal(w.rows[9].week, '2026-07-20');
  assert.strictEqual(w.rows[0].max_daily_pips, 112);
  assert.strictEqual(w.rows[9].dd_rate, 0.29);
  assert.ok(w.rows[5].memo.includes('SKハイニックス'));
});
t('移行データ: フェーズ現況(25%検証・2026-06-29変更・ローリング4週)', () => {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/AUDCAD/phase.json'), 'utf8'));
  assert.equal(p.current.phase, '25');
  assert.equal(p.current.changed_at, '2026-06-29');
  assert.equal(p.current.rolling_weeks, 4);
  assert.equal(p.history[0].from_phase, '50');
});

// --- 昇格判定ロジック(index.htmlと同一規則をここで検証) ---
function promotionCheck(weeklyRows, phase, cfg) {
  const N = phase.current.rolling_weeks;
  const win = [...weeklyRows].sort((a, b) => b.week.localeCompare(a.week)).slice(0, N);
  const rollingDD = win.length ? Math.max(...win.map((r) => r.dd_rate)) : null;
  const events = win.filter((r) => r.max_daily_pips >= cfg.high_vola_pips).length;
  const next = new Date(new Date(phase.current.changed_at + 'T00:00:00Z').getTime() + N * 7 * 86400000);
  return { rollingDD, events, nextJudgeDate: next.toISOString().slice(0, 10), dataWeeks: win.length };
}
t('昇格判定: 実データ再現(直近4週DD最大0.36%・80pips超1回・次回判定7/27)', () => {
  const w = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/AUDCAD/weekly.json'), 'utf8'));
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/AUDCAD/phase.json'), 'utf8'));
  const r = promotionCheck(w.rows, p, cfg.AUDCAD);
  assert.equal(r.rollingDD, 0.36);     // 直近4週: 0.36/0.25/0.10/0.29 → 最大0.36
  assert.equal(r.events, 1);           // 90pips ≥ 80 の週が1つ
  assert.equal(r.nextJudgeDate, '2026-07-27');
  assert.equal(r.dataWeeks, 4);
});

console.log(`\n${n}件すべて合格`);
