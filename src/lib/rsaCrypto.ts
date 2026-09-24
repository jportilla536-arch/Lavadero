import crypto from 'node:crypto';
import { getPrivateKeyPem, getPublicKeyPem } from './rsaKeys';

/**
 * =====================================================================
 *  Módulo Criptográfico Asimétrico RSA-OAEP / SHA-256 + AES-256-GCM Híbrido
 * =====================================================================
 * Implementa el estándar Zero-Trust de Cootranar:
 * 1. RSA-OAEP con SHA-256 (2048 bits) para datos entrantes (credenciales, contraseñas).
 * 2. Validación de timestamp (_t) contra Replay Attacks (ventana de 5 minutos).
 * 3. Soporte híbrido con AES-256-GCM para payloads de mayor longitud.
 */

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000; // 5 minutos de tolerancia para reloj cliente/servidor

export interface HybridEncryptedPayload {
  k: string;   // Clave simétrica AES cifrada con RSA-OAEP (Base64)
  iv: string;  // Vector de inicialización (Base64)
  d: string;   // Texto cifrado con AES-256-GCM (Base64)
  tag: string; // Authentication tag GCM (Base64)
}

/**
 * Descifra un payload cifrado proveniente del cliente ({ data: "..." }).
 * Retorna el objeto JSON original deserializado.
 */
export function descifrarPayload<T = Record<string, any>>(dataStr: string): T {
  if (!dataStr || typeof dataStr !== 'string') {
    throw new Error('Payload cifrado no provisto o inválido');
  }

  const privateKey = getPrivateKeyPem();
  let decryptedJsonStr = '';

  // 1. Probar descifrado directo RSA-OAEP SHA-256
  try {
    const buffer = Buffer.from(dataStr, 'base64');
    const decryptedBuffer = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      buffer,
    );
    decryptedJsonStr = decryptedBuffer.toString('utf8');
  } catch (directRsaError) {
    // 2. Si falló el directo, verificar si es un sobre híbrido AES-256-GCM
    try {
      let envelope: HybridEncryptedPayload | null = null;
      try {
        envelope = JSON.parse(Buffer.from(dataStr, 'base64').toString('utf8'));
      } catch {
        envelope = JSON.parse(dataStr);
      }

      if (envelope && envelope.k && envelope.iv && envelope.d && envelope.tag) {
        // Descifrar la clave AES con RSA-OAEP
        const aesKeyBuffer = crypto.privateDecrypt(
          {
            key: privateKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256',
          },
          Buffer.from(envelope.k, 'base64'),
        );

        const ivBuffer = Buffer.from(envelope.iv, 'base64');
        const cipherTextBuffer = Buffer.from(envelope.d, 'base64');
        const tagBuffer = Buffer.from(envelope.tag, 'base64');

        const decipher = crypto.createDecipheriv('aes-256-gcm', aesKeyBuffer, ivBuffer);
        decipher.setAuthTag(tagBuffer);
        const decryptedPart = decipher.update(cipherTextBuffer);
        const finalPart = decipher.final();
        decryptedJsonStr = Buffer.concat([decryptedPart, finalPart]).toString('utf8');
      } else {
        throw new Error('Estructura de sobre híbrido inválida');
      }
    } catch {
      throw new Error('No se pudo descifrar el payload con la clave privada RSA del servidor');
    }
  }

  // 3. Parsear JSON resultante
  let parsed: any;
  try {
    parsed = JSON.parse(decryptedJsonStr);
  } catch {
    throw new Error('El payload descifrado no contiene un JSON válido');
  }

  // 4. Verificación anti-repetición (Replay Attack Prevention)
  if (parsed && typeof parsed === 'object' && parsed._t !== undefined) {
    const timestamp = Number(parsed._t);
    if (!isNaN(timestamp)) {
      const now = Date.now();
      const diff = Math.abs(now - timestamp);
      if (diff > MAX_TIMESTAMP_SKEW_MS) {
        throw new Error('Petición expirada o timestamp inválido (Replay Attack detectado)');
      }
    }
  }

  return parsed as T;
}

/**
 * Cifra un objeto con la clave pública RSA-OAEP SHA-256 del servidor.
 * Si el payload excede el límite de RSA-2048 (~190 bytes), utiliza cifrado híbrido AES-256-GCM.
 */
export function cifrarPayload(payload: object): string {
  const publicKey = getPublicKeyPem();
  const payloadWithTimestamp = {
    ...payload,
    _t: (payload as any)._t || Date.now(),
  };
  const jsonStr = JSON.stringify(payloadWithTimestamp);
  const dataBuffer = Buffer.from(jsonStr, 'utf8');

  // Límite de bloque RSA-2048 con OAEP SHA-256: 256 - (2 * 32) - 2 = 190 bytes
  if (dataBuffer.length <= 190) {
    const encrypted = crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      dataBuffer,
    );
    return encrypted.toString('base64');
  }

  // Esquema híbrido AES-256-GCM
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encryptedData = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const encryptedKey = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey,
  );

  const envelope: HybridEncryptedPayload = {
    k: encryptedKey.toString('base64'),
    iv: iv.toString('base64'),
    d: encryptedData.toString('base64'),
    tag: authTag.toString('base64'),
  };

  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}
