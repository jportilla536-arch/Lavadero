import { createApp } from './app';
import { env } from './config/env';
import { sb } from './lib/supabase';
import { ensureBucket } from './storage';

/** Comprueba que la API de Supabase responde y que el esquema existe. */
async function checkSupabase() {
  if (!env.supabase.url || !env.supabase.serviceRoleKey) {
    console.error('[supabase] falta configuración. Revisa backend/.env');
    return;
  }

  const { error } = await sb().from('businesses').select('id', { head: true, count: 'exact' });

  if (!error) {
    console.log(`[supabase] conectado al proyecto "${env.supabase.projectRef}"`);
    return;
  }

  if (error.code === 'PGRST205' || error.code === '42P01') {
    console.error('[supabase] las tablas no existen todavía.');
    console.error('           Ejecuta "pnpm db:sql" y pega el SQL en el editor de Supabase.');
    return;
  }

  console.error(`[supabase] ${error.message}`);
}

async function main() {
  const app = createApp();

  await checkSupabase();
  await ensureBucket();

  const server = app.listen(env.port, () => {
    console.log(`[api] escuchando en http://localhost:${env.port}`);
    console.log(`[api] storage: ${env.storage.driver}`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n[api] ${signal} recibido, cerrando...`);
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
