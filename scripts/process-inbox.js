'use strict';
// inbox/<PAIR>/{weekly,quarterly,phase}.txt を走査し、記入済みのものだけを処理して
// data/<PAIR>/*.json へ反映し、inboxをテンプレートへ戻す。
// 週間確認の 最大日足pips / 100pips超回数 は市場データから自動計算(手入力不要)。

const fs = require('fs');
const path = require('path');
const { fetchJson, lastCompletedWeekMonday, isMonday, weekStats } = require('./lib/market');
const { parseEntry, isFilled, asNumber } = require('./lib/inbox');

const ROOT = path.join(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'pairs.json'), 'utf8'));
const TPL_DIR = path.join(ROOT, 'inbox', '_templates');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }
function nowIso() { return new Date().toISOString(); }

function resetInbox(pairKey, kind) {
  const tpl = fs.readFileSync(path.join(TPL_DIR, `${kind}.txt`), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'inbox', pairKey, `${kind}.txt`), tpl);
}

async function processWeekly(pairKey, cfg, fields) {
  const dd = asNumber(fields['DD率'], 'DD率');
  if (dd < 0 || dd > 100) throw new Error(`DD率が範囲外です: ${dd}`);
  const by = fields['記録者'].trim();
  let week = (fields['対象週'] || 'auto').trim();
  if (week === '' || week === 'auto' || week === '自動') week = lastCompletedWeekMonday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !isMonday(week)) {
    throw new Error(`対象週は月曜日の日付(YYYY-MM-DD)で指定してください: "${week}"`);
  }
  const hist = await fetchJson(cfg.history_source.url);
  const stats = weekStats(hist.bars, week, cfg.pip, cfg.over_threshold_pips);
  if (!stats) throw new Error(`対象週 ${week} の日足データが見つかりません(データ源の更新をご確認ください)`);

  const file = path.join(ROOT, 'data', pairKey, 'weekly.json');
  const data = readJson(file);
  const row = {
    recorded_at: nowIso(),
    recorded_by: by,
    week,
    max_daily_pips: stats.max_daily_pips,
    over100_count: stats.over_count,
    dd_rate: dd,
    memo: fields['メモ'] || '',
    daily_ranges: stats.days,
    source: 'auto_market_calc',
  };
  const i = data.rows.findIndex((r) => r.week === week);
  if (i >= 0) data.rows[i] = row; else data.rows.push(row); // 同一週は上書き(冪等)
  data.rows.sort((a, b) => a.week.localeCompare(b.week));
  data.updated_at = nowIso();
  writeJson(file, data);
  return `週間確認を記録: ${pairKey} 週${week} 最大${stats.max_daily_pips}pips/${cfg.over_threshold_pips}pips超${stats.over_count}回(自動計算・${stats.bar_count}本)/DD率${dd}%/記録者${by}`;
}

async function processQuarterly(pairKey, cfg, fields) {
  const avg = asNumber(fields['3ヶ月平均ボラ'], '3ヶ月平均ボラ');
  const maxCandle = asNumber(fields['前月最大ローソク足'], '前月最大ローソク足');
  const by = fields['記録者'].trim();
  const quarter = fields['四半期'].trim();
  if (!/^\d{4}-Q[1-4]$/.test(quarter)) throw new Error(`四半期は「2026-Q3」の形式で指定してください: "${quarter}"`);
  const modeKey = avg >= cfg.mode_switch_vola_pips ? 'expanded' : 'normal';
  const mode = cfg.modes[modeKey];

  const file = path.join(ROOT, 'data', pairKey, 'quarterly.json');
  const data = readJson(file);
  const row = {
    recorded_at: nowIso(), recorded_by: by, quarter,
    avg_vola_3m: avg, max_candle_pips: maxCandle, mode: modeKey,
    nampin_interval: mode.nampin_interval, max_positions: mode.max_positions,
    last_position_gap: mode.last_position_gap, total_pips: mode.total_pips,
    memo: fields['メモ'] || '', source: 'manual',
  };
  const i = data.rows.findIndex((r) => r.quarter === quarter);
  if (i >= 0) data.rows[i] = row; else data.rows.push(row);
  data.rows.sort((a, b) => a.quarter.localeCompare(b.quarter));
  data.updated_at = nowIso();
  writeJson(file, data);
  return `四半期確認を記録: ${pairKey} ${quarter} 平均ボラ${avg}pips → ${mode.label}(間隔${mode.nampin_interval}pips)/記録者${by}`;
}

async function processPhase(pairKey, cfg, fields) {
  const to = String(fields['変更先フェーズ']).replace(/[%％]/g, '').trim();
  if (!cfg.phases[to]) throw new Error(`変更先フェーズは ${Object.keys(cfg.phases).join('/')} のいずれかで指定してください: "${to}"`);
  const reason = (fields['理由'] || fields['メモ'] || '').trim();
  const by = fields['変更者'].trim();
  if (!isFilled(reason)) throw new Error('理由は必須です(顧客向け説明責任の記録のため)');

  const file = path.join(ROOT, 'data', pairKey, 'phase.json');
  const data = readJson(file);
  const from = data.current.phase;
  if (from === to) throw new Error(`現在すでに ${cfg.phases[to].label} です`);
  const today = new Date().toISOString().slice(0, 10);
  data.history.push({ changed_at: today, from_phase: from, to_phase: to, reason, changed_by: by });
  data.current.phase = to;
  data.current.changed_at = today;
  data.current.updated_at = nowIso();
  data.updated_at = nowIso();
  writeJson(file, data);
  return `フェーズ変更を記録: ${pairKey} ${cfg.phases[from].label} → ${cfg.phases[to].label}(${by})`;
}

const REQUIRED = {
  weekly: ['DD率', '記録者'],
  quarterly: ['四半期', '3ヶ月平均ボラ', '前月最大ローソク足', '記録者'],
  phase: ['変更先フェーズ', '変更者'],
};
const HANDLERS = { weekly: processWeekly, quarterly: processQuarterly, phase: processPhase };

async function main() {
  const messages = [];
  const errors = [];
  for (const pairKey of Object.keys(CONFIG).filter((k) => !k.startsWith('_'))) {
    for (const kind of ['weekly', 'quarterly', 'phase']) {
      const p = path.join(ROOT, 'inbox', pairKey, `${kind}.txt`);
      if (!fs.existsSync(p)) continue;
      const fields = parseEntry(fs.readFileSync(p, 'utf8'));
      const filled = REQUIRED[kind].filter((k) => isFilled(fields[k]));
      if (filled.length === 0) continue; // 未記入=テンプレートのまま → スキップ
      if (filled.length < REQUIRED[kind].length) {
        errors.push(`${pairKey}/${kind}: 必須項目が不足しています(必須: ${REQUIRED[kind].join('・')})。inboxは保持したままにします`);
        continue;
      }
      try {
        messages.push(await HANDLERS[kind](pairKey, CONFIG[pairKey], fields));
        resetInbox(pairKey, kind);
      } catch (e) {
        errors.push(`${pairKey}/${kind}: ${e.message}(inboxは保持したままにします)`);
      }
    }
  }
  for (const m of messages) console.log('OK  ' + m);
  for (const e of errors) console.error('ERR ' + e);
  if (messages.length > 0) {
    fs.writeFileSync(path.join(ROOT, '.commit-message'), '記録更新: ' + messages.map((m) => m.split(':')[0]).join(' / '));
  }
  if (errors.length > 0) process.exit(1);
  if (messages.length === 0) console.log('記入済みのinboxはありません(処理対象なし)');
}

main().catch((e) => { console.error('FATAL ' + e.stack); process.exit(1); });
