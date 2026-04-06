import i18n from './i18n';

const LOCALE_MAP: Record<string, string> = {
  ru: 'ru-RU',
  uk: 'uk-UA',
  en: 'en-US',
};

function getLocale(): string {
  return LOCALE_MAP[i18n.language] || 'ru-RU';
}

export function formatPace(secPerKm: number): string {
  if (!secPerKm || secPerKm <= 0) return '—';
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export function formatDistance(meters: number): string {
  if (!meters) return `0 ${i18n.t('units.km')}`;
  const km = meters / 1000;
  return km >= 10
    ? `${km.toFixed(1)} ${i18n.t('units.km')}`
    : `${km.toFixed(2)} ${i18n.t('units.km')}`;
}

export function formatTime(seconds: number): string {
  if (!seconds) return `0 ${i18n.t('units.min')}`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}${i18n.t('units.h')} ${m}${i18n.t('units.m')}`;
  return `${m} ${i18n.t('units.min')}`;
}

export function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'short',
    year: undefined
  });
}

export function formatDateFull(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

export function getTypeBadge(type: string): string {
  switch (type) {
    case 'easy': return '🏃';
    case 'recovery': return '🧘';
    case 'tempo': return '⚡';
    case 'long': return '🏔️';
    case 'interval': return '💨';
    case 'fartlek': return '🎯';
    case 'strength': return '💪';
    case 'race': return '🏁';
    case 'rest': return '😴';
    default: return '🏃';
  }
}

export function getTypeLabel(type: string): string {
  return i18n.t(`workoutTypes.${type}`, { defaultValue: i18n.t('workoutTypes.other') });
}

export function getMonthName(month: number): string {
  return i18n.t(`months.${month}`, { defaultValue: '' });
}
