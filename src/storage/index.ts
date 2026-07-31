import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env';
import { HttpError } from '../lib/http';
import { sb } from '../lib/supabase';

export interface StoredFile {
  url: string;
  path: string;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/gif': 'gif',
};

export const ALLOWED_IMAGE_MIMES = Object.keys(EXT_BY_MIME);

function buildKey(folder: string, mimetype: string, originalName?: string) {
  const ext =
    EXT_BY_MIME[mimetype] ?? (path.extname(originalName ?? '').replace('.', '') || 'bin');
  const stamp = new Date().toISOString().slice(0, 10);
  return `${folder}/${stamp}/${crypto.randomUUID()}.${ext}`;
}

/** Sube un archivo a Supabase Storage (o al disco local) y devuelve su URL pública. */
export async function uploadFile(params: {
  buffer: Buffer;
  mimetype: string;
  folder: string;
  originalName?: string;
}): Promise<StoredFile> {
  if (!ALLOWED_IMAGE_MIMES.includes(params.mimetype)) {
    throw HttpError.badRequest(`Tipo de archivo no permitido: ${params.mimetype}`);
  }

  const key = buildKey(params.folder, params.mimetype, params.originalName);

  if (env.storage.driver === 'supabase') {
    const bucket = sb().storage.from(env.storage.bucket);
    const { error } = await bucket.upload(key, params.buffer, {
      contentType: params.mimetype,
      upsert: false,
    });

    if (error) throw new HttpError(502, `No se pudo subir la imagen: ${error.message}`);

    const { data } = bucket.getPublicUrl(key);
    return { url: data.publicUrl, path: key };
  }

  const target = path.join(env.storage.localDir, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, params.buffer);
  return { url: `${env.publicUrl}/uploads/${key}`, path: key };
}

/** Elimina un archivo previamente subido. */
export async function removeFile(key: string): Promise<void> {
  if (!key) return;

  if (env.storage.driver === 'supabase') {
    await sb().storage.from(env.storage.bucket).remove([key]);
    return;
  }

  await fs.rm(path.join(env.storage.localDir, key), { force: true });
}

/** Crea el bucket si no existe. Se ejecuta al arrancar el servidor. */
export async function ensureBucket(): Promise<void> {
  if (env.storage.driver !== 'supabase') {
    await fs.mkdir(env.storage.localDir, { recursive: true });
    console.log(`[storage] modo local: ${env.storage.localDir}`);
    return;
  }

  try {
    const { data } = await sb().storage.getBucket(env.storage.bucket);
    if (data) return;

    const { error } = await sb().storage.createBucket(env.storage.bucket, {
      public: true,
      fileSizeLimit: '10MB',
      allowedMimeTypes: ALLOWED_IMAGE_MIMES,
    });
    if (error) throw new Error(error.message);

    console.log(`[storage] bucket "${env.storage.bucket}" creado`);
  } catch (error) {
    console.warn(
      '[storage] no se pudo verificar el bucket:',
      error instanceof Error ? error.message : error,
    );
  }
}
