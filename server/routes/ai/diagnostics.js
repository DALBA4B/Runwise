const express = require('express');
const supabase = require('../../supabase');
const authMiddleware = require('../../middleware/authMiddleware');

const {
  formatPace,
  effectiveDistance,
  effectiveMovingTime,
  effectivePace,
  getMonthlySummaryContext,
  getUserGoals,
  getCurrentPlan,
  getUserRecords,
  getWeeklyVolumes,
  getRiegelPredictions,
  getActiveMacroPlan,
  computeMacroPlanWithActuals,
  analyzeTrainingStability,
  assessMarathonGoalRealism,
  analyzeRecentCompliance,
  getUserProfile,
  estimateMaxHR,
  calculateHRZones,
  detectAerobicThreshold,
  autoCalibrateHRZones,
  getHRTrendContext,
  getRecentDecouplingData,
  getWeeklyTRIMP
} = require('./context');

const {
  calculateVDOT,
  estimateVDOT,
  calculatePaceZones,
  getRunnerLevel,
  QUALITY_TYPES
} = require('./vdot');

const {
  getAiPrefs,
  buildChatPromptDebugSnapshot
} = require('./prompts');
const { getAiToolCatalog } = require('./tools');
const { computeRiegelPrediction, fmtTime, fmtPace, PB_BE_NAME } = require('../workouts/riegelHelper');
const workoutsState = require('../workouts/state');

const router = express.Router();

