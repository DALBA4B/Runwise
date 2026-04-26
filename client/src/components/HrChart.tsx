import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import './HrChart.css';

interface HrZoneRange {
  from: number;
  to: number;
}

interface HrZones {
  easy: HrZoneRange;
  marathon: HrZoneRange;
  threshold: HrZoneRange;
  interval: HrZoneRange;
  repetition: HrZoneRange;
}

interface HrChartProps {
  streams: {
    time: number[];
    heartrate: number[];
    distance?: number[];
  };
  hrZones?: HrZones | null;
  hrMethod?: 'karvonen' | 'pctHRmax' | 'calibrated' | null;
  showChart?: boolean;
}

const ZONE_KEYS = ['easy', 'marathon', 'threshold', 'interval', 'repetition'] as const;
type ZoneKey = typeof ZONE_KEYS[number];

const ZONE_COLORS: Record<ZoneKey, string> = {
  easy: '#4CAF50',
  marathon: '#2196F3',
  threshold: '#FF9800',
  interval: '#f44336',
  repetition: '#9C27B0'
};

// Decimate array to maxPoints by even-step sampling (preserving first and last)
function decimate<T>(arr: T[], maxPoints: number): { data: T[]; indices: number[] } {
  if (arr.length <= maxPoints) return { data: arr, indices: arr.map((_, i) => i) };
  const step = arr.length / maxPoints;
  const data: T[] = [];
  const indices: number[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(arr.length - 1, Math.floor(i * step));
    data.push(arr[idx]);
    indices.push(idx);
  }
  // ensure last point present
  if (indices[indices.length - 1] !== arr.length - 1) {
    data.push(arr[arr.length - 1]);
    indices.push(arr.length - 1);
  }
  return { data, indices };
}

// Format seconds → MM:SS or HH:MM:SS
function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Robust zone classification: each zone covers [from, nextZoneFrom),
// last zone covers [from, +∞). HR below the lowest zone counts as the lowest.
function classifyHrToZone(hr: number, hrZones: HrZones): ZoneKey | null {
  const sorted = ZONE_KEYS
    .map(key => ({ key, from: hrZones[key].from }))
    .sort((a, b) => a.from - b.from);

  if (sorted.length === 0) return null;
  if (hr < sorted[0].from) return sorted[0].key;

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    if (next) {
      if (hr >= cur.from && hr < next.from) return cur.key;
    } else {
      if (hr >= cur.from) return cur.key;
    }
  }
  return null;
}

