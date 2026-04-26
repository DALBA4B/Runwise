// Pure helpers for Riegel race-time prediction.
// Extracted from predictions.js so that diagnostics can show step-by-step calc
// without duplicating the math. NO DB ACCESS HERE.

const PB_DIST_KM = { pb_5k: 5, pb_10k: 10, pb_21k: 21.1, pb_42k: 42.2 };
const PB_BE_NAME = { pb_5k: '5K', pb_10k: '10K', pb_21k: 'Half-Marathon', pb_42k: 'Marathon' };
const BE_DISTANCES_M = {
  '1K': 1000, '1 Mile': 1609, '2 Mile': 3219, '5K': 5000,
  '10K': 10000, 'Half-Marathon': 21097, 'Marathon': 42195
};

function hrCorrectionFactor(avgHR, maxHR) {
  if (!avgHR || !maxHR || maxHR <= 0) return 1.0;
  const pct = avgHR / maxHR;
  if (pct >= 0.95) return 1.0;
  if (pct >= 0.90) return 0.99;
  if (pct >= 0.85) return 0.98;
  if (pct >= 0.80) return 0.97;
  return 0.96;
}

function fmtTime(s) {
  const sec = Math.max(0, Math.round(s));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function fmtPace(secPerKm) {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/км`;
}

/**
 * Compute Riegel prediction for a PB goal.
 *
 * @param {Object} opts
 * @param {Array}  opts.workouts          — workouts array (any timeframe; helper filters to last 4 weeks)
 * @param {string} opts.goalType          — 'pb_5k' | 'pb_10k' | 'pb_21k' | 'pb_42k'
 * @param {number} [opts.targetTimeSec]   — goal target time in seconds (optional, used only for gap)
 * @param {number} [opts.userMaxHR]       — user's max HR (for HR correction)
 * @param {Date}   [opts.now=new Date()]
 * @param {boolean}[opts.hasAnomalyColumns=true]
 *
 * @returns {Object} {
 *   ok, reason,
 *   targetDistKm, targetDistM,
 *   riegelExp, avgPaceSec, paceSamples,
 *   candidates,           // array of all Riegel candidates (sorted)
 *   top3,                 // top-3 used for weighted median
 *   riegelEstimate,       // weighted-median time in seconds
 *   riegelBasis,          // best candidate (most informative)
 *   bestEffort,           // {time, date} from Strava best_efforts (target distance)
 *   discardedBE,          // {time, date, reason} if sanity-rejected
 *   finalTime,            // chosen final prediction in seconds
 *   source,               // 'best_effort' | 'riegel' | null
 *   chosenReason,
 *   gap                   // finalTime - targetTimeSec (if target given)
 * }
 */
function computeRiegelPrediction({
  workouts,
  goalType,
  targetTimeSec = null,
  userMaxHR = null,
  now = new Date(),
  hasAnomalyColumns = true,
} = {}) {
  const out = {
    ok: false, reason: null,
    targetDistKm: PB_DIST_KM[goalType] || null,
    targetDistM: PB_DIST_KM[goalType] ? PB_DIST_KM[goalType] * 1000 : null,
    riegelExp: null, avgPaceSec: null, paceSamples: 0,
    candidates: [], top3: [],
    riegelEstimate: null, riegelBasis: null,
    bestEffort: null, discardedBE: null,
    finalTime: null, source: null, chosenReason: null,
    gap: null,
  };

  if (!PB_DIST_KM[goalType]) {
    out.reason = 'unsupported_goal_type';
    return out;
  }

  const fourWeeksAgo = new Date(now);
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

  const getEffDist = (w) => (hasAnomalyColumns && w.manual_distance) ? w.manual_distance : (w.distance || 0);
  const getEffTime = (w) => (hasAnomalyColumns && w.manual_moving_time) ? w.manual_moving_time : (w.moving_time || 0);
  const isSuspiciousUnverified = (w) => hasAnomalyColumns && w.is_suspicious && !w.user_verified;

  const recent = (workouts || []).filter(w => w.date && new Date(w.date) >= fourWeeksAgo);

  // --- Adaptive Riegel exponent based on average pace ---
  const paceSamples = recent.filter(w => getEffDist(w) > 0 && getEffTime(w) > 0 && !isSuspiciousUnverified(w));
  const avgPaceMin = paceSamples.length > 0
    ? paceSamples.reduce((s, w) => s + getEffTime(w) / (getEffDist(w) / 1000), 0) / paceSamples.length / 60
    : 6;
  const riegelExp = avgPaceMin < 4.5 ? 1.06 : avgPaceMin < 5.5 ? 1.08 : avgPaceMin < 6.5 ? 1.10 : 1.12;
  out.avgPaceSec = Math.round(avgPaceMin * 60);
  out.riegelExp = riegelExp;
  out.paceSamples = paceSamples.length;

  // Freshness weight: 1.0 today, 0.7 at 28 days, floored at 0.5
  const freshness = (dateStr) => {
    const days = (now - new Date(dateStr)) / (1000 * 60 * 60 * 24);
    return Math.max(0.5, 1 - days / 28 * 0.3);
  };

  const targetBEName = PB_BE_NAME[goalType];
  const targetDistM = out.targetDistM;

  // --- Step 1: Riegel candidates from best_efforts splits ---
  const candidates = [];
  for (const w of recent) {
    if (!w.best_efforts) continue;
    if (hasAnomalyColumns && w.is_suspicious) continue;
    let efforts;
    try {
      efforts = typeof w.best_efforts === 'string' ? JSON.parse(w.best_efforts) : w.best_efforts;
    } catch { continue; }
    if (!Array.isArray(efforts)) continue;

    for (const e of efforts) {
      const eDist = BE_DISTANCES_M[e.name];
      if (!eDist || eDist < 1000 || eDist >= targetDistM * 0.95 || !(e.moving_time > 0)) continue;

      const baseTime = e.moving_time * Math.pow(targetDistM / eDist, riegelExp);
      const hrCorr = (userMaxHR && w.average_heartrate) ? hrCorrectionFactor(w.average_heartrate, userMaxHR) : 1.0;
      const rTime = baseTime * hrCorr;
      const pctHRmax = (userMaxHR && w.average_heartrate) ? Math.round(w.average_heartrate / userMaxHR * 100) : null;

      candidates.push({
        time: rTime,
        timeFormatted: fmtTime(rTime),
        effortName: e.name,
        effortDistM: eDist,
        effortDistKm: Math.round(eDist / 100) / 10,
        date: w.date,
        dateFormatted: fmtDate(w.date),
        movingTime: e.moving_time,
        movingTimeFormatted: fmtTime(e.moving_time),
        freshness: freshness(w.date),
        hrCorr,
        hrAdjusted: hrCorr < 1.0,
        avgHR: w.average_heartrate || null,
        pctHRmax,
      });
    }
  }

  candidates.sort((a, b) => (a.time * (2 - a.freshness)) - (b.time * (2 - b.freshness)));
  out.candidates = candidates;

  // --- Step 2: Weighted median of top-3 ---
  if (candidates.length > 0) {
    const top3 = candidates.slice(0, Math.min(3, candidates.length));
    const totalWeight = top3.reduce((s, r) => s + r.freshness, 0);
    out.riegelEstimate = Math.round(top3.reduce((s, r) => s + r.time * r.freshness, 0) / totalWeight);
    out.riegelBasis = top3[0];
    out.top3 = top3;
  }

  // --- Step 3: Strava best_effort at target distance ---
  let bestEffort = null;
  for (const w of recent) {
    if (!w.best_efforts) continue;
    if (hasAnomalyColumns && w.is_suspicious) continue;
    let efforts;
    try {
      efforts = typeof w.best_efforts === 'string' ? JSON.parse(w.best_efforts) : w.best_efforts;
    } catch { continue; }
    if (!Array.isArray(efforts)) continue;
    for (const e of efforts) {
      if (e.name === targetBEName && e.moving_time > 0) {
        if (!bestEffort || e.moving_time < bestEffort.time) {
          bestEffort = { time: e.moving_time, date: w.date };
        }
      }
    }
  }
  if (bestEffort) {
    out.bestEffort = {
      time: bestEffort.time,
      timeFormatted: fmtTime(bestEffort.time),
      date: bestEffort.date,
      dateFormatted: fmtDate(bestEffort.date),
    };
  }

  // --- Sanity check: BE >15% faster than Riegel median → likely GPS glitch, drop it ---
  let bestEffortDiscarded = false;
  if (bestEffort && out.riegelEstimate && bestEffort.time < out.riegelEstimate * 0.85) {
    out.discardedBE = {
      time: bestEffort.time,
      timeFormatted: fmtTime(bestEffort.time),
      date: bestEffort.date,
      dateFormatted: fmtDate(bestEffort.date),
      fasterPct: Math.round((1 - bestEffort.time / out.riegelEstimate) * 100),
      reason: `На ${Math.round((1 - bestEffort.time / out.riegelEstimate) * 100)}% быстрее расчёта — вероятно GPS-глюк`,
    };
    bestEffort = null;
    bestEffortDiscarded = true;
    out.bestEffort = null;
  }

  // --- Step 4: Pick final source ---
  if (bestEffort && out.riegelEstimate) {
    if (bestEffort.time <= out.riegelEstimate) {
      out.finalTime = Math.round(bestEffort.time);
      out.source = 'best_effort';
      out.chosenReason = `${targetBEName}-сплит (${fmtTime(out.finalTime)}) быстрее расчёта Ригеля (${fmtTime(out.riegelEstimate)})`;
    } else {
      out.finalTime = out.riegelEstimate;
      out.source = 'riegel';
      out.chosenReason = `Расчёт по тренировке ${out.riegelBasis.effortDistKm} км от ${out.riegelBasis.dateFormatted} (${fmtTime(out.riegelEstimate)}) быстрее сплита (${fmtTime(bestEffort.time)})`;
    }
  } else if (bestEffort) {
    out.finalTime = Math.round(bestEffort.time);
    out.source = 'best_effort';
    out.chosenReason = `Нет подходящих тренировок для Ригеля, используется ${targetBEName}-сплит`;
  } else if (out.riegelEstimate) {
    out.finalTime = out.riegelEstimate;
    out.source = 'riegel';
    const beNote = bestEffortDiscarded ? ', Strava-сплит отсечён как GPS-глюк' : ', Strava-сплит не найден';
    out.chosenReason = `Медиана топ-3 по тренировке ${out.riegelBasis.effortDistKm} км от ${out.riegelBasis.dateFormatted}${beNote}`;
  } else {
    out.reason = candidates.length === 0 ? 'no_candidates' : 'no_estimate';
  }

  if (out.finalTime) {
    out.ok = true;
    if (targetTimeSec) out.gap = out.finalTime - targetTimeSec;
  }

  return out;
}

module.exports = {
  computeRiegelPrediction,
  hrCorrectionFactor,
  fmtTime,
  fmtDate,
  fmtPace,
  PB_DIST_KM,
  PB_BE_NAME,
  BE_DISTANCES_M,
};
