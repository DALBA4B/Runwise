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
  getWeeklyTRIMP,
  calcTRIMP
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

    // ============================
    // SECTION 11: Training Stability (12 weeks)
    // ============================
    const stabilitySteps = [];
    if (!stabilityData || stabilityData.weeklyVolumes.length === 0) {
      stabilitySteps.push({
        title: 'Нет данных',
        detail: 'За 12 недель не нашли тренировок.',
        status: 'warning'
      });
    } else {
      const wv = stabilityData.weeklyVolumes;
      stabilitySteps.push({
        title: `Недельные объёмы за 12 нед (от старых к новым)`,
        detail: wv.map(v => `${v} км`).join(' → '),
        status: 'ok'
      });
      stabilitySteps.push({
        title: `Средний объём: ${stabilityData.avgVolume} км/нед`,
        detail: `Σ объёмов / 12 = ${stabilityData.avgVolume}.`,
        formula: 'avg = Σ volumes / N',
        status: 'ok'
      });
      stabilitySteps.push({
        title: `Стандартное отклонение: ${stabilityData.volumeStdDev} км`,
        detail: `Корень из ср. квадратов отклонений от среднего.`,
        formula: 'σ = √(Σ(v − avg)² / N)',
        status: 'ok'
      });
      stabilitySteps.push({
        title: `Коэффициент вариации: ${stabilityData.coefficientOfVariation}`,
        detail: `CV = σ / avg. <0.3 — стабильно, 0.3–0.5 — умеренно, >0.5 — нестабильно.`,
        formula: 'CV = σ / avg',
        status: stabilityData.coefficientOfVariation < 0.3 ? 'ok' : stabilityData.coefficientOfVariation < 0.5 ? 'warning' : 'error'
      });
      stabilitySteps.push({
        title: `Пропущенные недели: ${stabilityData.gapWeeks} из 12`,
        detail: `Недели с нулевым объёмом. >25% пропусков снижает consistency-скор.`,
        status: stabilityData.gapWeeks === 0 ? 'ok' : stabilityData.gapWeeks < 3 ? 'warning' : 'error'
      });
      const cvScore = Math.max(0, 100 - stabilityData.coefficientOfVariation * 100);
      const gapPenalty = (stabilityData.gapWeeks / 12) * 50;
      stabilitySteps.push({
        title: `Consistency-скор: ${stabilityData.consistency}/100`,
        detail: `cvScore = max(0, 100 − CV×100) = ${Math.round(cvScore)}. gapPenalty = (${stabilityData.gapWeeks}/12)×50 = ${Math.round(gapPenalty)}. Итого = ${stabilityData.consistency}.`,
        formula: 'consistency = max(0, cvScore − gapPenalty)',
        status: stabilityData.consistency > 60 ? 'ok' : 'warning'
      });
      stabilitySteps.push({
        title: `Вердикт: ${stabilityData.isStable ? 'стабильно' : 'нестабильно'}`,
        detail: `Стабильно если consistency > 60 И пропусков < 25%.`,
        status: stabilityData.isStable ? 'ok' : 'warning'
      });
    }
    sections.push({
      id: 'stability',
      title: 'Стабильность тренировок (12 недель)',
      result: stabilityData ? `${stabilityData.consistency}/100` : 'Нет данных',
      status: stabilityData?.isStable ? 'ok' : 'warning',
      steps: stabilitySteps
    });

    // ============================
    // SECTION 12: Marathon Goal Realism
    // ============================
    const realismSteps = [];
    if (!marathonGoal) {
      realismSteps.push({
        title: 'Нет цели на марафон',
        detail: 'Добавь цель pb_42k с дедлайном, чтобы получить оценку реалистичности.',
        status: 'info'
      });
    } else if (!marathonGoal.deadline) {
      realismSteps.push({
        title: 'У цели нет дедлайна',
        detail: 'Без даты забега невозможно оценить, хватит ли времени на улучшение.',
        status: 'warning'
      });
    } else if (!estimate.vdot) {
      realismSteps.push({
        title: 'VDOT не определён',
        detail: 'Для прогноза нужен текущий VDOT (см. секцию VDOT).',
        status: 'warning'
      });
    } else if (!goalRealism || goalRealism.isRealistic === null) {
      realismSteps.push({
        title: 'Не удалось рассчитать',
        detail: 'Возможно, дедлайн уже прошёл или данных недостаточно.',
        status: 'warning'
      });
    } else {
      realismSteps.push({
        title: `Цель: марафон за ${fmtTime(goalRealism.targetTime)}`,
        detail: `Дедлайн: ${new Date(marathonGoal.deadline).toLocaleDateString('ru-RU')}, осталось ~${goalRealism.weeksAvailable} нед.`,
        status: 'ok'
      });
      realismSteps.push({
        title: `Текущий VDOT: ${goalRealism.currentVDOT} → прогноз ${fmtTime(goalRealism.currentPrediction)}`,
        detail: `По формуле Дэниелса: marathon pace = zones.marathon × 42.195 км.`,
        formula: 'T_pred = pace_marathon × 42.195',
        status: 'ok'
      });
      realismSteps.push({
        title: `Нужно срезать темп на ${goalRealism.paceImprovementNeeded} сек/км`,
        detail: `Текущий темп − целевой = ${goalRealism.paceImprovementNeeded} сек/км. Это ~${(goalRealism.paceImprovementNeeded / 4).toFixed(1)} ед. VDOT (1 VDOT ≈ 4 сек/км).`,
        status: 'ok'
      });
      realismSteps.push({
        title: `Требуемый прогресс: ${goalRealism.requiredImprovement}%/мес VDOT`,
        detail: `Реалистичный максимум: 2–3% в месяц. Если требуется >5%/мес — цель агрессивна.`,
        status: goalRealism.requiredImprovement < 3 ? 'ok' : goalRealism.requiredImprovement < 5 ? 'warning' : 'error'
      });
      if (goalRealism.recommendedTime) {
        realismSteps.push({
          title: `Реалистичный прогноз: ${fmtTime(goalRealism.recommendedTime)}`,
          detail: `При прогрессе 2%/мес × ${(goalRealism.weeksAvailable / 4.33).toFixed(1)} мес → VDOT ${goalRealism.recommendedVDOT}.`,
          status: 'ok'
        });
      }
      realismSteps.push({
        title: `Вердикт: ${goalRealism.isRealistic ? 'цель достижима' : 'цель агрессивна'}`,
        detail: goalRealism.isRealistic
          ? `Требуемый темп прогресса <5%/мес — в рамках реалистичного.`
          : `Нужен прогресс ≥5%/мес — выше типичного. Рассмотри ${fmtTime(goalRealism.recommendedTime)} как реалистичную цель.`,
        status: goalRealism.isRealistic ? 'ok' : 'warning'
      });
    }
    sections.push({
      id: 'goalRealism',
      title: 'Реалистичность цели на марафон',
      result: goalRealism ? (goalRealism.isRealistic ? 'Реально' : 'Агрессивно') : '—',
      status: goalRealism?.isRealistic ? 'ok' : (goalRealism ? 'warning' : 'info'),
      steps: realismSteps
    });

    // ============================
    // SECTION 13: Macro Plan Compliance
    // ============================
    const complianceSteps = [];
    if (!macroPlan) {
      complianceSteps.push({
        title: 'Нет активного макро-плана',
        detail: 'Создай макро-план, чтобы появилась статистика выполнения.',
        status: 'info'
      });
    } else {
      const currentWeekObj = macroPlan.weeks?.[macroPlan.current_week - 1];
      const currentPhase = currentWeekObj?.phase || '—';
      const phaseWeeks = (macroPlan.weeks || []).filter(w => w.phase === currentPhase);
      const phaseIdx = phaseWeeks.findIndex(w => w === currentWeekObj) + 1;

      complianceSteps.push({
        title: `Текущая неделя: ${macroPlan.current_week} из ${macroPlan.weeks?.length || 0}`,
        detail: `Фаза: ${currentPhase}${phaseIdx > 0 ? ` (${phaseIdx}/${phaseWeeks.length} в фазе)` : ''}. План на эту неделю: ${currentWeekObj?.target_volume_km || 0} км.`,
        status: 'ok'
      });

      if (!complianceData) {
        complianceSteps.push({
          title: 'Нет завершённых недель',
          detail: 'Compliance считается по уже прошедшим неделям. Дождись окончания первой недели.',
          status: 'info'
        });
      } else {
        complianceSteps.push({
          title: `Завершено недель: ${complianceData.weeksCompleted} из ${complianceData.totalWeeks}`,
          detail: `Compliance считается как actual_km / target_km × 100% по прошедшим неделям.`,
          formula: 'compliance = actual / target × 100%',
          status: 'ok'
        });

        const completedWeeks = (macroPlan.weeks || []).filter(w => w.compliance_pct !== undefined);
        const recent = completedWeeks.slice(-4);
        for (const w of recent) {
          const status = w.compliance_pct >= 90 && w.compliance_pct <= 110 ? 'ok'
            : w.compliance_pct >= 80 && w.compliance_pct <= 120 ? 'warning' : 'error';
          complianceSteps.push({
            title: `Неделя ${w.week_num || ''} (${w.phase}): ${w.compliance_pct}%`,
            detail: `План ${w.target_volume_km} км → факт ${w.actual_volume_km} км (${w.actual_sessions} тренировок).`,
            status
          });
        }

        complianceSteps.push({
          title: `Средний compliance за 4 нед: ${complianceData.avgCompliance}%`,
          detail: `Тренд: ${complianceData.trend > 5 ? 'растёт' : complianceData.trend < -5 ? 'падает' : 'стабилен'} (${complianceData.trend > 0 ? '+' : ''}${complianceData.trend}% от первой к последней).`,
          status: complianceData.avgCompliance >= 80 && complianceData.avgCompliance <= 120 ? 'ok' : 'warning'
        });

        if (complianceData.consecutiveLow >= 2) {
          complianceSteps.push({
            title: `${complianceData.consecutiveLow} нед. подряд недовыполнения (<80%)`,
            detail: 'План завышен или есть проблемы с тренировками. Стоит снизить целевой объём.',
            status: 'warning'
          });
        }
        if (complianceData.consecutiveHigh >= 2) {
          complianceSteps.push({
            title: `${complianceData.consecutiveHigh} нед. подряд перевыполнения (>115%)`,
            detail: 'План занижен — есть запас, можно увеличить.',
            status: 'warning'
          });
        }
        if (complianceData.needsAdjustment) {
          complianceSteps.push({
            title: 'Рекомендуется пересмотреть план',
            detail: 'Стабильный перекос compliance — план не соответствует реальности.',
            status: 'warning'
          });
        }
      }
    }
    sections.push({
      id: 'compliance',
      title: 'Выполнение макро-плана',
      result: complianceData ? `${complianceData.avgCompliance}% за 4 нед` : (macroPlan ? 'Нет завершённых нед' : 'Нет плана'),
      status: complianceData
        ? (complianceData.needsAdjustment ? 'warning' : 'ok')
        : (macroPlan ? 'info' : 'info'),
      steps: complianceSteps
    });

    // ============================
    // SECTION 14-16: ACWR, Monotony/Strain, Intensity Distribution (80/20)
    // ============================
    // Single fetch for the last 28 days with HR + manual overrides
    const since28 = new Date();
    since28.setDate(since28.getDate() - 28);
    const baseSel = 'id, name, date, distance, moving_time, average_heartrate, splits, best_efforts';
    const fullSel = baseSel + (workoutsState.hasAnomalyColumns ? ', is_suspicious, suspicious_reasons, manual_distance, manual_moving_time' : '');

    let { data: w28all, error: w28err } = await supabase
      .from('workouts')
      .select(fullSel)
      .eq('user_id', userId)
      .gte('date', since28.toISOString());

    if (w28err && w28err.message && /(is_suspicious|suspicious_reasons|manual_)/.test(w28err.message)) {
      workoutsState.hasAnomalyColumns = false;
      const fb = await supabase
        .from('workouts')
        .select('id, name, date, distance, moving_time, average_pace, average_heartrate, splits, best_efforts')
        .eq('user_id', userId)
        .gte('date', since28.toISOString());
      w28all = fb.data || [];
    }
    w28all = w28all || [];
    const w28 = w28all.filter(w => !(workoutsState.hasAnomalyColumns && w.is_suspicious));
    const effDist = (w) => (workoutsState.hasAnomalyColumns && w.manual_distance) ? w.manual_distance : (w.distance || 0);
    const effTime = (w) => (workoutsState.hasAnomalyColumns && w.manual_moving_time) ? w.manual_moving_time : (w.moving_time || 0);

    const now28 = new Date();
    const acuteCutoff = new Date(now28); acuteCutoff.setDate(acuteCutoff.getDate() - 7);
    const w7 = w28.filter(w => new Date(w.date) >= acuteCutoff);

    // ----------------------------
    // SECTION 13.5: Data Quality & GPS Anomalies
    // ----------------------------
    const dqSteps = [];
    const totalCount = w28all.length;

    if (totalCount === 0) {
      dqSteps.push({
        title: 'Нет тренировок за 30 дней',
        detail: 'Синхронизируй данные со Strava.',
        status: 'warning'
      });
    } else {
      const withHR = w28all.filter(w => w.average_heartrate).length;
      const withSplits = w28all.filter(w => w.splits).length;
      const withBE = w28all.filter(w => w.best_efforts).length;
      const suspicious = workoutsState.hasAnomalyColumns
        ? w28all.filter(w => w.is_suspicious)
        : [];

      const pctHR = Math.round(withHR / totalCount * 100);
      const pctSplits = Math.round(withSplits / totalCount * 100);
      const pctBE = Math.round(withBE / totalCount * 100);

      dqSteps.push({
        title: `Всего тренировок за 30 дней: ${totalCount}`,
        detail: `Анализируется окно из последних 30 дней.`,
        status: 'ok'
      });
      dqSteps.push({
        title: `С пульсом: ${withHR} (${pctHR}%)`,
        detail: `Пульс нужен для TRIMP, HR-зон, дрейфа, monotony, 80/20. Без него часть расчётов недоступна.`,
        status: pctHR >= 80 ? 'ok' : pctHR >= 50 ? 'warning' : 'error'
      });
      dqSteps.push({
        title: `Со сплитами (1 км): ${withSplits} (${pctSplits}%)`,
        detail: `Сплиты нужны для детектора аномалий и аэробного дрейфа на длительных.`,
        status: pctSplits >= 70 ? 'ok' : 'warning'
      });
      dqSteps.push({
        title: `С best_efforts (Strava): ${withBE} (${pctBE}%)`,
        detail: `best_efforts (1K, 5K, 10K, HM, M) — основа Riegel-прогноза. Без них прогноз времени на дистанцию недоступен.`,
        status: pctBE >= 50 ? 'ok' : 'warning'
      });

      if (!workoutsState.hasAnomalyColumns) {
        dqSteps.push({
          title: 'Колонки аномалий в БД отсутствуют',
          detail: 'Поля is_suspicious / suspicious_reasons не созданы. Детектор не работает, все тренировки попадают в расчёты.',
          status: 'warning'
        });
      } else {
        dqSteps.push({
          title: `Помечено подозрительными: ${suspicious.length} из ${totalCount}`,
          detail: suspicious.length === 0
            ? 'Все тренировки прошли проверку GPS.'
            : 'Suspicious-тренировки исключаются из VDOT, Riegel, объёмов и большинства расчётов (если только пользователь не подтвердил вручную).',
          formula: 'split <2:30/км ИЛИ split >12:00/км ИЛИ |avg_pace − median_pace|/median > 30%',
          status: suspicious.length === 0 ? 'ok' : suspicious.length / totalCount < 0.1 ? 'warning' : 'error'
        });

        // Per-anomaly detail (up to 8)
        const reasonLabels = {
          split_too_fast: (km, pace) => `сплит ${km}км слишком быстрый (${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, '0')}/км)`,
          split_too_slow: (km, pace) => `сплит ${km}км слишком медленный (${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, '0')}/км)`,
          avg_median_drift: (pct) => `avg vs median разошлись на ${pct}%`,
        };
        const fmtReason = (r) => {
          const [type, ...args] = r.split(':');
          if (type === 'split_too_fast' || type === 'split_too_slow') {
            return reasonLabels[type] ? reasonLabels[type](args[0], parseInt(args[1], 10)) : r;
          }
          if (type === 'avg_median_drift') {
            return reasonLabels[type] ? reasonLabels[type](args[0]) : r;
          }
          return r;
        };

        for (const w of suspicious.slice(0, 8)) {
          let reasons = [];
          try {
            reasons = typeof w.suspicious_reasons === 'string'
              ? JSON.parse(w.suspicious_reasons)
              : (w.suspicious_reasons || []);
          } catch { reasons = []; }
          const reasonText = reasons.length > 0
            ? reasons.map(fmtReason).join('; ')
            : 'причины не сохранены';
          const dateLabel = w.date ? new Date(w.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '?';
          dqSteps.push({
            title: `"${w.name || 'Без названия'}" (${dateLabel})`,
            detail: reasonText,
            status: 'warning'
          });
        }
        if (suspicious.length > 8) {
          dqSteps.push({
            title: `… и ещё ${suspicious.length - 8} подозрительных`,
            detail: 'Показаны только первые 8.',
            status: 'info'
          });
        }
      }
    }
    sections.push({
      id: 'dataQuality',
      title: 'Качество данных и GPS-аномалии',
      result: totalCount > 0
        ? `${totalCount} трен., ${workoutsState.hasAnomalyColumns ? w28all.filter(w => w.is_suspicious).length : '?'} suspicious`
        : 'Нет данных',
      status: totalCount === 0 ? 'warning' : 'ok',
      steps: dqSteps
    });

    // ----------------------------
    // SECTION 14: ACWR (Acute:Chronic Workload Ratio)
    // ----------------------------
    const acwrSteps = [];
    const acuteKm = w7.reduce((s, w) => s + effDist(w) / 1000, 0);
    const chronicKmTotal = w28.reduce((s, w) => s + effDist(w) / 1000, 0);
    const chronicAvgWeek = chronicKmTotal / 4;

    if (chronicAvgWeek <= 0) {
      acwrSteps.push({
        title: 'Недостаточно данных',
        detail: 'За 28 дней не нашли тренировок с дистанцией.',
        status: 'warning'
      });
    } else {
      const acwr = acuteKm / chronicAvgWeek;
      let acwrStatus = 'ok';
      let acwrLabel = '';
      if (acwr < 0.8) { acwrStatus = 'warning'; acwrLabel = 'detraining (недогруз)'; }
      else if (acwr <= 1.3) { acwrStatus = 'ok'; acwrLabel = 'sweet spot (оптимум)'; }
      else if (acwr <= 1.5) { acwrStatus = 'warning'; acwrLabel = 'caution (повышенный риск)'; }
      else { acwrStatus = 'error'; acwrLabel = 'high risk (риск травмы)'; }

      acwrSteps.push({
        title: `Острая нагрузка (7 дней): ${Math.round(acuteKm * 10) / 10} км`,
        detail: `Сумма дистанций за последние 7 дней (${w7.length} тренировок).`,
        status: 'ok'
      });
      acwrSteps.push({
        title: `Хроническая нагрузка (28 дней): ${Math.round(chronicKmTotal * 10) / 10} км → ${Math.round(chronicAvgWeek * 10) / 10} км/нед`,
        detail: `Сумма за 28 дней / 4 = средний недельный объём (${w28.length} тренировок).`,
        formula: 'chronic = total_28d / 4',
        status: 'ok'
      });
      acwrSteps.push({
        title: `ACWR = ${acwr.toFixed(2)} → ${acwrLabel}`,
        detail: `${Math.round(acuteKm * 10) / 10} / ${Math.round(chronicAvgWeek * 10) / 10} = ${acwr.toFixed(2)}. Зоны: <0.8 detraining, 0.8–1.3 sweet spot, 1.3–1.5 caution, >1.5 risky.`,
        formula: 'ACWR = acute / chronic',
        status: acwrStatus
      });
    }
    sections.push({
      id: 'acwr',
      title: 'Острая/хроническая нагрузка (ACWR)',
      result: chronicAvgWeek > 0 ? `${(acuteKm / chronicAvgWeek).toFixed(2)}` : 'Нет данных',
      status: chronicAvgWeek > 0 ? (() => {
        const r = acuteKm / chronicAvgWeek;
        return r < 0.8 || (r > 1.3 && r <= 1.5) ? 'warning' : r > 1.5 ? 'error' : 'ok';
      })() : 'warning',
      steps: acwrSteps
    });

    // ----------------------------
    // SECTION 15: Monotony & Strain (Foster)
    // ----------------------------
    const monotonySteps = [];
    // Daily TRIMP buckets for last 7 days
    const dailyTRIMP = new Array(7).fill(0);
    const restingHRForTrimp = profile.resting_heartrate || null;
    const genderForTrimp = profile.gender || null;

    let trimpWorkoutsCounted = 0;
    for (const w of w7) {
      const t = effTime(w);
      if (!t || !w.average_heartrate) continue;
      const trimp = calcTRIMP(t / 60, w.average_heartrate, restingHRForTrimp, maxHR, genderForTrimp);
      if (!trimp) continue;
      const daysAgo = Math.floor((now28 - new Date(w.date)) / (1000 * 60 * 60 * 24));
      if (daysAgo >= 0 && daysAgo < 7) {
        dailyTRIMP[daysAgo] += trimp;
        trimpWorkoutsCounted++;
      }
    }

    const sumTRIMP = dailyTRIMP.reduce((a, b) => a + b, 0);
    const avgTRIMP = sumTRIMP / 7;
    const variance = dailyTRIMP.reduce((s, v) => s + Math.pow(v - avgTRIMP, 2), 0) / 7;
    const sdTRIMP = Math.sqrt(variance);
    const monotony = sdTRIMP > 0 ? avgTRIMP / sdTRIMP : null;
    const strain = monotony !== null ? Math.round(sumTRIMP * monotony) : null;

    if (trimpWorkoutsCounted < 2) {
      monotonySteps.push({
        title: 'Недостаточно тренировок с пульсом',
        detail: `За 7 дней нашли ${trimpWorkoutsCounted} тренировок с avg HR. Нужно ≥2 для расчёта.`,
        status: 'warning'
      });
    } else {
      monotonySteps.push({
        title: `Дневной TRIMP (от вчера к 7 дням назад)`,
        detail: dailyTRIMP.map(v => Math.round(v)).join(' → '),
        status: 'ok'
      });
      monotonySteps.push({
        title: `Недельный TRIMP: ${Math.round(sumTRIMP)}`,
        detail: `Сумма дневных TRIMP за 7 дней.`,
        status: 'ok'
      });
      monotonySteps.push({
        title: `Среднее: ${Math.round(avgTRIMP)}, std: ${sdTRIMP.toFixed(1)}`,
        detail: `Разброс нагрузки между днями недели.`,
        status: 'ok'
      });
      let monoStatus = 'ok';
      let monoLabel = '';
      if (monotony !== null) {
        if (monotony < 1.5) { monoStatus = 'ok'; monoLabel = 'разнообразно'; }
        else if (monotony < 2) { monoStatus = 'warning'; monoLabel = 'однообразно'; }
        else { monoStatus = 'error'; monoLabel = 'риск перетренированности'; }
      }
      monotonySteps.push({
        title: `Monotony = ${monotony !== null ? monotony.toFixed(2) : '—'} → ${monoLabel}`,
        detail: `Зоны: <1.5 разнообразно, 1.5–2 однообразно, >2 риск. Высокая monotony = одинаковая нагрузка каждый день, без отдыха.`,
        formula: 'monotony = avgDailyTRIMP / stdDevDailyTRIMP',
        status: monoStatus
      });
      let strainStatus = 'ok';
      if (strain !== null) {
        if (strain > 6000) strainStatus = 'error';
        else if (strain > 4000) strainStatus = 'warning';
      }
      monotonySteps.push({
        title: `Strain = ${strain !== null ? strain : '—'}`,
        detail: `Недельный TRIMP × monotony. >4000 — высокая нагрузка, >6000 — зона риска (Foster).`,
        formula: 'strain = weekly_TRIMP × monotony',
        status: strainStatus
      });
    }
    sections.push({
      id: 'monotony',
      title: 'Monotony & Strain (Foster)',
      result: monotony !== null ? `M=${monotony.toFixed(2)}, S=${strain}` : 'Нет данных',
      status: monotony === null ? 'warning'
        : monotony >= 2 || (strain !== null && strain > 6000) ? 'error'
        : monotony >= 1.5 || (strain !== null && strain > 4000) ? 'warning' : 'ok',
      steps: monotonySteps
    });

    // ----------------------------
    // SECTION 16: Intensity Distribution (80/20)
    // ----------------------------
    const distSteps = [];
    const zonesUsed = hrZonesCalc?.zones || null;

    if (!zonesUsed) {
      distSteps.push({
        title: 'Пульсовые зоны не определены',
        detail: 'Без HR-зон нельзя классифицировать тренировки. См. секцию пульсовых зон.',
        status: 'warning'
      });
    } else {
      // Bucket workouts by HR zone using avg HR + duration
      const buckets = { Easy: 0, Marathon: 0, Threshold: 0, Interval: 0, Repetition: 0 };
      let classified = 0;
      let totalSec = 0;
      for (const w of w28) {
        const hr = w.average_heartrate;
        const t = effTime(w);
        if (!hr || !t) continue;
        let zone = null;
        if (hr <= zonesUsed.Easy?.to) zone = 'Easy';
        else if (hr <= zonesUsed.Marathon?.to) zone = 'Marathon';
        else if (hr <= zonesUsed.Threshold?.to) zone = 'Threshold';
        else if (hr <= zonesUsed.Interval?.to) zone = 'Interval';
        else zone = 'Repetition';
        buckets[zone] += t;
        classified++;
        totalSec += t;
      }

      if (totalSec === 0) {
        distSteps.push({
          title: 'Нет тренировок с пульсом за 28 дней',
          detail: 'Нужны тренировки с avg HR и длительностью.',
          status: 'warning'
        });
      } else {
        const pct = (s) => Math.round((s / totalSec) * 1000) / 10;
        const easyPct = pct(buckets.Easy);
        const moderatePct = pct(buckets.Marathon);
        const hardPct = pct(buckets.Threshold) + pct(buckets.Interval) + pct(buckets.Repetition);

        distSteps.push({
          title: `Классифицировано тренировок: ${classified}`,
          detail: `Тренировка → зона по avg HR: Easy ≤ ${zonesUsed.Easy?.to}, Marathon ≤ ${zonesUsed.Marathon?.to}, Threshold ≤ ${zonesUsed.Threshold?.to}, выше → Interval/Repetition.`,
          status: 'ok'
        });

        for (const [name, sec] of Object.entries(buckets)) {
          if (sec === 0) continue;
          distSteps.push({
            title: `${name}: ${pct(sec)}%`,
            detail: `${Math.round(sec / 60)} мин из ${Math.round(totalSec / 60)} мин общего времени.`,
            status: 'ok'
          });
        }

        // 80/20 verdict
        const z1 = easyPct;
        const z2 = moderatePct;
        const z3 = Math.round(hardPct * 10) / 10;
        let verdict = '';
        let verdictStatus = 'ok';
        if (z1 >= 78) {
          verdict = 'отличное распределение (поляризованное)';
          verdictStatus = 'ok';
        } else if (z1 >= 65) {
          verdict = 'умеренно поляризованное';
          verdictStatus = 'warning';
        } else {
          verdict = 'слишком много среднеинтенсивных тренировок';
          verdictStatus = 'error';
        }

        distSteps.push({
          title: `Easy ${z1}% / Moderate ${z2}% / Hard ${z3}%`,
          detail: `Принцип 80/20 (Сейлер): ≥80% времени должно быть в Easy, ≤20% в Threshold+. ${verdict}.`,
          formula: 'goal: Easy ≥ 80%, Hard ≤ 20%',
          status: verdictStatus
        });

        // Polarization Index (log-based)
        const z1s = Math.max(buckets.Easy, 1);
        const z2s = Math.max(buckets.Marathon, 1);
        const z3s = Math.max(buckets.Threshold + buckets.Interval + buckets.Repetition, 1);
        const pi = Math.log10((z1s / z2s) * z3s);
        distSteps.push({
          title: `Polarization Index: ${pi.toFixed(2)}`,
          detail: `>2 — сильно поляризованные тренировки (классика elite endurance). <1 — пирамидальное распределение.`,
          formula: 'PI = log10((Z1/Z2) × Z3)',
          status: pi >= 2 ? 'ok' : pi >= 1 ? 'warning' : 'info'
        });
      }
    }
    sections.push({
      id: 'intensity',
      title: 'Распределение интенсивности (80/20)',
      result: zonesUsed ? 'Рассчитано' : 'Нет HR-зон',
      status: zonesUsed ? 'ok' : 'warning',
      steps: distSteps
    });

    // ============================
    // SECTION 17: Personal Records (PB-tracker)
    // ============================
    const pbSteps = [];
    const { data: prRows } = await supabase
      .from('personal_records')
      .select('distance_type, time_seconds, record_date')
      .eq('user_id', userId);

    const prList = prRows || [];
    if (prList.length === 0) {
      pbSteps.push({
        title: 'Нет сохранённых рекордов',
        detail: 'Личные рекорды (5K, 10K, HM, M) обновляются автоматически на основе best_efforts из Strava.',
        status: 'info'
      });
    } else {
      const distOrder = ['5K', '10K', 'Half-Marathon', '21K', 'Marathon', '42K', '1K', '1 Mile', '2 Mile'];
      const sorted = [...prList].sort((a, b) => {
        const ai = distOrder.indexOf(a.distance_type);
        const bi = distOrder.indexOf(b.distance_type);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });

      pbSteps.push({
        title: `Сохранено рекордов: ${prList.length}`,
        detail: 'Источник: таблица personal_records. Используются AI как исторический показатель потенциала (но не текущей формы).',
        status: 'ok'
      });

      const today = new Date();
      for (const r of sorted) {
        const recDate = r.record_date ? new Date(r.record_date) : null;
        const daysAgo = recDate ? Math.floor((today - recDate) / (1000 * 60 * 60 * 24)) : null;
        const dateLabel = recDate ? recDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : '?';
        const ageNote = daysAgo !== null
          ? (daysAgo < 90 ? `${daysAgo} дн. назад` : daysAgo < 365 ? `${Math.floor(daysAgo / 30)} мес. назад` : `${Math.floor(daysAgo / 365)} г. ${Math.floor((daysAgo % 365) / 30)} мес. назад`)
          : '';
        const stale = daysAgo !== null && daysAgo > 365;
        pbSteps.push({
          title: `${r.distance_type}: ${fmtTime(r.time_seconds)}`,
          detail: `Дата: ${dateLabel}${ageNote ? ` (${ageNote})` : ''}.${stale ? ' Старше года — текущая форма может быть другой.' : ''}`,
          status: stale ? 'warning' : 'ok'
        });
      }
    }
    sections.push({
      id: 'personalRecords',
      title: 'Личные рекорды (PR)',
      result: prList.length > 0 ? `${prList.length} рекордов` : 'Нет данных',
      status: prList.length > 0 ? 'ok' : 'info',
      steps: pbSteps
    });

    // ============================
    // SECTION 18: Weekly Plan Generation Logic
    // ============================
    // Replicates the volume-base calculation from plan.js
    const planSteps = [];

    // Find anchor — Monday after last workout (same logic as plan.js)
    const { data: lastW } = await supabase
      .from('workouts')
      .select('date')
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .limit(1);

    let anchor;
    if (lastW && lastW.length > 0) {
      const lastDate = new Date(lastW[0].date);
      const dow = lastDate.getDay();
      const daysUntilNextMonday = dow === 0 ? 1 : 8 - dow;
      anchor = new Date(lastDate);
      anchor.setHours(0, 0, 0, 0);
      anchor.setDate(anchor.getDate() + daysUntilNextMonday);
    } else {
      anchor = new Date();
      anchor.setHours(0, 0, 0, 0);
    }

    // Compute weekly distances exactly like plan.js
    const fourWeeksBeforeAnchor = new Date(anchor);
    fourWeeksBeforeAnchor.setDate(fourWeeksBeforeAnchor.getDate() - 28);

    const planWeekly = []; // fresh → old
    if (recentWorkouts && recentWorkouts.length > 0) {
      for (let w = 0; w < 4; w++) {
        const weekEnd = new Date(anchor);
        weekEnd.setDate(weekEnd.getDate() - w * 7);
        const weekStart = new Date(weekEnd);
        weekStart.setDate(weekStart.getDate() - 7);
        const weekWorkouts = recentWorkouts.filter(wr => {
          const d = new Date(wr.date);
          return d >= weekStart && d < weekEnd;
        });
        const totalKm = weekWorkouts.reduce((s, wr) => s + effectiveDistance(wr) / 1000, 0);
        planWeekly.push(Math.round(totalKm * 10) / 10);
      }
    }

    const planAvgKm = planWeekly.length > 0
      ? Math.round(planWeekly.reduce((a, b) => a + b, 0) / planWeekly.length * 10) / 10
      : 0;
    const planLastWeek = planWeekly[0] || 0;
    const planPrevNonZero = planWeekly.find(w => w > 0) || 0;
    const planBase = planLastWeek > 0 && planLastWeek >= planAvgKm * 0.3
      ? planLastWeek
      : Math.round(planPrevNonZero * 0.6 * 10) / 10;
    const planMax = Math.round(planBase * 1.15);
    const lowWeek = planLastWeek === 0 || planLastWeek < planAvgKm * 0.3;

    const planLevel = getRunnerLevel(planAvgKm);

    if (planWeekly.length === 0 || planAvgKm === 0) {
      planSteps.push({
        title: 'Нет тренировок для расчёта',
        detail: 'Логика плана опирается на последние 4 недели. Без них AI запрашивает базовый план.',
        status: 'warning'
      });
    } else {
      planSteps.push({
        title: `Anchor (отправная точка): ${anchor.toLocaleDateString('ru-RU')}`,
        detail: lastW && lastW.length > 0
          ? `Понедельник после последней тренировки (${new Date(lastW[0].date).toLocaleDateString('ru-RU')}). Окно анализа: 4 недели до anchor.`
          : `Нет тренировок — anchor = сегодня.`,
        status: 'ok'
      });
      planSteps.push({
        title: `Недельные объёмы (свежие → старые): ${planWeekly.join(', ')} км`,
        detail: `4 календарные недели (Пн-Вс) до anchor. Используется effectiveDistance (manual_distance > distance).`,
        status: 'ok'
      });
      planSteps.push({
        title: `Средний объём: ${planAvgKm} км/нед`,
        detail: `Σ объёмов / 4 = ${planAvgKm}.`,
        formula: 'avg = Σ weekly / 4',
        status: 'ok'
      });
      planSteps.push({
        title: `Последняя неделя: ${planLastWeek} км`,
        detail: lowWeek
          ? `Меньше 30% от среднего → AI считает это пропуском (болезнь/отдых). База берётся как 60% от предпоследней нормальной недели.`
          : `≥30% от среднего → нормальная неделя, берётся за базу напрямую.`,
        status: lowWeek ? 'warning' : 'ok'
      });
      planSteps.push({
        title: `База плана: ${planBase} км`,
        detail: lowWeek
          ? `prevNonZero × 0.6 = ${planPrevNonZero} × 0.6 = ${planBase}. Мягкое возвращение после провала.`
          : `lastWeek = ${planLastWeek} → база ${planBase}.`,
        formula: 'base = lastWeek (если ≥30% от avg) иначе prevNonZero × 0.6',
        status: 'ok'
      });
      planSteps.push({
        title: `Жёсткий потолок плана: ${planMax} км`,
        detail: `База + 10–15% максимум. AI обязан удержать суммарный километраж недели в этих рамках.`,
        formula: 'maxPlan = base × 1.15',
        status: 'ok'
      });
      planSteps.push({
        title: `Уровень бегуна: ${planLevel}`,
        detail: `<20 км/нед → beginner (3-4 трен., max 1 ключевая), 20-50 → intermediate (4-5 трен., max 2), 50+ → advanced (5-6 трен., 2-3 ключевых).`,
        status: 'ok'
      });
      if (estimate.vdot && paceZones) {
        planSteps.push({
          title: `VDOT для зон: ${estimate.vdot} (источник: ${estimate.source})`,
          detail: `AI получит готовые темповые зоны: Easy ${formatPace(paceZones.easyMin)}–${formatPace(paceZones.easyMax)}, M ${formatPace(paceZones.marathon)}, T ${formatPace(paceZones.threshold)}, I ${formatPace(paceZones.interval)}, R ${formatPace(paceZones.repetition)}.`,
          status: 'ok'
        });
      } else {
        planSteps.push({
          title: 'VDOT не определён',
          detail: 'AI получит fallback-инструкции: Easy = текущий avg + 60-90 сек/км, Tempo = avg − 10-20 сек/км и т.п.',
          status: 'warning'
        });
      }
      if (macroPlan && macroPlan.weeks?.[macroPlan.current_week - 1]) {
        const cw = macroPlan.weeks[macroPlan.current_week - 1];
        planSteps.push({
          title: `Из макро-плана: фаза "${cw.phase}", цель ${cw.target_volume_km} км`,
          detail: `AI получит фазу как ориентир (база/build/peak/taper) и целевой объём как guideline. Реальный объём адаптируется под compliance последних недель.`,
          status: 'ok'
        });
      }
    }

    sections.push({
      id: 'planLogic',
      title: 'Логика генерации недельного плана',
      result: planAvgKm > 0 ? `база ${planBase} км, max ${planMax} км` : 'Нет данных',
      status: planAvgKm > 0 ? 'ok' : 'warning',
      steps: planSteps
    });

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
