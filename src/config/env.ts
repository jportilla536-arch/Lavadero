import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT ?? 4000),
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4000}`,
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  /** Único punto de acceso a los datos: la API de Supabase. */
  supabase: {
    url: supabaseUrl,
    serviceRoleKey,
    /** Referencia del proyecto, deducida de la URL. */
    projectRef: supabaseUrl.replace(/^https?:\/\//, '').split('.')[0] ?? '',
  },

  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',

  storage: {
    driver: (process.env.STORAGE_DRIVER ?? 'supabase') as 'local' | 'supabase',
    bucket: process.env.SUPABASE_BUCKET ?? 'lavadero',
    localDir: path.resolve(process.cwd(), 'uploads'),
  },

  seed: {
    adminName: process.env.SEED_ADMIN_NAME ?? 'Administrador',
    adminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@lavadero.com',
    adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'admin123',
  },
};

if (!env.supabase.url || !env.supabase.serviceRoleKey) {
  console.warn(
    '[env] Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY. Copia backend/.env.example a backend/.env',
  );
}
