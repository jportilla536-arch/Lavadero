/**
 * Diagnóstico de configuración: valida las credenciales de Supabase,
 * el esquema, las funciones RPC y el bucket de Storage.
 *
 *   pnpm db:check
 */
import { env } from '../config/env';
import { sb } from '../lib/supabase';

const ok = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg: string) => console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
const info = (msg: string) => console.log(`    \x1b[90m${msg}\x1b[0m`);

const TABLES = [
  'businesses',
  'users',
  'employees',
  'customers',
  'vehicles',
  'services',
  'promotions',
  'orders',
  'order_items',
  'order_evidences',
  'order_events',
  'payments',
  'expenses',
] as const;

const FUNCTIONS = [
  'order_detail',
  'search_orders',
  'create_order',
  'checkout_order',
  'search_customers',
  'create_customer',
  'list_employees',
  'report_dashboard',
  'report_cash',
] as const;

function checkCredentials(): boolean {
  console.log('\nCredenciales de Supabase');

  if (!env.supabase.url) {
    bad('Falta SUPABASE_URL');
    info('Copia backend/.env.example a backend/.env y rellena los valores');
    return false;
  }
  if (!env.supabase.serviceRoleKey) {
    bad('Falta SUPABASE_SERVICE_ROLE_KEY');
    info('Dashboard > Project Settings > API > service_role');
    return false;
  }

  ok(`proyecto: ${env.supabase.projectRef}`);
  ok(`url: ${env.supabase.url}`);
  ok(`service role key: ${env.supabase.serviceRoleKey.slice(0, 12)}…`);
  return true;
}

async function checkSchema() {
  console.log('\nTablas');
  const missing: string[] = [];

  for (const table of TABLES) {
    const { error } = await sb().from(table).select('*', { head: true, count: 'exact' });
    if (error) {
      missing.push(table);
      continue;
    }
  }

  if (missing.length === 0) {
    ok(`las ${TABLES.length} tablas existen`);
    return true;
  }

  bad(`faltan ${missing.length} tabla(s): ${missing.join(', ')}`);
  info('Ejecuta "pnpm db:sql" y pega supabase/schema.sql en el editor SQL de Supabase');
  return false;
}

/**
 * Lee el catálogo OpenAPI de PostgREST. Es la forma fiable de saber qué
 * funciones existen: invocarlas sin argumentos da el mismo error que si
 * faltaran.
 */
async function checkFunctions() {
  console.log('\nFunciones SQL');

  try {
    const response = await fetch(`${env.supabase.url}/rest/v1/`, {
      headers: {
        apikey: env.supabase.serviceRoleKey,
        Authorization: `Bearer ${env.supabase.serviceRoleKey}`,
      },
    });

    if (!response.ok) {
      bad(`no se pudo leer el catálogo (HTTP ${response.status})`);
      return;
    }

    const schema = (await response.json()) as { paths?: Record<string, unknown> };
    const available = new Set(
      Object.keys(schema.paths ?? {})
        .filter((path) => path.startsWith('/rpc/'))
        .map((path) => path.replace('/rpc/', '')),
    );

    const missing = FUNCTIONS.filter((fn) => !available.has(fn));

    if (missing.length === 0) {
      ok(`${available.size} funciones RPC instaladas`);
      return;
    }

    bad(`faltan ${missing.length} función(es): ${missing.join(', ')}`);
    info('Ejecuta "pnpm db:sql" y pega supabase/schema.sql en el editor SQL');
  } catch (error) {
    bad(error instanceof Error ? error.message : String(error));
  }
}

async function checkAdmin() {
  console.log('\nUsuarios');
  const { data, error } = await sb().from('users').select('email, role');

  if (error) {
    bad(error.message);
    return;
  }
  if (!data || data.length === 0) {
    bad('No hay usuarios. Ejecuta: pnpm db:seed');
    return;
  }

  ok(`${data.length} usuario(s) registrado(s)`);
  for (const user of data.slice(0, 5)) info(`${user.email} · ${user.role}`);
}

async function checkStorage() {
  console.log('\nAlmacenamiento de imágenes');

  if (env.storage.driver === 'local') {
    ok(`modo local: ${env.storage.localDir}`);
    return;
  }

  const { data, error } = await sb().storage.getBucket(env.storage.bucket);

  if (error) {
    bad(`bucket "${env.storage.bucket}": ${error.message}`);
    info('Se creará automáticamente al arrancar el backend (pnpm dev)');
    return;
  }

  ok(`bucket "${data.name}" listo (público: ${data.public})`);
}

async function main() {
  console.log('\n\x1b[1mDiagnóstico de configuración · Lavadero\x1b[0m');

  if (checkCredentials()) {
    const schemaOk = await checkSchema();
    if (schemaOk) {
      await checkFunctions();
      await checkAdmin();
    }
    await checkStorage();
  }

  console.log('\nOtros valores');
  ok(`JWT_SECRET: ${env.jwtSecret.length} caracteres`);
  ok(`CORS permitido para: ${env.corsOrigin.join(', ')}`);
  ok(`API en el puerto ${env.port}`);
  console.log('');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
