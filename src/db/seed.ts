/**
 * Seed mínimo: crea únicamente el usuario administrador (dueño del lavadero)
 * para poder iniciar sesión por primera vez.
 *
 * No se cargan servicios, promociones, empleados ni datos de ejemplo:
 * el dueño configura todo su catálogo desde la plataforma.
 *
 *   pnpm db:seed
 */
import bcrypt from 'bcryptjs';
import { env } from '../config/env';
import { sb } from '../lib/supabase';

async function main() {
  if (!env.supabase.url || !env.supabase.serviceRoleKey) {
    console.error('[seed] Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en backend/.env');
    process.exit(1);
  }

  const email = env.seed.adminEmail.toLowerCase();

  const { data: existing, error: findError } = await sb()
    .from('users')
    .select('id')
    .eq('email', email)
    .limit(1);

  if (findError) {
    if (findError.code === 'PGRST205' || findError.code === '42P01') {
      console.error('[seed] Las tablas no existen todavía.');
      console.error('       Ejecuta "pnpm db:sql" y pega el SQL en el editor de Supabase.');
      process.exit(1);
    }
    console.error(`[seed] ${findError.message}`);
    process.exit(1);
  }

  if (existing && existing.length > 0) {
    console.log(`[seed] · el usuario ${email} ya existe, no se hicieron cambios`);
    return;
  }

  const { error } = await sb().from('users').insert({
    name: env.seed.adminName,
    email,
    password_hash: await bcrypt.hash(env.seed.adminPassword, 10),
    role: 'ADMIN',
  });

  if (error) {
    console.error(`[seed] ${error.message}`);
    process.exit(1);
  }

  console.log('[seed] ✓ usuario administrador creado');
  console.log(`       correo:     ${email}`);
  console.log(`       contraseña: ${env.seed.adminPassword}`);
  console.log('\n       Cambia la contraseña al iniciar sesión.');
  console.log('       Los servicios, promociones y empleados se crean desde la plataforma.');
}

main().catch((error) => {
  console.error('[seed]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
