#!/usr/bin/env node

/**
 * ==============================================================================
 * DetailOps · Keep-Alive Script (Render & Supabase)
 * ==============================================================================
 *
 * Mantiene activo el backend en Render (evitando el estado de suspensión tras 15 min)
 * y la base de datos PostgreSQL en Supabase (evitando la pausa por inactividad).
 *
 * Opciones de ejecución:
 *   node scripts/keep-alive.mjs                  (Ciclo continuo cada 14 minutos)
 *   node scripts/keep-alive.mjs --interval 10    (Ciclo cada 10 minutos)
 *   node scripts/keep-alive.mjs --once           (Ejecutar una sola vez y salir)
 *   node scripts/keep-alive.mjs --url <URL>      (Especificar URL personalizada)
 *   node scripts/keep-alive.mjs --help           (Mostrar ayuda)
 *
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Carga de variables de entorno sin dependencias externas
// -----------------------------------------------------------------------------
function loadEnv() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    path.resolve(process.cwd(), 'backend/.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(currentDir, '../backend/.env'),
    path.resolve(currentDir, '../.env'),
    path.resolve(currentDir, '.env'),
  ];

  for (const envPath of candidatePaths) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const match = trimmed.match(/^([^=]+)=(.*)$/);
          if (match) {
            const key = match[1].trim();
            let value = match[2].trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            if (!process.env[key]) {
              process.env[key] = value;
            }
          }
        }
      } catch {
        // Ignorar si no se puede leer
      }
    }
  }
}

loadEnv();

// -----------------------------------------------------------------------------
// Configuración por defecto
// -----------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
\x1b[1m\x1b[36mDetailOps · Keep-Alive Pinger\x1b[0m
Mantiene activos el backend en Render y la base de datos de Supabase.

\x1b[1mUso:\x1b[0m
  node keep-alive.mjs [opciones]

\x1b[1mOpciones:\x1b[0m
  \x1b[33m--interval, -i <min>\x1b[0m   Minutos entre cada ping (por defecto: 14)
  \x1b[33m--once\x1b[0m                Ejecuta un solo ping y sale (código 0 si éxito, 1 si error)
  \x1b[33m--url <url>\x1b[0m           URL del endpoint health del backend
  \x1b[33m--db-only\x1b[0m             Solo consultar Supabase directamente
  \x1b[33m--backend-only\x1b[0m        Solo consultar el backend
  \x1b[33m--help, -h\x1b[0m            Muestra esta ayuda
`);
  process.exit(0);
}

// Parámetros de CLI
function getArgValue(flag) {
  const index = args.indexOf(flag);
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return null;
}

const intervalMinStr = getArgValue('--interval') || getArgValue('-i') || process.env.INTERVAL_MINUTES || '14';
const intervalMinutes = Math.max(1, parseInt(intervalMinStr, 10) || 14);
const isOnce = args.includes('--once');
const dbOnly = args.includes('--db-only');
const backendOnly = args.includes('--backend-only');

// URLs
const defaultBackendUrl = 'https://lavadero-s88q.onrender.com/health';
const customUrl = getArgValue('--url') || process.env.BACKEND_URL;
const backendUrl = customUrl ? (customUrl.endsWith('/health') ? customUrl : `${customUrl.replace(/\/$/, '')}/health`) : defaultBackendUrl;

const supabaseUrl = process.env.SUPABASE_URL || 'https://vfvprbrnlfbonjxemfmg.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

// -----------------------------------------------------------------------------
// Métricas y estado
// -----------------------------------------------------------------------------
let pingCount = 0;
let successCount = 0;
let failCount = 0;
const startTime = Date.now();

// Formato de hora amigable
function getTimestamp() {
  const now = new Date();
  return now.toLocaleString('es-CO', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// Colores ANSI
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

// -----------------------------------------------------------------------------
// Petición al Backend
// -----------------------------------------------------------------------------
async function pingBackend() {
  const start = performance.now();
  try {
    // Timeout de 65 segundos (útil si Render está despertando de cold start)
    const res = await fetch(backendUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'DetailOps-KeepAlive/1.0',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(65000),
    });

    const duration = Math.round(performance.now() - start);
    let data = null;
    try {
      data = await res.json();
    } catch {
      // Ignorar si no es JSON
    }

    if (res.ok) {
      const dbInfo = data?.database ? ` | DB: ${c.cyan}${data.database}${c.reset}` : '';
      return {
        ok: true,
        status: res.status,
        duration,
        message: `Backend OK (${res.status}) en ${duration}ms${dbInfo}`,
      };
    } else {
      return {
        ok: false,
        status: res.status,
        duration,
        message: `Backend respondió con error HTTP ${res.status} en ${duration}ms`,
      };
    }
  } catch (error) {
    const duration = Math.round(performance.now() - start);
    return {
      ok: false,
      status: 0,
      duration,
      message: `Fallo de conexión al Backend (${error.message})`,
    };
  }
}

// -----------------------------------------------------------------------------
// Petición directa a Supabase (PostgREST)
// -----------------------------------------------------------------------------
async function pingSupabaseDirect() {
  if (!supabaseUrl || !supabaseKey) {
    return { ok: true, skipped: true, message: 'Supabase directo omitido (sin credenciales)' };
  }

  const start = performance.now();
  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/businesses?select=id&limit=1`;

  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'User-Agent': 'DetailOps-KeepAlive/1.0',
      },
      signal: AbortSignal.timeout(20000),
    });

    const duration = Math.round(performance.now() - start);

    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        duration,
        message: `Supabase Directo OK (${res.status}) en ${duration}ms`,
      };
    } else {
      return {
        ok: false,
        status: res.status,
        duration,
        message: `Supabase Directo error HTTP ${res.status}`,
      };
    }
  } catch (error) {
    const duration = Math.round(performance.now() - start);
    return {
      ok: false,
      status: 0,
      duration,
      message: `Supabase Directo falló (${error.message})`,
    };
  }
}

// -----------------------------------------------------------------------------
// Ejecución de un ciclo de ping
// -----------------------------------------------------------------------------
async function runPing() {
  pingCount++;
  const time = getTimestamp();
  console.log(`\n${c.gray}[${time}]${c.reset} ${c.bold}#${pingCount}${c.reset} Verificando servicios...`);

  let allSuccess = true;

  // 1. Petición al Backend (si no es solo DB)
  if (!dbOnly) {
    const backendRes = await pingBackend();
    if (backendRes.ok) {
      console.log(`  ${c.green}✓${c.reset} ${backendRes.message}`);
    } else {
      allSuccess = false;
      console.log(`  ${c.red}✗${c.reset} ${backendRes.message}`);
    }
  }

  // 2. Petición directa a Supabase (si no es solo backend)
  if (!backendOnly && supabaseKey) {
    const sbRes = await pingSupabaseDirect();
    if (sbRes.skipped) {
      // no hacer nada
    } else if (sbRes.ok) {
      console.log(`  ${c.green}✓${c.reset} ${sbRes.message}`);
    } else {
      allSuccess = false;
      console.log(`  ${c.yellow}⚠️${c.reset} ${sbRes.message}`);
    }
  }

  if (allSuccess) {
    successCount++;
  } else {
    failCount++;
  }

  return allSuccess;
}

// -----------------------------------------------------------------------------
// Control del temporizador y flujo principal
// -----------------------------------------------------------------------------
async function main() {
  console.log(`
${c.cyan}${c.bold}================================================================${c.reset}
${c.bold}🚗 DetailOps · Keep-Alive Agent${c.reset}
${c.cyan}================================================================${c.reset}
  ${c.gray}Objetivo Backend :${c.reset} ${backendUrl}
  ${c.gray}Objetivo Supabase:${c.reset} ${supabaseUrl}
  ${c.gray}Intervalo        :${c.reset} Cada ${c.bold}${intervalMinutes} minutos${c.reset}
  ${c.gray}Modo             :${c.reset} ${isOnce ? 'Único ping (--once)' : 'Monitoreo continuo'}
${c.cyan}----------------------------------------------------------------${c.reset}
  ${c.dim}Presiona Ctrl+C en cualquier momento para detener.${c.reset}
`);

  const initialSuccess = await runPing();

  if (isOnce) {
    process.exit(initialSuccess ? 0 : 1);
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  function scheduleNext() {
    const nextDate = new Date(Date.now() + intervalMs);
    const nextTimeStr = nextDate.toLocaleTimeString('es-CO', { hour12: false });
    console.log(`  ${c.blue}⏳ Siguiente ping programado a las ${c.bold}${nextTimeStr}${c.reset} (en ${intervalMinutes}m)...`);

    setTimeout(async () => {
      try {
        await runPing();
      } catch (err) {
        console.error(`  ${c.red}✗ Error inesperado en el ciclo:${c.reset}`, err);
      }
      scheduleNext();
    }, intervalMs);
  }

  scheduleNext();
}

// -----------------------------------------------------------------------------
// Manejo de apagado elegante (Ctrl+C)
// -----------------------------------------------------------------------------
function handleExit() {
  const totalDurationMin = Math.round((Date.now() - startTime) / 60000);
  console.log(`\n\n${c.cyan}================================================================${c.reset}`);
  console.log(`${c.bold}Resumen de ejecución Keep-Alive:${c.reset}`);
  console.log(`  Tiempo activo  : ${totalDurationMin} minutos`);
  console.log(`  Pings totales  : ${pingCount}`);
  console.log(`  Exitosos       : ${c.green}${successCount}${c.reset}`);
  console.log(`  Fallidos       : ${failCount > 0 ? c.red : c.gray}${failCount}${c.reset}`);
  console.log(`${c.cyan}================================================================${c.reset}\n`);
  process.exit(0);
}

process.on('SIGINT', handleExit);
process.on('SIGTERM', handleExit);

main().catch((err) => {
  console.error('\x1b[31mError fatal en Keep-Alive:\x1b[0m', err);
  process.exit(1);
});
