import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import { HttpError } from '../lib/http';
import { env } from '../config/env';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.originalUrl}` });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(422).json({
      error: 'Datos inválidos',
      issues: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }

  if (err instanceof MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'La imagen supera el tamaño máximo de 10 MB'
        : `Error al subir el archivo: ${err.message}`;
    res.status(400).json({ error: message });
    return;
  }

  const message = err instanceof Error ? err.message : 'Error interno del servidor';
  console.error('[error]', err);
  res.status(500).json({ error: env.isProd ? 'Error interno del servidor' : message });
};
