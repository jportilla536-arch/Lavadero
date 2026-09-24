import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * =====================================================================
 *  Módulo de Seguridad de Información: Cifrado Híbrido Asimétrico RSA + César
 *  
 *  Implementa:
 *  1. Cifrado César (sustitución por desplazamiento paramétrico con soporte Unicode/ASCII)
 *  2. Cifrado Asimétrico RSA (par de llaves pública/privada de 2048 bits con OAEP SHA-256)
 *  3. Integración transparente ("que no muestre que se uso"):
 *     - Cifra y descifra campos sensibles de forma transparente para el usuario final.
 *     - Si el texto no está cifrado (datos legados), lo devuelve intacto.
 *     - En base de datos o almacenamiento queda protegido con RSA + César,
 *       mientras que en la interfaz se visualiza limpio y legible para usuarios autorizados.
 * =====================================================================
 */

const DEFAULT_CAESAR_SHIFT = 7;
const STEALTH_PREFIX = '$enc$'; // Identificador discreto de payload seguro

// Rutas para persistencia de claves RSA
const KEYS_DIR = path.resolve(process.cwd(), 'uploads', '.security');
const PRIVATE_KEY_PATH = path.join(KEYS_DIR, 'rsa_private.pem');
const PUBLIC_KEY_PATH = path.join(KEYS_DIR, 'rsa_public.pem');

let rsaPrivateKey: string = '';
let rsaPublicKey: string = '';

/**
 * Inicializa o carga el par de llaves asimétricas RSA (2048 bits).
 */
export function initRsaKeys(): { publicKey: string; privateKey: string } {
  if (rsaPublicKey && rsaPrivateKey) {
    return { publicKey: rsaPublicKey, privateKey: rsaPrivateKey };
  }

  try {
    if (fs.existsSync(PRIVATE_KEY_PATH) && fs.existsSync(PUBLIC_KEY_PATH)) {
      rsaPrivateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
      rsaPublicKey = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
      return { publicKey: rsaPublicKey, privateKey: rsaPrivateKey };
    }
  } catch {
    // Si no se pueden leer del disco, se generarán nuevas
  }

  // Generación de par de llaves asimétricas RSA
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  rsaPublicKey = publicKey;
  rsaPrivateKey = privateKey;

  try {
    if (!fs.existsSync(KEYS_DIR)) {
      fs.mkdirSync(KEYS_DIR, { recursive: true });
    }
    fs.writeFileSync(PRIVATE_KEY_PATH, privateKey, { mode: 0o600 });
    fs.writeFileSync(PUBLIC_KEY_PATH, publicKey, { mode: 0o644 });
  } catch {
    // Si no se puede escribir a disco, se mantiene en memoria
  }

  return { publicKey: rsaPublicKey, privateKey: rsaPrivateKey };
}

// Inicialización inmediata al importar
initRsaKeys();

/**
 * Cifrado César sobre cadenas de texto (soporta caracteres imprimibles y acentos).
 * Desplaza los códigos de caracteres respetando rangos imprimibles.
 */
export function caesarEncrypt(text: string, shift: number = DEFAULT_CAESAR_SHIFT): string {
  if (!text) return '';
  const normalizedShift = ((shift % 95) + 95) % 95;
  return text
    .split('')
    .map((char) => {
      const code = char.charCodeAt(0);
      // Rango ASCII imprimible (32 espacio a 126 tilde)
      if (code >= 32 && code <= 126) {
        return String.fromCharCode(((code - 32 + normalizedShift) % 95) + 32);
      }
      return char;
    })
    .join('');
}

/**
 * Descifrado César (invierte el desplazamiento).
 */
export function caesarDecrypt(text: string, shift: number = DEFAULT_CAESAR_SHIFT): string {
  if (!text) return '';
  const normalizedShift = ((shift % 95) + 95) % 95;
  return caesarEncrypt(text, 95 - normalizedShift);
}