// GET /api/ai/diagnostics — full step-by-step diagnostics of all calculations
router.get('/diagnostics', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const sections = [];

    // ============================
    // SECTION 1: Max Heart Rate
    // ============================
    const profile = await getUserProfile(userId);
    const maxHRSteps = [];

    if (profile.max_heartrate_user) {
      maxHRSteps.push({
        title: 'Источник: ручной ввод',
        detail: `Пользователь указал макс. пульс: ${profile.max_heartrate_user} уд/мин`,
        status: 'ok'
      });
    } else if (profile.age) {
      maxHRSteps.push({
        title: 'Источник: формула Танака',
        detail: `Пользователь не указал макс. пульс — рассчитываем по возрасту`,
        status: 'warning'
      });
      maxHRSteps.push({
        title: 'Берём возраст пользователя',
        detail: `Возраст = ${profile.age} лет`,
        status: 'ok'
      });
      const estimated = estimateMaxHR(profile.age);
      maxHRSteps.push({
        title: 'Применяем формулу Танака (2001)',
        detail: `208 − 0.7 × ${profile.age} = ${208} − ${(0.7 * profile.age).toFixed(1)} = ${estimated} уд/мин`,
        formula: '208 − 0.7 × возраст',
        status: 'ok'
      });
      maxHRSteps.push({
        title: 'Почему Танака, а не 220 − возраст?',
        detail: 'Формула 220−возраст (Fox, 1971) устарела. Танака проверена на 18 712 людях и точнее: стандартное отклонение ±10 уд/мин вместо ±12.',
        status: 'info'
      });
    } else {
      maxHRSteps.push({
        title: 'Макс. пульс неизвестен',
        detail: 'Нет ни ручного ввода, ни возраста. Пульсовые зоны не могут быть рассчитаны.',
        status: 'error'
      });
    }

    const maxHR = profile.max_heartrate_user || estimateMaxHR(profile.age);

    sections.push({
      id: 'maxHR',
      title: 'Макс. пульс (HRmax)',
      result: maxHR ? `${maxHR} уд/мин` : 'Не определён',
      status: maxHR ? (profile.max_heartrate_user ? 'ok' : 'warning') : 'error',
      steps: maxHRSteps
    });

    // ============================
    // SECTION 2: Resting HR
    // ============================
    const restingHR = profile.resting_heartrate || null;
    const restingSteps = [];

    if (restingHR) {
      restingSteps.push({
        title: 'Источник: ручной ввод',
        detail: `Пульс покоя = ${restingHR} уд/мин`,
        status: 'ok'
      });
      if (maxHR) {
        const reserve = maxHR - restingHR;
        restingSteps.push({
          title: 'Резерв пульса (HRR)',
          detail: `HRmax − HRrest = ${maxHR} − ${restingHR} = ${reserve} уд/мин`,
          formula: 'HRR = HRmax − HRrest',
          status: 'ok'
        });
        restingSteps.push({
          title: 'Метод Карвонена активен',
          detail: `Есть оба значения → зоны рассчитываются через резерв пульса (более точно чем %HRmax)`,
          status: 'ok'
        });
      }
    } else {
      restingSteps.push({
        title: 'Пульс покоя не указан',
        detail: 'Зоны будут рассчитаны по %HRmax (менее точно). Укажите пульс покоя для метода Карвонена.',
        status: 'warning'
      });
    }

    sections.push({
      id: 'restingHR',
      title: 'Пульс покоя (HRrest)',
      result: restingHR ? `${restingHR} уд/мин` : 'Не указан',
      status: restingHR ? 'ok' : 'warning',
      steps: restingSteps
    });

    // ============================
    // SECTION 3: VDOT
    // ============================
    const vdotSteps = [];

    const twelveWeeksAgo = new Date();
    twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84);
    const { data: recentWorkouts } = await supabase
      .from('workouts')
      .select('id, name, distance, moving_time, average_pace, date, type, manual_distance, manual_moving_time, is_suspicious')
      .eq('user_id', userId)
      .gte('date', twelveWeeksAgo.toISOString())
      .order('date', { ascending: false });

    const { data: allWorkouts } = await supabase
      .from('workouts')
      .select('id, name, distance, moving_time, average_pace, date, type, manual_distance, manual_moving_time, is_suspicious')
      .eq('user_id', userId)
      .order('date', { ascending: false });

    const recentClean = (recentWorkouts || []).filter(w => !w.is_suspicious);
    const allClean = (allWorkouts || []).filter(w => !w.is_suspicious);

    vdotSteps.push({
      title: 'Загрузка тренировок',
      detail: `За 12 недель: ${(recentWorkouts || []).length} тренировок (${recentClean.length} без GPS-аномалий). Всего: ${(allWorkouts || []).length}.`,
      status: 'ok'
    });

    // Quality workouts
    const recentQuality = recentClean.filter(w => {
      const type = (w.type || '').toLowerCase();
      return QUALITY_TYPES.includes(type) && effectiveDistance(w) >= 2000;
    });

    vdotSteps.push({
      title: 'Поиск качественных тренировок (12 нед.)',
      detail: `Типы: ${QUALITY_TYPES.join(', ')}. Мин. дистанция: 2 км. Найдено: ${recentQuality.length}.`,
      status: recentQuality.length > 0 ? 'ok' : 'warning'
    });

    if (recentQuality.length > 0) {
      // Calculate VDOT for each
      const vdotCalcs = recentQuality.map(w => {
        const dist = effectiveDistance(w);
        const time = effectiveMovingTime(w);
        const vdot = calculateVDOT(time, dist);
        return { name: w.name, date: w.date?.split('T')[0], dist, time, vdot, type: w.type };
      }).filter(v => v.vdot);

      for (const v of vdotCalcs.slice(0, 5)) {
        const distKm = (v.dist / 1000).toFixed(2);
        const timeMin = (v.time / 60).toFixed(1);
        const velocity = (v.dist / (v.time / 60)).toFixed(1);
        vdotSteps.push({
          title: `${v.name} (${v.date})`,
          detail: `${distKm} км за ${formatPace(Math.round(v.time / (v.dist / 1000)))} /км → скорость ${velocity} м/мин → VDOT = ${v.vdot}`,
          status: 'ok'
        });
      }

      const bestVdot = vdotCalcs.sort((a, b) => b.vdot - a.vdot)[0];
      if (bestVdot) {
        vdotSteps.push({
          title: 'Выбираем лучший VDOT',
          detail: `Лучший: ${bestVdot.name} → VDOT ${bestVdot.vdot}`,
          status: 'ok'
        });
      }
    }

    const estimate = estimateVDOT(recentWorkouts, allWorkouts);

    if (estimate.source === 'decay' && estimate.sourceWorkout) {
      const sw = estimate.sourceWorkout;
      vdotSteps.push({
        title: 'Нет quality за 12 недель — применяем decay',
        detail: `Последняя quality: "${sw.name}" (${sw.ageDays} дней назад). Исходный VDOT ${sw.originalVdot}, decay rate 0.21%/день.`,
        status: 'warning'
      });
      vdotSteps.push({
        title: 'Расчёт decay',
        detail: `VDOT × (1 − 0.0021 × ${sw.ageDays}) = ${sw.originalVdot} × ${(1 - 0.0021 * sw.ageDays).toFixed(3)} = ${sw.decayedVdot}`,
        formula: 'VDOT × max(0.5, 1 − 0.0021 × дней)',
        status: 'warning'
      });
    }

    if (!estimate.vdot) {
      vdotSteps.push({
        title: 'VDOT не определён',
        detail: 'Недостаточно данных. Нужна хотя бы одна quality-тренировка (race/tempo/interval/fartlek/long) от 2 км.',
        status: 'error'
      });
    }

    sections.push({
      id: 'vdot',
      title: 'VDOT (VO₂max)',
      result: estimate.vdot ? `${estimate.vdot}` : 'Не определён',
      status: estimate.vdot ? (estimate.source === 'decay' ? 'warning' : 'ok') : 'error',
      steps: vdotSteps
    });

    // ============================
    // SECTION 4: Pace Zones
    // ============================
    const paceZonesSteps = [];
    let paceZones = null;

    if (estimate.vdot) {
      paceZones = calculatePaceZones(estimate.vdot);

      paceZonesSteps.push({
        title: 'Расчёт зон по Дэниелсу',
        detail: `VDOT = ${estimate.vdot}. Для каждой зоны: целевой VO₂ = VDOT × %VO₂max, из него → скорость → темп.`,
        status: 'ok'
      });

      const zoneDefs = [
        { name: 'Easy', pctMin: 0.59, pctMax: 0.74, key1: 'easyMin', key2: 'easyMax' },
        { name: 'Marathon', pct: 0.80, key: 'marathon' },
        { name: 'Threshold', pct: 0.86, key: 'threshold' },
        { name: 'Interval', pct: 0.98, key: 'interval' },
        { name: 'Repetition', pct: 1.05, key: 'repetition' }
      ];

      for (const z of zoneDefs) {
        if (z.pctMin) {
          const vo2Min = (estimate.vdot * z.pctMin).toFixed(1);
          const vo2Max = (estimate.vdot * z.pctMax).toFixed(1);
          paceZonesSteps.push({
            title: `${z.name}: ${formatPace(paceZones[z.key1])} – ${formatPace(paceZones[z.key2])}`,
            detail: `${(z.pctMin * 100).toFixed(0)}–${(z.pctMax * 100).toFixed(0)}% VO₂max = ${vo2Min}–${vo2Max} → темп ${formatPace(paceZones[z.key1])}–${formatPace(paceZones[z.key2])} /км`,
            status: 'ok'
          });
        } else {
          const vo2 = (estimate.vdot * z.pct).toFixed(1);
          paceZonesSteps.push({
            title: `${z.name}: ${formatPace(paceZones[z.key])}`,
            detail: `${(z.pct * 100).toFixed(0)}% VO₂max = ${vo2} → темп ${formatPace(paceZones[z.key])} /км`,
            status: 'ok'
          });
        }
      }

      // Runner level
      const activeWeeks = new Set();
      for (const w of (recentWorkouts || [])) {
        if (w.date) {
          const d = new Date(w.date);
          const jan1 = new Date(d.getFullYear(), 0, 1);
          const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
          activeWeeks.add(`${d.getFullYear()}-W${weekNum}`);
        }
      }
      const totalKm12w = (recentWorkouts || []).reduce((s, w) => s + effectiveDistance(w) / 1000, 0);
      const weeklyKm = activeWeeks.size > 0 ? Math.round(totalKm12w / activeWeeks.size * 10) / 10 : 0;
      const level = getRunnerLevel(weeklyKm);

      paceZonesSteps.push({
        title: 'Уровень бегуна',
        detail: `Средний объём: ${weeklyKm} км/нед (${activeWeeks.size} активных недель) → ${level} (<20 = beginner, 20-50 = intermediate, >50 = advanced)`,
        status: 'ok'
      });
    } else {
      paceZonesSteps.push({
        title: 'Темповые зоны не рассчитаны',
        detail: 'VDOT не определён — невозможно рассчитать зоны.',
        status: 'error'
      });
    }

    sections.push({
      id: 'paceZones',
      title: 'Темповые зоны',
      result: paceZones ? 'Рассчитаны' : 'Нет данных',
      status: paceZones ? 'ok' : 'error',
      steps: paceZonesSteps
    });

    // ============================
    // SECTION 5: HR Zones
    // ============================
    const hrZonesSteps = [];

    if (!maxHR) {
      hrZonesSteps.push({
        title: 'Макс. пульс неизвестен',
        detail: 'Невозможно рассчитать пульсовые зоны без HRmax.',
        status: 'error'
      });
    } else {
      // Step 1: Base zones (Karvonen or %HRmax)
      const useKarvonen = restingHR && restingHR > 0 && restingHR < maxHR;

      if (useKarvonen) {
        const reserve = maxHR - restingHR;
        hrZonesSteps.push({
          title: 'Метод: Карвонен (%HRR)',
          detail: `HRmax = ${maxHR}, HRrest = ${restingHR}, резерв = ${reserve} уд/мин. Зона = HRrest + %HRR × резерв.`,
          formula: 'HR = HRrest + %HRR × (HRmax − HRrest)',
          status: 'ok'
        });

        const hrZonePctHRR = {
          'Easy':       { from: 55, to: 70 },
          'Marathon':   { from: 70, to: 80 },
          'Threshold':  { from: 80, to: 88 },
          'Interval':   { from: 88, to: 95 },
          'Repetition': { from: 95, to: 100 }
        };

        for (const [name, pct] of Object.entries(hrZonePctHRR)) {
          const from = Math.round(restingHR + reserve * pct.from / 100);
          const to = Math.round(restingHR + reserve * pct.to / 100);
          hrZonesSteps.push({
            title: `${name}: ${from}–${to} уд/мин`,
            detail: `${restingHR} + ${pct.from}%×${reserve} = ${from} | ${restingHR} + ${pct.to}%×${reserve} = ${to}`,
            status: 'ok'
          });
        }
      } else {
        hrZonesSteps.push({
          title: 'Метод: %HRmax (упрощённый)',
          detail: `Нет пульса покоя → используем %HRmax с поправкой +5%. HRmax = ${maxHR}.`,
          status: 'warning'
        });

        const hrZonePct = {
          'Easy':       { from: 60, to: 75 },
          'Marathon':   { from: 75, to: 85 },
          'Threshold':  { from: 85, to: 93 },
          'Interval':   { from: 93, to: 100 },
          'Repetition': { from: 100, to: 105 }
        };

        for (const [name, pct] of Object.entries(hrZonePct)) {
          const from = Math.round(maxHR * pct.from / 100);
          const to = Math.round(maxHR * pct.to / 100);
          hrZonesSteps.push({
            title: `${name}: ${from}–${to} уд/мин`,
            detail: `${maxHR} × ${pct.from}% = ${from} | ${maxHR} × ${pct.to}% = ${to}`,
            status: 'ok'
          });
        }
      }

      // Step 2: Auto-calibration attempt
      if (paceZones) {
        hrZonesSteps.push({
          title: 'Попытка автокалибровки',
          detail: 'Ищем сплиты 1 км с пульсом за 6 недель, сопоставляем темп → пульс.',
          status: 'info'
        });

        const calibration = await autoCalibrateHRZones(userId, paceZones);
        if (calibration) {
          hrZonesSteps.push({
            title: 'Автокалибровка: данные найдены',
            detail: `${calibration.totalDataPoints} data points, ${calibration.calibratedZones} зон откалибровано (нужно ≥3).`,
            status: calibration.calibratedZones >= 3 ? 'ok' : 'warning'
          });

          if (calibration.calibratedZones >= 3) {
            for (const [zone, data] of Object.entries(calibration.zones)) {
              hrZonesSteps.push({
                title: `${zone}: ${data.from}–${data.to} уд/мин (из ${data.samples} сплитов)`,
                detail: `P10-P90 реального пульса в диапазоне темпа этой зоны. Заменяет формульные значения.`,
                status: 'ok'
              });
            }
          } else {
            hrZonesSteps.push({
              title: 'Калибровка не активирована',
              detail: `Откалибровано ${calibration.calibratedZones} зон, нужно ≥3. Используем формульные зоны.`,
              status: 'warning'
            });
          }
        } else {
          hrZonesSteps.push({
            title: 'Автокалибровка: недостаточно данных',
            detail: 'Нужно ≥3 тренировок с пульсом и ≥10 сплитов. Используем формульные зоны.',
            status: 'warning'
          });
        }
      }

      // Step 3: Aerobic Threshold
      hrZonesSteps.push({
        title: 'Определение аэробного порога (AeT)',
        detail: 'Ищем длительные пробежки (≥8 км) с дрейфом пульса <5% за 60 дней.',
        status: 'info'
      });

      const aetData = await detectAerobicThreshold(userId);
      if (aetData) {
        hrZonesSteps.push({
          title: `AeT = ${aetData.aerobicThreshold} уд/мин`,
          detail: `По ${aetData.basedOn} стабильным пробежкам. Лучшая: "${aetData.bestRun?.name}" (drift ${aetData.bestRun?.drift}%, avg HR ${aetData.bestRun?.avgHR}).`,
          status: 'ok'
        });
        for (const run of aetData.allStableRuns || []) {
          hrZonesSteps.push({
            title: `${run.name} (${run.date})`,
            detail: `${run.distance_km} км, drift ${run.drift}%, avg HR ${run.avgHR} уд/мин, темп ${formatPace(run.pace)}`,
            status: 'ok'
          });
        }
        hrZonesSteps.push({
          title: 'AeT корректирует зоны',
          detail: `Верхняя граница Easy → ${aetData.aerobicThreshold} уд/мин. Нижняя граница Marathon ≥ ${aetData.aerobicThreshold}.`,
          status: 'ok'
        });
      } else {
        hrZonesSteps.push({
          title: 'AeT не определён',
          detail: 'Нет стабильных длительных пробежек с пульсом (≥8 км, drift <5%). Нужно больше данных.',
          status: 'warning'
        });
      }
    }

    // Final HR zones result
    const hrZonesCalc = calculateHRZones(maxHR, restingHR);
    sections.push({
      id: 'hrZones',
      title: 'Пульсовые зоны',
      result: hrZonesCalc ? `${hrZonesCalc.method === 'karvonen' ? 'Карвонен' : '%HRmax'}` : 'Нет данных',
      status: maxHR ? 'ok' : 'error',
      steps: hrZonesSteps
    });

    // ============================
    // SECTION 6: TRIMP
    // ============================
    const trimpSteps = [];
    const trimpData = await getWeeklyTRIMP(userId);

    if (trimpData && trimpData.weeks) {
      const hasRestingHR = !!restingHR;
      trimpSteps.push({
        title: hasRestingHR ? 'Метод: Banister TRIMP (полный)' : 'Метод: упрощённый TRIMP',
        detail: hasRestingHR
          ? `Формула: duration × HRR × 0.64 × e^(k × HRR), где HRR = (avgHR − ${restingHR}) / (${maxHR} − ${restingHR}), k = ${profile.gender === 'female' ? '1.67' : '1.92'}`
          : `Формула: duration × (avgHR / 180). Нет пульса покоя → упрощённая формула.`,
        formula: hasRestingHR ? 'TRIMP = t × HRR × 0.64 × e^(k × HRR)' : 'TRIMP = t × (HR / 180)',
        status: hasRestingHR ? 'ok' : 'warning'
      });

      for (const w of trimpData.weeks) {
        const label = w.weekAgo === 0 ? 'Текущая неделя' : `${w.weekAgo} нед. назад`;
        trimpSteps.push({
          title: `${label}: TRIMP = ${w.trimp}`,
          detail: `${w.workoutsWithHR} из ${w.totalWorkouts} тренировок с пульсом`,
          status: w.workoutsWithHR > 0 ? 'ok' : 'warning'
        });
      }

      trimpSteps.push({
        title: `Тренд: ${trimpData.trend}`,
        detail: trimpData.trend === 'increasing' ? 'Нагрузка растёт' : trimpData.trend === 'decreasing' ? 'Нагрузка снижается' : 'Нагрузка стабильна',
        status: 'ok'
      });
    } else {
      trimpSteps.push({
        title: 'TRIMP не рассчитан',
        detail: 'Нет тренировок с пульсом за 4 недели.',
        status: 'warning'
      });
    }

    sections.push({
      id: 'trimp',
      title: 'Тренировочная нагрузка (TRIMP)',
      result: trimpData?.weeks ? `Тренд: ${trimpData.trend}` : 'Нет данных',
      status: trimpData?.weeks ? 'ok' : 'warning',
      steps: trimpSteps
    });

    // ============================
    // SECTION 7: HR Trend & Cardiac Efficiency
    // ============================
    const hrTrendSteps = [];
    const hrTrend = await getHRTrendContext(userId);

    if (hrTrend && hrTrend.length > 0) {
      hrTrendSteps.push({
        title: 'Тренд пульса за 4 недели',
        detail: `${hrTrend.length} недель с данными.`,
        status: 'ok'
      });

      for (const w of hrTrend) {
        const label = w.weekAgo === 0 ? 'Текущая' : `${w.weekAgo} нед. назад`;
        hrTrendSteps.push({
          title: `${label}: avg HR ${w.avgHR}${w.avgPace ? ', темп ' + w.avgPace : ''}`,
          detail: `${w.workouts} тренировок${w.cardiacEfficiency ? ', CE = ' + w.cardiacEfficiency + ' (pace/HR, ниже = лучше)' : ''}`,
          status: 'ok'
        });
      }

      // CE trend
      if (hrTrend.length >= 2) {
        const first = hrTrend[0].cardiacEfficiency;
        const last = hrTrend[hrTrend.length - 1].cardiacEfficiency;
        if (first && last) {
          const diff = last - first;
          const trend = diff < -0.05 ? 'улучшается' : diff > 0.05 ? 'ухудшается' : 'стабильна';
          hrTrendSteps.push({
            title: `Кардио-эффективность: ${trend}`,
            detail: `CE ${first} → ${last} (разница ${diff > 0 ? '+' : ''}${diff.toFixed(2)})`,
            status: diff <= 0.05 ? 'ok' : 'warning'
          });
        }
      }
    } else {
      hrTrendSteps.push({
        title: 'Нет данных пульсового тренда',
        detail: 'Нужно ≥2 тренировок с пульсом за 4 недели.',
        status: 'warning'
      });
    }

    sections.push({
      id: 'hrTrend',
      title: 'Пульсовой тренд и CE',
      result: hrTrend ? `${hrTrend.length} недель` : 'Нет данных',
      status: hrTrend ? 'ok' : 'warning',
      steps: hrTrendSteps
    });

    // ============================
    // SECTION 8: Aerobic Decoupling
    // ============================
    const decouplingSteps = [];
    const decouplingData = await getRecentDecouplingData(userId);

    if (decouplingData && decouplingData.length > 0) {
      decouplingSteps.push({
        title: 'Дрейф пульса на длительных',
        detail: `Анализ ${decouplingData.length} длительных пробежек (≥10 км) за 30 дней.`,
        status: 'ok'
      });

      for (const r of decouplingData) {
        const statusText = r.drift < 5 ? 'отлично' : r.drift < 10 ? 'умеренно' : 'высокий';
        decouplingSteps.push({
          title: `${r.name} (${r.date}): drift ${r.drift}%`,
          detail: `${r.distance_km} км. 1-я половина: ${r.avgHR1} уд/мин → 2-я: ${r.avgHR2} уд/мин. Статус: ${statusText}.`,
          status: r.drift < 5 ? 'ok' : r.drift < 10 ? 'warning' : 'error'
        });
      }
    } else {
      decouplingSteps.push({
        title: 'Нет данных дрейфа пульса',
        detail: 'Нужны длительные пробежки ≥10 км с 500м-сплитами и пульсом.',
        status: 'warning'
      });
    }

    sections.push({
      id: 'decoupling',
      title: 'Аэробный дрейф пульса',
      result: decouplingData ? `${decouplingData.length} пробежек` : 'Нет данных',
      status: decouplingData ? 'ok' : 'warning',
      steps: decouplingSteps
    });

    // ============================
    // SECTION 9: Profile Summary
    // ============================
    const profileSteps = [];
    profileSteps.push({
      title: 'Физические параметры',
      detail: [
        profile.age ? `Возраст: ${profile.age}` : 'Возраст: не указан',
        profile.gender ? `Пол: ${profile.gender}` : 'Пол: не указан',
        profile.height_cm ? `Рост: ${profile.height_cm} см` : 'Рост: не указан',
        profile.weight_kg ? `Вес: ${profile.weight_kg} кг` : 'Вес: не указан'
      ].join(' | '),
      status: (profile.age && profile.gender) ? 'ok' : 'warning'
    });

    const filledParams = [profile.age, profile.gender, profile.height_cm, profile.weight_kg, profile.max_heartrate_user, profile.resting_heartrate].filter(Boolean).length;
    profileSteps.push({
      title: `Заполненность профиля: ${filledParams}/6`,
      detail: 'Возраст, пол, рост, вес, макс. пульс, пульс покоя. Чем больше данных, тем точнее расчёты.',
      status: filledParams >= 4 ? 'ok' : filledParams >= 2 ? 'warning' : 'error'
    });

    sections.push({
      id: 'profile',
      title: 'Данные профиля',
      result: `${filledParams}/6 параметров`,
      status: filledParams >= 4 ? 'ok' : 'warning',
      steps: profileSteps
    });

    // ============================
    // SECTION 9.5: Riegel Race-Time Predictions
    // ============================
    const riegelSteps = [];

    // Pull PB goals
    const { data: pbGoals } = await supabase
      .from('goals')
      .select('id, type, target_value')
      .eq('user_id', userId)
      .in('type', ['pb_5k', 'pb_10k', 'pb_21k', 'pb_42k']);

    if (!pbGoals || pbGoals.length === 0) {
      riegelSteps.push({
        title: 'Нет PB-целей',
        detail: 'Добавь цель на 5K / 10K / полумарафон / марафон, чтобы появился прогноз.',
        status: 'info'
      });
    } else {
      // Fetch workouts for last 4 weeks with best_efforts + HR
      const fourWeeksAgo = new Date();
      fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

      const baseSelect = 'distance, moving_time, average_heartrate, date, best_efforts';
      const fullSelect = baseSelect + (workoutsState.hasAnomalyColumns
        ? ', is_suspicious, user_verified, manual_distance, manual_moving_time'
        : '');

      let { data: pbWorkouts, error: pbErr } = await supabase
        .from('workouts')
        .select(fullSelect)
        .eq('user_id', userId)
        .gte('date', fourWeeksAgo.toISOString());

      if (pbErr && pbErr.message && /(is_suspicious|user_verified|manual_)/.test(pbErr.message)) {
        workoutsState.hasAnomalyColumns = false;
        const fb = await supabase
          .from('workouts')
          .select(baseSelect)
          .eq('user_id', userId)
          .gte('date', fourWeeksAgo.toISOString());
        pbWorkouts = fb.data || [];
      }

      const summary = [];

      for (const goal of pbGoals) {
        const goalLabel = `${PB_BE_NAME[goal.type]} (цель ${fmtTime(goal.target_value)})`;

        const result = computeRiegelPrediction({
          workouts: pbWorkouts || [],
          goalType: goal.type,
          targetTimeSec: goal.target_value,
          userMaxHR: maxHR,
          hasAnomalyColumns: workoutsState.hasAnomalyColumns
        });

        // Header step per goal
        riegelSteps.push({
          title: `▼ ${goalLabel}`,
          detail: result.ok
            ? `Прогноз ~${fmtTime(result.finalTime)} (источник: ${result.source === 'best_effort' ? 'Strava-сплит' : 'формула Ригеля'})`
            : 'Прогноз не рассчитан — недостаточно данных за 4 недели.',
          status: result.ok ? 'ok' : 'warning'
        });

        // Adaptive Riegel exponent
        riegelSteps.push({
          title: 'Адаптивная экспонента Ригеля',
          detail: `Средний темп за 4 недели: ${fmtPace(result.avgPaceSec || 0)} (по ${result.paceSamples} тренировкам). Темп <4:30 → 1.06, <5:30 → 1.08, <6:30 → 1.10, иначе 1.12. Выбрано: ${result.riegelExp}.`,
          formula: 'T_target = T_ref × (D_target / D_ref)^k',
          status: result.paceSamples > 0 ? 'ok' : 'warning'
        });

        // Candidates
        if (result.candidates.length === 0) {
          riegelSteps.push({
            title: 'Кандидатов нет',
            detail: `Ищем сплиты best_efforts от 1 км до ${(result.targetDistM * 0.95 / 1000).toFixed(1)} км в тренировках за 4 недели. Не найдено ни одного.`,
            status: 'warning'
          });
        } else {
          riegelSteps.push({
            title: `Найдено кандидатов: ${result.candidates.length}`,
            detail: 'Каждый сплит из best_efforts (1K, 1 Mile, 2 Mile, 5K, 10K, HM) пересчитан в целевую дистанцию по формуле Ригеля. Ниже — топ-3 по freshness-взвешенному времени.',
            status: 'ok'
          });

          for (const c of result.top3) {
            const baseTime = c.time / c.hrCorr;
            const hrPart = c.hrAdjusted
              ? ` × ${c.hrCorr.toFixed(2)} (HR ${c.avgHR}, ${c.pctHRmax}% от макс.) = ${fmtTime(c.time)}`
              : '';
            riegelSteps.push({
              title: `${c.effortName} от ${c.dateFormatted} → ${c.timeFormatted}`,
              detail: `${c.movingTimeFormatted} × (${(result.targetDistM / c.effortDistM).toFixed(3)})^${result.riegelExp} = ${fmtTime(baseTime)}${hrPart}. Freshness: ${c.freshness.toFixed(2)}.`,
              status: 'ok'
            });
          }

          // Weighted median
          const top3Lines = result.top3
            .map(c => `${c.timeFormatted}×${c.freshness.toFixed(2)}`)
            .join(' + ');
          riegelSteps.push({
            title: `Взвешенная медиана топ-3: ${fmtTime(result.riegelEstimate)}`,
            detail: `(${top3Lines}) / Σfreshness = ${fmtTime(result.riegelEstimate)}.`,
            formula: 'Σ(time × freshness) / Σ(freshness)',
            status: 'ok'
          });
        }

        // Strava best_effort at target distance
        if (result.bestEffort) {
          riegelSteps.push({
            title: `Strava-сплит ${PB_BE_NAME[goal.type]}: ${result.bestEffort.timeFormatted}`,
            detail: `Лучший сплит на целевой дистанции из тренировки ${result.bestEffort.dateFormatted}.`,
            status: 'ok'
          });
        } else if (result.discardedBE) {
          riegelSteps.push({
            title: `Strava-сплит отсечён: ${result.discardedBE.timeFormatted}`,
            detail: `${result.discardedBE.reason}. Sanity-check: |BE| < 0.85 × Riegel.`,
            status: 'warning'
          });
        } else {
          riegelSteps.push({
            title: `Strava-сплит ${PB_BE_NAME[goal.type]}: не найден`,
            detail: 'Нет тренировки за 4 недели с best_effort на целевой дистанции.',
            status: 'info'
          });
        }

        // Final pick
        if (result.ok) {
          riegelSteps.push({
            title: `Финальный выбор: ${fmtTime(result.finalTime)}`,
            detail: result.chosenReason,
            status: 'ok'
          });

          // Gap vs target
          if (result.gap !== null) {
            const gapAbs = Math.abs(result.gap);
            const gapStatus = result.gap <= 0 ? 'ok' : result.gap <= goal.target_value * 0.05 ? 'warning' : 'error';
            const gapText = result.gap <= 0
              ? `Прогноз быстрее цели на ${fmtTime(gapAbs)} ✓`
              : `Прогноз медленнее цели на ${fmtTime(gapAbs)} (${(result.gap / goal.target_value * 100).toFixed(1)}%).`;
            riegelSteps.push({
              title: 'Разрыв с целью',
              detail: gapText,
              status: gapStatus
            });
          }
        }

        summary.push(result.ok
          ? `${PB_BE_NAME[goal.type]}: ${fmtTime(result.finalTime)}`
          : `${PB_BE_NAME[goal.type]}: —`);
      }

      // Replace section header summary
      riegelSteps.unshift({
        title: 'Прогнозы по PB-целям',
        detail: summary.join(' | '),
        status: 'ok'
      });
    }

    sections.push({
      id: 'riegel',
      title: 'Прогноз времени на дистанции (Ригель)',
      result: pbGoals && pbGoals.length > 0 ? `${pbGoals.length} цел.` : 'Нет целей',
      status: pbGoals && pbGoals.length > 0 ? 'ok' : 'info',
      steps: riegelSteps
    });

    // ============================
    // SECTION 10: AI Coach Prompt Snapshot
    // ============================
    const lang = (req.query.lang || 'ru').toString().toLowerCase();

    const [monthlySummary, goals, currentPlan, records, weeklyVolumes, predictions, rawMacroPlan] = await Promise.all([
      getMonthlySummaryContext(userId),
      getUserGoals(userId),
      getCurrentPlan(userId),
      getUserRecords(userId),
      getWeeklyVolumes(userId),
      getRiegelPredictions(userId),
      getActiveMacroPlan(userId)
    ]);

    const macroPlan = rawMacroPlan ? await computeMacroPlanWithActuals(userId, rawMacroPlan) : null;
    const stabilityData = await analyzeTrainingStability(userId, 12);

    let goalRealism = null;
    const marathonGoal = (goals || []).find(g => g.type === 'pb_42k');
    if (marathonGoal && estimate.vdot && marathonGoal.deadline) {
      const weeksUntilRace = Math.ceil((new Date(marathonGoal.deadline) - new Date()) / (1000 * 60 * 60 * 24 * 7));
      if (weeksUntilRace > 0) {
        goalRealism = assessMarathonGoalRealism(estimate.vdot, marathonGoal.target_value, weeksUntilRace);
      }
    }

    const complianceData = macroPlan ? analyzeRecentCompliance(macroPlan) : null;
    const vdotSource = estimate.source === 'recent' ? 'workouts' : estimate.source === 'decay' ? 'decay' : null;
    const paceZonesData = estimate.vdot ? { vdot: estimate.vdot, source: vdotSource, zones: paceZones } : null;
    const hrZonesData = hrZonesCalc ? { zones: hrZonesCalc.zones, method: hrZonesCalc.method, aet: null } : null;

    const promptSnapshot = buildChatPromptDebugSnapshot({
      monthlySummary,
      goals,
      currentPlan,
      userProfile: profile,
      records,
      lang: ['ru', 'uk', 'en'].includes(lang) ? lang : 'ru',
      aiPrefs: getAiPrefs(profile),
      weeklyVolumes,
      predictions,
      paceZonesData,
      macroPlan,
      stabilityData,
      goalRealism,
      complianceData,
      hrTrend,
      decouplingData,
      trimpData,
      hrZonesData
    });

    const promptTexts = {
      ru: {
        promptSize: 'Размер system prompt',
        blocksCollected: 'Собрано блоков контекста',
        promptSizeDetail: (chars, tokens, langCode) => `${chars} символов (~${tokens} токенов), язык: ${langCode}.`,
        blocksCollectedDetail: (included, total) => `${included} из ${total} блоков включены в промпт.`,
        blockIncluded: (chars) => `Включён, ${chars} симв.`,
        blockMissing: 'Данных нет, блок не добавлен.',
        preview: 'Превью',
        promptStart: 'Первые символы итогового prompt',
        sectionTitle: 'Промпт AI-тренера',
        sectionResult: (tokens) => `~${tokens} токенов`
      },
      uk: {
        promptSize: 'Розмір system prompt',
        blocksCollected: 'Зібрано блоків контексту',
        promptSizeDetail: (chars, tokens, langCode) => `${chars} символів (~${tokens} токенів), мова: ${langCode}.`,
        blocksCollectedDetail: (included, total) => `${included} із ${total} блоків включено в prompt.`,
        blockIncluded: (chars) => `Включено, ${chars} симв.`,
        blockMissing: 'Даних немає, блок не додано.',
        preview: 'Превʼю',
        promptStart: 'Перші символи підсумкового prompt',
        sectionTitle: 'Промпт AI-тренера',
        sectionResult: (tokens) => `~${tokens} токенів`
      },
      en: {
        promptSize: 'System prompt size',
        blocksCollected: 'Context blocks collected',
        promptSizeDetail: (chars, tokens, langCode) => `${chars} chars (~${tokens} tokens), language: ${langCode}.`,
        blocksCollectedDetail: (included, total) => `${included} of ${total} blocks were included in the prompt.`,
        blockIncluded: (chars) => `Included, ${chars} chars.`,
        blockMissing: 'No data, block was not added.',
        preview: 'Preview',
        promptStart: 'First symbols of final prompt',
        sectionTitle: 'AI coach prompt',
        sectionResult: (tokens) => `~${tokens} tokens`
      }
    };
    const pt = promptTexts[lang] || promptTexts.ru;

    const promptSteps = [];
    promptSteps.push({
      title: pt.promptSize,
      detail: pt.promptSizeDetail(promptSnapshot.stats.chars, promptSnapshot.stats.approxTokens, promptSnapshot.stats.lang),
      formula: 'tokens ≈ chars / 4',
      status: promptSnapshot.stats.approxTokens > 6000 ? 'warning' : 'ok'
    });
    promptSteps.push({
      title: pt.blocksCollected,
      detail: pt.blocksCollectedDetail(promptSnapshot.stats.blocksIncluded, promptSnapshot.stats.blocksTotal),
      status: 'ok'
    });

    for (const block of promptSnapshot.blocks) {
      const preview = block.preview || '—';
      promptSteps.push({
        title: `${block.title}${block.included ? '' : ' (пропущен)'}`,
        detail: `${block.included ? pt.blockIncluded(block.chars) : pt.blockMissing} ${pt.preview}: ${preview}`,
        status: block.included ? 'ok' : 'info'
      });
    }

    const toolCatalog = getAiToolCatalog();
    const toolTexts = {
      ru: {
        sectionTitle: 'Инструменты AI (вне system prompt)',
        sectionDetail: (count) => `Доступно ${count} инструментов. Эти данные не вшиваются в prompt, а подтягиваются моделью по необходимости.`,
        toolTitle: (name) => `Инструмент: ${name}`,
        argsLabel: 'обязательные аргументы',
        noArgs: 'обязательных аргументов нет'
      },
      uk: {
        sectionTitle: 'Інструменти AI (поза system prompt)',
        sectionDetail: (count) => `Доступно ${count} інструментів. Ці дані не вшиваються у prompt, а підтягуються моделлю за потреби.`,
        toolTitle: (name) => `Інструмент: ${name}`,
        argsLabel: 'обовʼязкові аргументи',
        noArgs: 'обовʼязкових аргументів немає'
      },
      en: {
        sectionTitle: 'AI tools (outside system prompt)',
        sectionDetail: (count) => `There are ${count} tools available. This data is not embedded into the prompt and is fetched by the model only when needed.`,
        toolTitle: (name) => `Tool: ${name}`,
        argsLabel: 'required arguments',
        noArgs: 'no required arguments'
      }
    };
    const toolDescriptions = {
      get_workouts_by_date_range: {
        ru: 'Список тренировок за выбранный период (неделя, месяц, квартал).',
        uk: 'Список тренувань за вибраний період (тиждень, місяць, квартал).',
        en: 'Workouts list for a selected period (week, month, quarter).'
      },
      get_workout_details: {
        ru: 'Полные детали конкретной тренировки: сплиты, best efforts, метаданные.',
        uk: 'Повні деталі конкретного тренування: спліти, best efforts, метадані.',
        en: 'Full details of a specific workout: splits, best efforts, metadata.'
      },
      search_workouts: {
        ru: 'Поиск тренировок по фильтрам (дистанция, темп, пульс, тип).',
        uk: 'Пошук тренувань за фільтрами (дистанція, темп, пульс, тип).',
        en: 'Workout search by filters (distance, pace, heart rate, type).'
      },
      get_period_stats: {
        ru: 'Агрегированная статистика за период: объём, время, темп, пульс, набор.',
        uk: 'Агрегована статистика за період: обʼєм, час, темп, пульс, набір.',
        en: 'Aggregated period stats: volume, time, pace, heart rate, elevation.'
      },
      get_personal_records_history: {
        ru: 'История личных рекордов на стандартных дистанциях.',
        uk: 'Історія особистих рекордів на стандартних дистанціях.',
        en: 'Personal records history for standard distances.'
      },
      get_current_plan: {
        ru: 'Текущий недельный план (все 7 дней с деталями).',
        uk: 'Поточний тижневий план (усі 7 днів з деталями).',
        en: 'Current weekly plan (all 7 days with details).'
      },
      get_macro_plan: {
        ru: 'Долгосрочный макро-план с фазами и фактическим выполнением.',
        uk: 'Довгостроковий макро-план з фазами та фактичним виконанням.',
        en: 'Long-term macro plan with phases and compliance details.'
      },
      update_macro_plan: {
        ru: 'Обновление будущих недель макро-плана по решению AI/пользователя.',
        uk: 'Оновлення майбутніх тижнів макро-плану за рішенням AI/користувача.',
        en: 'Update future macro-plan weeks based on AI/user decision.'
      }
    };
    const tt = toolTexts[lang] || toolTexts.ru;
    promptSteps.push({
      title: tt.sectionTitle,
      detail: tt.sectionDetail(toolCatalog.length),
      status: toolCatalog.length > 0 ? 'ok' : 'warning'
    });
    for (const tool of toolCatalog) {
      const localizedDescription = toolDescriptions[tool.name]?.[lang] || toolDescriptions[tool.name]?.ru || tool.description;
      promptSteps.push({
        title: tt.toolTitle(tool.name),
        detail: `${localizedDescription}${tool.hasRequiredArgs ? ` | ${tt.argsLabel}: ${tool.requiredArgs.join(', ')}` : ` | ${tt.noArgs}`}`,
        status: 'info'
      });
    }

    promptSteps.push({
      title: pt.promptStart,
      detail: promptSnapshot.prompt.slice(0, 800),
      status: 'info'
    });

    sections.push({
      id: 'aiPrompt',
      title: pt.sectionTitle,
      result: pt.sectionResult(promptSnapshot.stats.approxTokens),
      status: promptSnapshot.stats.approxTokens > 6000 ? 'warning' : 'ok',
      steps: promptSteps
    });

    res.json({ sections, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Diagnostics error:', err.message);
    res.status(500).json({ error: 'Failed to generate diagnostics' });
  }
});

module.exports = router;
