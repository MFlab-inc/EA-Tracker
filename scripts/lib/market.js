'use strict';
// EA-Risk-Monitorが公開するD1履歴(Twelve Data・NYクローズ基準)から週間統計を計算する。
// 本リポジトリ自体はAPIキーを一切持たない(Twelve Data直接呼び出しなし)。

const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Nampin-Tracker' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// 直近の「完了した週」(金曜が過去日)の月曜を YYYY-MM-DD で返す
function lastCompletedWeekMonday(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = 0; i < 14; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (d.getUTCDay() === 1) { // 月曜
      // 金曜のNYクローズ(夏21:00/冬22:00 UTC)後に完了とみなす → 土曜0:00 UTC以降で判定
      const saturday = d.getTime() + 5 * 86400000;
      if (now.getTime() >= saturday) return d.toISOString().slice(0, 10);
    }
  }
  throw new Error('week resolution failed');
}

function isMonday(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay() === 1;
}

// 対象週(月曜〜金曜)の 最大日足レンジpips / 閾値超回数 を計算
function weekStats(bars, mondayStr, pip, overThresholdPips) {
  const mon = new Date(mondayStr + 'T00:00:00Z');
  const days = [...Array(5)].map((_, i) => new Date(mon.getTime() + i * 86400000).toISOString().slice(0, 10));
  const daily = bars
    .filter((b) => days.includes(b.date))
    .map((b) => ({ date: b.date, range_pips: Math.round(((b.high - b.low) / pip) * 10) / 10 }));
  if (daily.length === 0) return null;
  return {
    week: mondayStr,
    days: daily,
    max_daily_pips: Math.max(...daily.map((d) => d.range_pips)),
    over_count: daily.filter((d) => d.range_pips > overThresholdPips).length,
    bar_count: daily.length,
  };
}

module.exports = { fetchJson, lastCompletedWeekMonday, isMonday, weekStats };
