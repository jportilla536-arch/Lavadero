export type RangePreset = 'today' | 'week' | 'month' | 'year' | 'custom';

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/**
 * Resuelve un rango de fechas a partir de un preset o de fechas personalizadas.
 * La semana empieza el lunes.
 */
export function resolveRange(input: {
  preset?: string;
  from?: string;
  to?: string;
}): { from: Date; to: Date; preset: RangePreset } {
  const preset = (input.preset ?? 'today') as RangePreset;
  const now = new Date();

  if (preset === 'custom' || (!input.preset && (input.from || input.to))) {
    const from = input.from ? startOfDay(new Date(input.from)) : startOfDay(now);
    const to = input.to ? endOfDay(new Date(input.to)) : endOfDay(now);
    return { from, to, preset: 'custom' };
  }

  switch (preset) {
    case 'week': {
      const day = now.getDay(); // 0 = domingo
      const diff = day === 0 ? 6 : day - 1;
      const monday = new Date(now);
      monday.setDate(now.getDate() - diff);
      return { from: startOfDay(monday), to: endOfDay(now), preset };
    }
    case 'month': {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: startOfDay(first), to: endOfDay(now), preset };
    }
    case 'year': {
      const first = new Date(now.getFullYear(), 0, 1);
      return { from: startOfDay(first), to: endOfDay(now), preset };
    }
    default:
      return { from: startOfDay(now), to: endOfDay(now), preset: 'today' };
  }
}

export const dayBounds = (d: Date = new Date()) => ({ from: startOfDay(d), to: endOfDay(d) });

export function monthBounds(d: Date = new Date()) {
  return {
    from: startOfDay(new Date(d.getFullYear(), d.getMonth(), 1)),
    to: endOfDay(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
  };
}

/** Clave YYYYMMDD usada para la numeración diaria de órdenes. */
export function dateKey(d: Date = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
