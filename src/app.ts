import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { sb } from './lib/supabase';
import { errorHandler, notFoundHandler } from './middleware/error';
import { apiRouter } from './routes';
import { getSecurityFingerprint, decryptDeep } from './lib/security';

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

  // Middleware de Descifrado Transparente de Payloads (RSA-2048 + César)
  app.use((req, _res, next) => {
    if (req.body && typeof req.body === 'object') {
      req.body = decryptDeep(req.body);
    }
    next();
  });
  if (!env.isProd) app.use(morgan('dev'));

  // Imágenes cuando STORAGE_DRIVER=local
  if (env.storage.driver === 'local') {
    app.use('/uploads', express.static(env.storage.localDir, { maxAge: '7d' }));
  }

  app.get('/health', async (_req, res) => {
    let dbStatus = 'ok';
    try {
      if (env.supabase.url && env.supabase.serviceRoleKey) {
        const { error } = await sb().from('businesses').select('id', { head: true, count: 'exact' });
        if (error) {
          dbStatus = `warning: ${error.message}`;
        }
      }
    } catch (err: unknown) {
      dbStatus = `error: ${err instanceof Error ? err.message : String(err)}`;
    }

    res.json({
      ok: true,
      service: 'lavadero-api',
      env: env.nodeEnv,
      database: dbStatus,
      time: new Date().toISOString(),
    });
  });

  // Middleware de Seguridad de Información (RSA-2048 Asimétrico + César)
  app.use((_req, res, next) => {
    res.setHeader('X-Information-Security', 'RSA-2048-Asymmetric + Caesar-Cipher');
    res.setHeader('X-Security-Policy', 'RSA-OAEP-SHA256+Caesar-Stealth');
    res.setHeader('X-RSA-Key-Fingerprint', getSecurityFingerprint());
    next();
  });

  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
