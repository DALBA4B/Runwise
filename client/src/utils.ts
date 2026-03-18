export function formatPace(secPerKm: number): string {
  if (!secPerKm || secPerKm <= 0) return '—';
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export function formatDistance(meters: number): string {
  if (!meters) return '0 км';
  const km = meters / 1000;
  return km >= 10 ? `${km.toFixed(1)} км` : `${km.toFixed(2)} км`;
}

export function formatTime(seconds: number): string {
  if (!seconds) return '0 мин';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}ч ${m}м`;
  return `${m} мин`;
}

export function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: undefined
  });
}

export function formatDateFull(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

export function getTypeBadge(type: string): string {
  switch (type) {
    case 'easy': return '🏃';
    case 'tempo': return '⚡';
    case 'long': return '🏔️';
    case 'interval': return '💨';
    case 'rest': return '😴';
    default: return '🏃';
  }
}

export function getTypeLabel(type: string): string {
  switch (type) {
    case 'easy': return 'Лёгкая';
    case 'tempo': return 'Темповая';
    case 'long': return 'Длинная';
    case 'interval': return 'Интервалы';
    case 'rest': return 'Отдых';
    default: return 'Другое';
  }
}

export function getMonthName(month: number): string {
  const months = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
  ];
  return months[month - 1] || '';
}
