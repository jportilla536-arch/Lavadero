import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }

  static badRequest(message = 'Solicitud inválida', details?: unknown) {
    return new HttpError(400, message, details);
  }
  static unauthorized(message = 'No autenticado') {
    return new HttpError(401, message);
  }
  static forbidden(message = 'No autorizado') {
    return new HttpError(403, message);
  }
  static notFound(message = 'Recurso no encontrado') {
    return new HttpError(404, message);
  }
  static conflict(message = 'Conflicto con el estado actual') {
    return new HttpError(409, message);
  }
}

/** Envuelve handlers async para propagar errores al middleware de errores. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
