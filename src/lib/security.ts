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

const DEFAULT_RSA_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDoH5WzusThEw1X
G97tM/J41h/Qgtu1r7aFVGGlHfXhIOjrR4RfgWAR3ldWKjjk9/4PTDh3seL8zQjG
DuaIa+0lgg16sem8usxSJzcZlS37qWnYqWg3MHtaFTdcqRuwNNhw4xrggwB5xpRC
RYQkmCP35IJB1gzTMRJ72RC6RdkVpQdbuTJmXvgRFbyva7DbKv9uQWbwCgydVi29
LI1YY/BiSvY96FAMN6lTJgJgcCkRSTYk0AiZ4s06UMWheEQBkbYKKDbVBjHMCp86
tlAnKni0w7kCX8PPEJlFLvO502vEcMt0vZT+GaiAy4BjleDq39x79iptBnNoLdh7
nn7XdAuVAgMBAAECggEAQXoLWd/wwkaECFLZztJM7s4Dumb3P+hZVYHIa3GoloEY
gqmxStltNo0f2LPfSaM0nK8U7JqWm1XgyDGS0N+UzPRDBh2if7S3huL99W7xwh/3
NgEPXyYDXZVHgRFIuKsndKxzO+poG3GrB4ihbksmNjpUjeqpwncArkO8JrcmNabG
g/Frv1HZAarFoSJIFP5Q5mYnYxMYKpKrPDhji7fVyx2k1CE4VeUfC+YBRlJLjsZH
X/HgUt9uR40f1oSXJ9b7M0zCCCNEnURSqKRJUsQ7fB1+fdbOlZxOxw+RGtchjUaA
/h4tCVdbPIGb6XejCUfvrb6ukE2K4HcpHQoYvZfCTwKBgQD2tyYLH9hCmo2qZHHM
sG/Bqrb/pN8WZfx0l0QQBTfsD/9bzb5j9w17dm7UkgJrLUnuK/MbWlHFxBC7q4sm
IGR+PQrrBnNRzCxNwB6FfQeqgNgjGWjBmdDU67I8YDxUMKxPK2i8spa3fUmBJbZ5
gLXD/ZlRRkOSh9apCVqmbb3QpwKBgQDw29tP+mql/NwRqDyA+isHvzgmUN+ZEpfo
+vwYNKqkbpu6bhX9Eo/bxXNF7MoRUtFPklDEm6ppCqx6DQTHy3maSK4iU60O1vSf
FU9RpY0wVp+dQje4m3nhpY5bL67dE++3DjEC3sdnlOnQ8mvl8cqkcgFdTXNv7OvA
fKetoIktYwKBgHweuiIAnGEttjXSILp0zVSmmThV7vIqzu6tJ03UAkVd6v95q95I
7Vx+wdVpu5PGDhqnu7+4GcmgETcJX5EH3ObxuOtyrFOrn2JiVDieJVwvRA2se9pi
kwB7r4jWdaN5dUbDNQcx5cdcXb1+hqXsDgYTMK4F5nryohkanqN6NHOjAoGBANUq
n9UO2eiB+/scnD/CKOc4U2eF1/7Pt+aYixiZNBVHV0gOOiO6k9t7yuOuB8CBPYJh
Cl6XLqC8s51pfDufV8Y2YPc8e0NQ9zr8TzEBhg2r/KPfgRU/dQVB0tXdQ7Oh+1xV
kQbrSCviXXVxuBDQh/o2dAKxk2MRmizHpldCZ2XlAoGBALlvTmPisEMvgp0Xtp7m
CokPZJw0aqJReLKtFJJNngFmFPGxTFNIhoil9bAatIv2m0yqGPO74+eTcvZHy1pQ
dtwDdPF0II2+7PPYNdefOVdSwy2+WY0D3s/S2WZQEfCMF/bEihy+NVa8PALc+M8x
G1izDgNHsX743r0iFsfEDgy8
-----END PRIVATE KEY-----`;

const DEFAULT_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6B+Vs7rE4RMNVxve7TPy
eNYf0ILbta+2hVRhpR314SDo60eEX4FgEd5XVio45Pf+D0w4d7Hi/M0Ixg7miGvt
JYINerHpvLrMUic3GZUt+6lp2KloNzB7WhU3XKkbsDTYcOMa4IMAecaUQkWEJJgj
9+SCQdYM0zESe9kQukXZFaUHW7kyZl74ERW8r2uw2yr/bkFm8AoMnVYtvSyNWGPw
Ykr2PehQDDepUyYCYHApEUk2JNAImeLNOlDFoXhEAZG2Cig21QYxzAqfOrZQJyp4
tMO5Al/DzxCZRS7zudNrxHDLdL2U/hmogMuAY5Xg6t/ce/YqbQZzaC3Ye55+13QL
lQIDAQAB
-----END PUBLIC KEY-----`;

let rsaPrivateKey: string = '';
let rsaPublicKey: string = '';

/**
 * Inicializa o carga el par de llaves asimétricas RSA (2048 bits).
 */
export function initRsaKeys(): { publicKey: string; privateKey: string } {
  if (rsaPublicKey && rsaPrivateKey) {
    return { publicKey: rsaPublicKey, privateKey: rsaPrivateKey };
  }

  if (process.env.RSA_PRIVATE_KEY && process.env.RSA_PUBLIC_KEY) {
    rsaPrivateKey = process.env.RSA_PRIVATE_KEY;
    rsaPublicKey = process.env.RSA_PUBLIC_KEY;
    return { publicKey: rsaPublicKey, privateKey: rsaPrivateKey };
  }

  try {
    if (fs.existsSync(PRIVATE_KEY_PATH) && fs.existsSync(PUBLIC_KEY_PATH)) {
      rsaPrivateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
      rsaPublicKey = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
      return { publicKey: rsaPublicKey, privateKey: rsaPrivateKey };
    }
  } catch {
    // Si no se pueden leer del disco
  }

  // Usar el par criptográfico predeterminado para garantizar paridad absoluta con los clientes
  rsaPrivateKey = DEFAULT_RSA_PRIVATE_KEY;
  rsaPublicKey = DEFAULT_RSA_PUBLIC_KEY;

  try {
    if (!fs.existsSync(KEYS_DIR)) {
      fs.mkdirSync(KEYS_DIR, { recursive: true });
    }
    fs.writeFileSync(PRIVATE_KEY_PATH, rsaPrivateKey, { mode: 0o600 });
    fs.writeFileSync(PUBLIC_KEY_PATH, rsaPublicKey, { mode: 0o644 });
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
