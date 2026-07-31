/**
 * Elimina los datos generados por la prueba de humo y muestra el conteo real
 * de cada tabla. Útil para dejar la base limpia antes de empezar a operar.
 *
 *   pnpm db:cleanup
 */
import { sb } from '../lib/supabase';

const TABLES = [
  'orders',
  'customers',
  'vehicles',
  'services',
  'employees',
  'promotions',
  'payments',
  'expenses',
  'users',
] as const;

async function main() {
  console.log('\nLimpieza de datos de prueba');

  // Las órdenes primero: las FK de cliente y vehículo son RESTRICT.
  const { data: orders } = await sb()
    .from('orders')
    .delete()
    .like('number', 'ORD-%')
    .select('number');
  console.log(`  órdenes eliminadas: ${orders?.length ?? 0}`);

  const { data: customers } = await sb()
    .from('customers')
    .delete()
    .eq('first_name', 'Cliente')
    .eq('last_name', 'Prueba')
    .select('id');
  console.log(`  clientes eliminados: ${customers?.length ?? 0}`);

  const { data: services } = await sb()
    .from('services')
    .delete()
    .eq('name', 'Lavado de prueba')
    .select('id');
  console.log(`  servicios eliminados: ${services?.length ?? 0}`);

  const { data: employees } = await sb()
    .from('employees')
    .delete()
    .eq('name', 'Empleado Prueba')
    .select('id');
  console.log(`  empleados eliminados: ${employees?.length ?? 0}`);

  await sb().from('counters').delete().neq('key', '');

  console.log('\nConteo final por tabla');
  for (const table of TABLES) {
    const { count, error } = await sb()
      .from(table)
      .select('*', { count: 'exact', head: true });
    console.log(`  ${table.padEnd(12)} ${error ? 'error' : count}`);
  }
  console.log('');
}

main().catch((error) => {
  console.error('[cleanup]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
