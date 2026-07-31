/**
 * Une las migraciones de supabase/migrations en un solo archivo listo para
 * pegar en el editor SQL de Supabase.
 *
 *   pnpm db:sql
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), '..', 'supabase', 'migrations');
const OUTPUT = path.resolve(process.cwd(), '..', 'supabase', 'schema.sql');

async function main() {
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

  if (files.length === 0) {
    console.error('[db:sql] no hay archivos .sql en supabase/migrations');
    process.exitCode = 1;
    return;
  }

  const parts: string[] = [
    '-- =====================================================================',
    '--  Lavadero SaaS · esquema completo',
    '--  Generado con "pnpm db:sql". Pega este archivo en:',
    '--  Supabase Dashboard > SQL Editor > New query > Run',
    '-- =====================================================================',
    '',
  ];

  for (const file of files) {
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    parts.push(`-- ─── ${file} ───────────────────────────────────────────────`, '', sql.trim(), '');
  }

  await fs.writeFile(OUTPUT, parts.join('\n'), 'utf8');

  console.log('\n[db:sql] archivo generado:');
  console.log(`         ${OUTPUT}\n`);
  console.log('  Pasos:');
  console.log('  1. Abre tu proyecto en Supabase > SQL Editor > New query');
  console.log('  2. Pega el contenido de supabase/schema.sql');
  console.log('  3. Pulsa Run');
  console.log('  4. Vuelve aquí y ejecuta: pnpm db:seed\n');
  console.log(`  Archivos incluidos (${files.length}):`);
  for (const file of files) console.log(`   · ${file}`);
  console.log('');
}

main().catch((error) => {
  console.error('[db:sql]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
