import type { RequestHandler } from 'express';
import { descifrarPayload } from '../lib/rsaCrypto';

/**
 * =====================================================================
 *  Middleware: decryptPayload
 * =====================================================================
 * Intercepta peticiones HTTP con cuerpo { data: "..." } cifrado con RSA-OAEP / SHA-256.
 * Ejecuta descifrarPayload(req.body.data) y reensambla req.body de forma transparente
 * con los datos en texto plano ({ email, password, ... }), permitiendo que los
 * controladores reciban los parámetros originales sin modificar su lógica interna.
 */
export const decryptPayload: RequestHandler = (req, res, next) => {
  try {
    if (
      req.body &&
      typeof req.body === 'object' &&
      typeof req.body.data === 'string' &&
      req.body.data.trim().length > 0
    ) {
      const decrypted = descifrarPayload<Record<string, any>>(req.body.data);
      if (decrypted && typeof decrypted === 'object') {
        req.body = decrypted;
      }
    }
    next();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error al descifrar el payload';
    return res.status(400).json({ error: message });
  }
};
