import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { camelize } from './case';
import { HttpError } from './http';

let client: SupabaseClient | null = null;

/**
 * Cliente de Supabase con la service role key.
 * Ignora RLS, por eso solo debe usarse desde el backend.
 */
export function sb(): SupabaseClient {
  if (!env.supabase.url || !env.supabase.serviceRoleKey) {
    throw new HttpError(
      500,
      'Supabase no está configurado. Define SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en backend/.env',
    );
  }

  if (!client) {
    client = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'public' },
      global: { headers: { 'X-Client-Info': 'lavadero-backend' } },
    });
  }

  return client;
}

/** Traduce un error de PostgREST/Postgres a un HttpError con mensaje útil. */
export function toHttpError(error: PostgrestError): HttpError {
  const message = error.message ?? 'Error de base de datos';

  // raise exception dentro de una función: el mensaje ya es para el usuario.
  if (error.code === 'P0001') return HttpError.badRequest(message);

  if (error.code === '23505') return HttpError.conflict('El registro ya existe');
  if (error.code === '23503') {
    return HttpError.conflict('La referencia indicada no existe o está en uso');
  }
  if (error.code === '23514') {
    return new HttpError(422, 'Un valor no cumple las validaciones');
  }
  if (error.code === '42P01' || error.code === 'PGRST205') {
    return new HttpError(
      500,
      'Las tablas todavía no existen. Ejecuta las migraciones SQL: pnpm db:sql',
    );
  }
  if (error.code === 'PGRST202') {
    return new HttpError(
      500,
      'Faltan las funciones SQL en la base de datos. Ejecuta las migraciones: pnpm db:sql',
    );
  }
  if (error.code === '42501') return HttpError.forbidden('Permisos insuficientes en la base de datos');

  return new HttpError(500, message);
}

/**
 * Invoca una función SQL (RPC).
 *
 * El resultado se normaliza a camelCase de forma recursiva: las funciones
 * mezclan claves construidas a mano (ya en camelCase) con columnas crudas
 * en snake_case. La conversión es idempotente, así que las claves que ya
 * están en camelCase no se tocan.
 */
export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await sb().rpc(fn, args);
  if (error) throw toHttpError(error);
  return camelize<T>(data);
}

/** Envuelve una consulta de PostgREST propagando errores como HttpError. */
export async function run<T>(
  query: PromiseLike<{ data: T | null; error: PostgrestError | null }>,
): Promise<T> {
  const { data, error } = await query;
  if (error) throw toHttpError(error);
  return data as T;
}

/** Igual que `run`, pero exige que exista el registro. */
export async function runOne<T>(
  query: PromiseLike<{ data: T | null; error: PostgrestError | null }>,
  notFoundMessage = 'Recurso no encontrado',
): Promise<T> {
  const { data, error } = await query;
  if (error) {
    // PGRST116 = la consulta con .single() no encontró filas
    if (error.code === 'PGRST116') throw HttpError.notFound(notFoundMessage);
    throw toHttpError(error);
  }
  if (data === null) throw HttpError.notFound(notFoundMessage);
  return data;
}