const HrChart: React.FC<HrChartProps> = ({ streams, hrZones, showChart = false }) => {
  const { t } = useTranslation();

  // Filter out invalid HR samples (some watches put 0 between segments)
  const { times, hrs } = useMemo(() => {
    const t: number[] = [];
    const h: number[] = [];
    const len = Math.min(streams.time.length, streams.heartrate.length);
    for (let i = 0; i < len; i++) {
      const hr = streams.heartrate[i];
      if (hr && hr > 30 && hr < 250) {
        t.push(streams.time[i]);
        h.push(hr);
      }
    }
    return { times: t, hrs: h };
  }, [streams]);

  // Compute time-in-zones (in seconds) using full data, before decimation
  const zoneSeconds = useMemo(() => {
    const seconds: Record<ZoneKey, number> = {
      easy: 0, marathon: 0, threshold: 0, interval: 0, repetition: 0
    };
    if (!hrZones || times.length < 2) return seconds;

    for (let i = 0; i < times.length - 1; i++) {
      const dt = times[i + 1] - times[i];
      if (dt <= 0 || dt > 30) continue; // skip pauses
      const zone = classifyHrToZone(hrs[i], hrZones);
      if (zone) seconds[zone] += dt;
    }
    return seconds;
  }, [times, hrs, hrZones]);

  const totalZoneSec = ZONE_KEYS.reduce((s, k) => s + zoneSeconds[k], 0);

  // HR stats: min / avg / max (from full unfiltered samples)
  const hrStats = useMemo(() => {
    if (hrs.length === 0) return null;
    let mn = hrs[0], mx = hrs[0], sum = 0;
    for (const v of hrs) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v;
    }
    return { min: mn, max: mx, avg: Math.round(sum / hrs.length) };
  }, [hrs]);

  // Decimate for rendering — max 500 points
  const decimated = useMemo(() => {
    const dec = decimate(hrs, 500);
    return {
      hr: dec.data,
      time: dec.indices.map(i => times[i] || 0)
    };
  }, [hrs, times]);

  if (hrs.length < 5) {
    return (
      <div className="hr-chart-empty">
        <span>{t('workout.noHrData')}</span>
      </div>
    );
  }

  // Chart geometry
  const W = 600; // viewBox width
  const H = 340; // viewBox height
  const padding = { top: 14, right: 16, bottom: 36, left: 48 };
  const chartW = W - padding.left - padding.right;
  const chartH = H - padding.top - padding.bottom;

  const minTime = decimated.time[0];
  const maxTime = decimated.time[decimated.time.length - 1];
  const timeSpan = Math.max(1, maxTime - minTime);

  // HR range with padding
  let hrMin = Math.min(...decimated.hr);
  let hrMax = Math.max(...decimated.hr);
  const hrPad = Math.max(8, Math.round((hrMax - hrMin) * 0.18));
  hrMin = Math.max(40, hrMin - hrPad);
  hrMax = Math.min(220, hrMax + hrPad);

  // Extend range to include any HR zone that overlaps even slightly (so user sees the band)
  if (hrZones) {
    for (const key of ZONE_KEYS) {
      const z = hrZones[key];
      // If zone touches visible range → include the whole zone
      if (z.to >= hrMin - 5 && z.from <= hrMax + 5) {
        hrMin = Math.min(hrMin, z.from);
        hrMax = Math.max(hrMax, z.to);
      }
    }
    hrMin = Math.max(40, hrMin);
    hrMax = Math.min(220, hrMax);
  }

  const hrRange = Math.max(1, hrMax - hrMin);

  const xFor = (t: number) => padding.left + ((t - minTime) / timeSpan) * chartW;
  const yFor = (hr: number) => padding.top + chartH - ((hr - hrMin) / hrRange) * chartH;

  // Build polyline points
  const linePoints = decimated.time.map((t, i) => `${xFor(t)},${yFor(decimated.hr[i])}`).join(' ');

  // HR axis ticks (5 evenly)
  const hrTicks: number[] = [];
  const tickStep = Math.ceil(hrRange / 4 / 5) * 5; // round to 5
  for (let v = Math.ceil(hrMin / tickStep) * tickStep; v <= hrMax; v += tickStep) {
    hrTicks.push(v);
  }

  // Time axis ticks (4-5)
  const timeTicks: number[] = [];
  const numTicks = 5;
  for (let i = 0; i <= numTicks; i++) {
    timeTicks.push(minTime + (timeSpan * i) / numTicks);
  }

  // Zone bands — draw rectangles only for zones overlapping HR range
  const zoneBands: { key: ZoneKey; y: number; height: number; color: string }[] = [];
  if (hrZones) {
    for (const key of ZONE_KEYS) {
      const z = hrZones[key];
      const top = Math.min(z.to, hrMax);
      const bot = Math.max(z.from, hrMin);
      if (top <= bot) continue;
      const yTop = yFor(top);
      const yBot = yFor(bot);
      zoneBands.push({
        key,
        y: yTop,
        height: yBot - yTop,
        color: ZONE_COLORS[key]
      });
    }
  }

  return (
    <div className="hr-chart-container">
      <div className="hr-chart-header">
        <h3 className="section-title">❤️ {showChart ? t('workout.hrChart') : t('workout.timeInZones')}</h3>
      </div>

      {hrStats && (
        <div className="hr-chart-stats">
          <div className="hr-chart-stat">
            <span className="hr-chart-stat-label">{t('workout.hrMin')}</span>
            <span className="hr-chart-stat-value">{hrStats.min}</span>
          </div>
          <div className="hr-chart-stat">
            <span className="hr-chart-stat-label">{t('workout.hrAvg')}</span>
            <span className="hr-chart-stat-value hr-chart-stat-avg">{hrStats.avg}</span>
          </div>
          <div className="hr-chart-stat">
            <span className="hr-chart-stat-label">{t('workout.hrMax')}</span>
            <span className="hr-chart-stat-value">{hrStats.max}</span>
          </div>
        </div>
      )}

      {showChart && (
      <svg
        className="hr-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t('workout.hrChart')}
      >
        {/* Zone bands as background */}
        {zoneBands.map(b => (
          <rect
            key={b.key}
            x={padding.left}
            y={b.y}
            width={chartW}
            height={b.height}
            fill={b.color}
            opacity={0.13}
          />
        ))}

        {/* Y grid + labels */}
        {hrTicks.map(v => (
          <g key={`y-${v}`}>
            <line
              x1={padding.left}
              x2={W - padding.right}
              y1={yFor(v)}
              y2={yFor(v)}
              stroke="var(--color-border)"
              strokeDasharray="2,3"
              opacity={0.5}
            />
            <text
              x={padding.left - 8}
              y={yFor(v) + 4}
              textAnchor="end"
              fontSize="13"
              fill="var(--color-text-secondary)"
            >
              {v}
            </text>
          </g>
        ))}

        {/* X labels */}
        {timeTicks.map((tm, i) => (
          <text
            key={`x-${i}`}
            x={xFor(tm)}
            y={H - padding.bottom + 20}
            textAnchor={i === 0 ? 'start' : i === timeTicks.length - 1 ? 'end' : 'middle'}
            fontSize="13"
            fill="var(--color-text-secondary)"
          >
            {fmtTime(tm)}
          </text>
        ))}

        {/* HR polyline */}
        <polyline
          points={linePoints}
          fill="none"
          stroke="#ef4444"
          strokeWidth="2.2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      )}

      {/* Time-in-zones bar */}
      {hrZones && totalZoneSec > 0 && (
        <div className="hr-zones-summary">
          <div className="hr-zones-bar">
            {ZONE_KEYS.map(key => {
              const sec = zoneSeconds[key];
              const pct = (sec / totalZoneSec) * 100;
              if (pct < 0.5) return null;
              return (
                <div
                  key={key}
                  className="hr-zones-bar-segment"
                  style={{ width: `${pct}%`, backgroundColor: ZONE_COLORS[key] }}
                  title={`${t(`paceZones.${key}`)}: ${pct.toFixed(0)}% (${fmtTime(sec)})`}
                />
              );
            })}
          </div>
          <div className="hr-zones-legend">
            {ZONE_KEYS.map(key => {
              const sec = zoneSeconds[key];
              const pct = (sec / totalZoneSec) * 100;
              if (sec === 0) return null;
              return (
                <div key={key} className="hr-zones-legend-item">
                  <span className="hr-zones-legend-dot" style={{ backgroundColor: ZONE_COLORS[key] }} />
                  <span className="hr-zones-legend-label">{t(`paceZones.${key}`)}</span>
                  <span className="hr-zones-legend-value">{pct.toFixed(0)}%</span>
                  <span className="hr-zones-legend-time">{fmtTime(sec)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default HrChart;
