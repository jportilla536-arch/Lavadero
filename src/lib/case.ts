const toCamel = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !Buffer.isBuffer(value);

/**
 * Convierte recursivamente las claves snake_case de Postgres a camelCase
 * para exponerlas en la API.
 */
export function camelize<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((item) => camelize(item)) as unknown as T;
  if (!isPlainObject(value)) return value as T;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[toCamel(key)] = camelize(val);
  }
  return out as T;
}

export const camelizeAll = <T>(rows: unknown[]): T[] => rows.map((row) => camelize<T>(row));