/**
 * Cifrado asimétrico RSA con clave pública.
 * Para soportar cadenas de longitud arbitraria, se usa cifrado híbrido envelope:
 * Se cifra el contenido con una clave simétrica aleatoria (con pre-cifrado César),
 * y la clave simétrica se cifra asimétricamente con la clave pública RSA.
 */
export function rsaPublicEncrypt(buffer: Buffer): Buffer {
  const { publicKey } = initRsaKeys();
  return crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    buffer,
  );
}

/**
 * Descifrado asimétrico RSA con clave privada.
 */
export function rsaPrivateDecrypt(buffer: Buffer): Buffer {
  const { privateKey } = initRsaKeys();
  return crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    buffer,
  );
}

/**
 * Cifrado Híbrido Asimétrico RSA + César.
 * 
 * Flujo:
 * 1. Aplica Cifrado César sobre el texto plano.
 * 2. Genera una clave AES aleatoria de 256 bits y un IV.
 * 3. Cifra el contenido César con AES-256-GCM.
 * 4. Cifra la clave simétrica con la clave pública RSA (Asimétrica).
 * 5. Empaqueta el resultado en formato base64 URL-safe con prefijo $enc$.
 */
export function encryptStealth(plainText: string, caesarShift: number = DEFAULT_CAESAR_SHIFT): string {
  if (plainText === null || plainText === undefined || plainText === '') return '';
  if (typeof plainText !== 'string') plainText = String(plainText);

  // Si ya está cifrado, no volver a cifrar
  if (plainText.startsWith(STEALTH_PREFIX)) return plainText;

  // Paso 1: Cifrado César
  const caesarText = caesarEncrypt(plainText, caesarShift);

  // Paso 2: Generar clave y vector simétrico temporal
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  // Paso 3: Cifrado AES-GCM del texto que ya pasó por César
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encryptedPayload = Buffer.concat([cipher.update(caesarText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Paso 4: Cifrado Asimétrico RSA de la clave simétrica
  const encryptedAesKey = rsaPublicEncrypt(aesKey);

  // Paso 5: Empaquetado binario
  // Estructura: [rsaKeyLength (2 bytes)] [encryptedAesKey] [iv (12 bytes)] [authTag (16 bytes)] [shift (1 byte)] [encryptedPayload]
  const rsaLenBuf = Buffer.alloc(2);
  rsaLenBuf.writeUInt16BE(encryptedAesKey.length, 0);

  const shiftBuf = Buffer.from([caesarShift & 0xff]);

  const packageBuffer = Buffer.concat([
    rsaLenBuf,
    encryptedAesKey,
    iv,
    authTag,
    shiftBuf,
    encryptedPayload,
  ]);

  return `${STEALTH_PREFIX}${packageBuffer.toString('base64url')}`;
}

/**
 * Descifrado Híbrido Asimétrico RSA + César.
 * 
 * Flujo:
 * 1. Si no tiene el formato cifrado, devuelve el texto tal cual (compatibilidad transparente).
 * 2. Desempaqueta y descifra la clave simétrica con la clave privada RSA.
 * 3. Descifra el payload AES-GCM.
 * 4. Aplica Descifrado César para obtener el texto plano original.
 */
export function decryptStealth(cipherText: string): string {
  if (cipherText === null || cipherText === undefined || cipherText === '') return '';
  if (typeof cipherText !== 'string') return cipherText;

  if (!cipherText.startsWith(STEALTH_PREFIX)) {
    // Datos no cifrados previamente se leen tal cual sin error ("que no muestre que se uso")
    return cipherText;
  }

  // Soporte para Cifrado Asimétrico RSA-2048 + César desde el cliente
  if (cipherText.startsWith('$enc$rsa:')) {
    try {
      const parts = cipherText.slice('$enc$rsa:'.length).split(':');
      const shift = parts.length >= 2 ? parseInt(parts[0], 10) : DEFAULT_CAESAR_SHIFT;
      const b64 = parts.length >= 2 ? parts[1] : parts[0];
      const encryptedBuf = Buffer.from(b64, 'base64');
      const decryptedCaesar = rsaPrivateDecrypt(encryptedBuf).toString('utf8');
      return caesarDecrypt(decryptedCaesar, isNaN(shift) ? DEFAULT_CAESAR_SHIFT : shift);
    } catch (err) {
      return cipherText;
    }
  }

  // Fallback César básico
  if (cipherText.startsWith('$enc$caesar:')) {
    try {
      const parts = cipherText.slice('$enc$caesar:'.length).split(':');
      const shift = parts.length >= 2 ? parseInt(parts[0], 10) : DEFAULT_CAESAR_SHIFT;
      const b64 = parts.length >= 2 ? parts[1] : parts[0];
      const caesarText = Buffer.from(b64, 'base64').toString('utf8');
      return caesarDecrypt(caesarText, isNaN(shift) ? DEFAULT_CAESAR_SHIFT : shift);
    } catch (err) {
      return cipherText;
    }
  }

  try {
    const raw = Buffer.from(cipherText.slice(STEALTH_PREFIX.length), 'base64url');
    if (raw.length < 2 + 256 + 12 + 16 + 1) {
      return cipherText;
    }

    const rsaKeyLen = raw.readUInt16BE(0);
    let offset = 2;

    const encryptedAesKey = raw.subarray(offset, offset + rsaKeyLen);
    offset += rsaKeyLen;

    const iv = raw.subarray(offset, offset + 12);
    offset += 12;

    const authTag = raw.subarray(offset, offset + 16);
    offset += 16;

    const caesarShift = raw.readUInt8(offset);
    offset += 1;

    const encryptedPayload = raw.subarray(offset);

    // Descifrado RSA asimétrico de la clave simétrica
    const aesKey = rsaPrivateDecrypt(encryptedAesKey);

    // Descifrado AES-GCM
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);
    const decryptedCaesarText = Buffer.concat([
      decipher.update(encryptedPayload),
      decipher.final(),
    ]).toString('utf8');

    // Descifrado César
    return caesarDecrypt(decryptedCaesarText, caesarShift);
  } catch (error) {
    // Si falla el descifrado, retorna el valor seguro sin tumbar la aplicación
    return cipherText;
  }
}

/**
 * Helper para procesar objetos y asegurar campos sensibles de forma transparente.
 */
export function secureRecord<T extends Record<string, any>>(
  obj: T,
  fields: (keyof T)[],
  mode: 'encrypt' | 'decrypt',
): T {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = { ...obj };
  for (const field of fields) {
    const val = clone[field];
    if (typeof val === 'string' && val.length > 0) {
      clone[field] = (mode === 'encrypt' ? encryptStealth(val) : decryptStealth(val)) as any;
    }
  }
  return clone;
}

export function getRsaPublicKey(): string {
  return initRsaKeys().publicKey;
}

export function getSecurityFingerprint(): string {
  const { publicKey } = initRsaKeys();
  return crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}

export function getSecuritySeal(context: string): {
  algorithm: string;
  cipher: string;
  rsaKeyFingerprint: string;
  publicKey: string;
  seal: string;
  protectedPages: string[];
} {
  const { publicKey } = initRsaKeys();
  const fingerprint = getSecurityFingerprint();
  return {
    algorithm: 'RSA-2048-Asymmetric',
    cipher: 'Caesar-Substitution (Shift 7) + AES-256-GCM',
    rsaKeyFingerprint: fingerprint,
    publicKey,
    seal: encryptStealth(`${context}:${Date.now()}`),
    protectedPages: ['login', 'dashboard', 'ordenes', 'reportes', 'clientes', 'empleados', 'caja'],
  };
}

/**
 * Descifra de manera recursiva todos los campos de un payload que hayan sido
 * protegidos por el cliente con RSA-2048 o César.
 */
export function decryptDeep(data: any): any {
  if (typeof data === 'string') {
    return decryptStealth(data);
  }
  if (Array.isArray(data)) {
    return data.map(decryptDeep);
  }
  if (data !== null && typeof data === 'object') {
    const res: Record<string, any> = {};
    for (const [key, val] of Object.entries(data)) {
      res[key] = decryptDeep(val);
    }
    return res;
  }
  return data;
}
