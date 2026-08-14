import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error';
import { apiRouter } from './routes';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: (origin, callback) => {
        // Permitir solicitudes sin origin (como curl, mobile o postman)
        if (!origin) return callback(null, true);

        // Permitir orígenes explícitos configurados en CORS_ORIGIN
        if (env.corsOrigin.includes(origin)) return callback(null, true);

        // Permitir cualquier localhost o 127.0.0.1 en cualquier puerto
        if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }

        // Permitir despliegues en Vercel
        if (/^https:\/\/.*\.vercel\.app$/.test(origin)) {
          return callback(null, true);
        }

        callback(null, false);
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  if (!env.isProd) app.use(morgan('dev'));

  // Imágenes cuando STORAGE_DRIVER=local
  if (env.storage.driver === 'local') {
    app.use('/uploads', express.static(env.storage.localDir, { maxAge: '7d' }));
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'lavadero-api', env: env.nodeEnv, time: new Date().toISOString() });
  });

  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
