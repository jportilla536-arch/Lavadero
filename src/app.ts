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
      origin: env.corsOrigin.length > 0 ? env.corsOrigin : true,
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
