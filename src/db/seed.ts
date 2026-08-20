/**
 * Seed inicial:
 * 1. Crea el negocio inicial si no existe.
 * 2. Crea el usuario SUPER_ADMIN para gestionar todos los establecimientos.
 * 3. Crea el usuario ADMIN asignado al primer negocio.
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

  // 1. Asegurar negocio por defecto
  let businessId: string | null = null;
  const { data: businesses, error: busError } = await sb()
    .from('businesses')
    .select('id, name')
    .order('created_at', { ascending: true })
    .limit(1);

  if (busError) {
    console.error(`[seed] Error al consultar businesses: ${busError.message}`);
  }

  if (businesses && businesses[0]) {
    businessId = businesses[0].id;
    console.log(`[seed] · Establecimiento existente: ${businesses[0].name} (${businessId})`);
  } else {
    const { data: createdBus, error: createBusErr } = await sb()
      .from('businesses')
      .insert({
        name: 'Lavadero Central',
        legal_name: 'Lavadero Central S.A.S.',
        phone: '3001234567',
        address: 'Calle Principal # 123',
        currency: 'COP',
        currency_sign: '$',
        active: true,
      })
      .select('id, name');

    if (createBusErr) {
      console.error(`[seed] Error creando establecimiento por defecto: ${createBusErr.message}`);
    } else if (createdBus && createdBus[0]) {
      businessId = createdBus[0].id;
      console.log(`[seed] ✓ Establecimiento inicial creado: ${createdBus[0].name}`);
    }
  }

  // 2. Crear o actualizar Super Admin con credenciales reales
  const superAdminEmail = 'juliandrosalesp@gmail.com';
  const superAdminPassword = '1193051330 Jr';
  const superAdminHash = await bcrypt.hash(superAdminPassword, 10);

  const { data: existingSuper } = await sb()
    .from('users')
    .select('id')
    .eq('email', superAdminEmail)
    .limit(1);

  if (!existingSuper || existingSuper.length === 0) {
    const { error: superErr } = await sb().from('users').insert({
      name: 'Julian Rosales',
      email: superAdminEmail,
      password_hash: superAdminHash,
      role: 'SUPER_ADMIN',
      business_id: null,
      active: true,
    });

    if (superErr) {
      console.error(`[seed] Error creando Super Admin: ${superErr.message}`);
    } else {
      console.log('\n[seed] ✓ Usuario SUPER_ADMIN creado:');
      console.log(`       Correo:     ${superAdminEmail}`);
      console.log('       Contraseña: 1193051330 Jr');
    }
  } else {
    // Actualizar hash en caso de que ya existiera con placeholder de la migración SQL
    const { error: updErr } = await sb()
      .from('users')
      .update({ password_hash: superAdminHash, role: 'SUPER_ADMIN', business_id: null, name: 'Julian Rosales' })
      .eq('email', superAdminEmail);

    if (updErr) {
      console.error(`[seed] Error actualizando Super Admin: ${updErr.message}`);
    } else {
      console.log(`[seed] · Super Admin (${superAdminEmail}) actualizado con contraseña correcta.`);
    }
  }

  // 3. Crear Admin del lavadero inicial
  const adminEmail = env.seed.adminEmail.toLowerCase();
  const { data: existingAdmin } = await sb()
    .from('users')
    .select('id')
    .eq('email', adminEmail)
    .limit(1);

  if (!existingAdmin || existingAdmin.length === 0) {
    const { error: adminErr } = await sb().from('users').insert({
      name: env.seed.adminName,
      email: adminEmail,
      password_hash: await bcrypt.hash(env.seed.adminPassword, 10),
      role: 'ADMIN',
      business_id: businessId,
      active: true,
    });

    if (adminErr) {
      console.error(`[seed] Error creando Admin: ${adminErr.message}`);
    } else {
      console.log('\n[seed] ✓ Usuario ADMINISTRADOR DE LAVADERO creado:');
      console.log(`       Correo:     ${adminEmail}`);
      console.log(`       Contraseña: ${env.seed.adminPassword}`);
    }
  } else {
    console.log(`[seed] · El Administrador (${adminEmail}) ya existe.`);
  }

  console.log('\n[seed] Listo para operar. Puedes iniciar sesión como Super Admin o Admin de Lavadero.');
}

main().catch((error) => {
  console.error('[seed]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
