/**
 * Invoca cada función RPC con argumentos válidos para detectar versiones
 * desactualizadas (por ejemplo, funciones que aún referencian columnas
 * renombradas).
 *
 *   pnpm db:probe
 */
import { sb } from '../lib/supabase';

const today = new Date();
const from = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
const to = new Date().toISOString();

const PROBES: { fn: string; args: Record<string, unknown> }[] = [
  { fn: 'list_employees', args: { p_only_active: false, p_working_only: false } },
  { fn: 'search_customers', args: { p_query: null, p_limit: 1, p_offset: 0 } },
  { fn: 'search_orders', args: { p_limit: 1, p_offset: 0 } },
  { fn: 'report_dashboard', args: {} },
  { fn: 'report_sales', args: { p_from: from, p_to: to } },
  { fn: 'report_services', args: { p_from: from, p_to: to } },
  { fn: 'report_customers', args: { p_from: from, p_to: to } },
  { fn: 'report_tips', args: { p_from: from, p_to: to } },
  { fn: 'report_payment_methods', args: { p_from: from, p_to: to } },
  { fn: 'report_employees', args: { p_from: from, p_to: to } },
  { fn: 'report_cash', args: { p_from: from, p_to: to } },
  { fn: 'format_cop', args: { amount: 110000 } },
];

async function main() {
  console.log('\n\x1b[1mVerificación de funciones SQL\x1b[0m\n');

  const broken: string[] = [];

  for (const probe of PROBES) {
    const { error } = await sb().rpc(probe.fn, probe.args);

    if (!error) {
      console.log(`  \x1b[32m✓\x1b[0m ${probe.fn}`);
      continue;
    }

    broken.push(probe.fn);
    console.log(`  \x1b[31m✗\x1b[0m ${probe.fn}`);
    console.log(`    \x1b[90m${error.code ?? ''} ${error.message}\x1b[0m`);
  }

  if (broken.length === 0) {
    console.log('\n  Todas las funciones responden correctamente.\n');
    return;
  }

  console.log(`\n  ${broken.length} función(es) con problemas.`);
  console.log('  Ejecuta "pnpm db:sql" y vuelve a pegar supabase/schema.sql');
  console.log('  en el editor SQL de Supabase (las funciones usan');
  console.log('  "create or replace", así que se sobrescriben sin riesgo).\n');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
