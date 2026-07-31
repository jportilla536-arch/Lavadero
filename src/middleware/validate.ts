import type { Request } from 'express';
import type { z, ZodTypeAny } from 'zod';

/**
 * Valida el body de la petición.
 * Devuelve el tipo de SALIDA del esquema (con `.default()` ya aplicado).
 */
export const parseBody = <S extends ZodTypeAny>(schema: S, req: Request): z.output<S> =>
  schema.parse(req.body);

/** Valida y normaliza los query params. */
export const parseQuery = <S extends ZodTypeAny>(schema: S, req: Request): z.output<S> =>
  schema.parse(req.query);
