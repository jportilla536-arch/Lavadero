import type { Request } from 'express';
import type { z, ZodTypeAny } from 'zod';
import { decryptDeep } from '../lib/security';

/**
 * Valida el body de la petición.
 * Descifra automáticamente cualquier campo protegido con RSA-2048 o César antes de validar.
 * Devuelve el tipo de SALIDA del esquema (con `.default()` ya aplicado).
 */
export const parseBody = <S extends ZodTypeAny>(schema: S, req: Request): z.output<S> => {
  if (req.body && typeof req.body === 'object') {
    req.body = decryptDeep(req.body);
  }
  return schema.parse(req.body);
};

/** Valida y normaliza los query params. */
export const parseQuery = <S extends ZodTypeAny>(schema: S, req: Request): z.output<S> =>
  schema.parse(req.query);
