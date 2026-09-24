import fs from 'node:fs';
import path from 'node:path';

/**
 * =====================================================================
 *  Gestión de Claves Criptográficas Asimétricas RSA-2048 (SPKI / PKCS#8)
 * =====================================================================
 * Carga o inicializa el par de claves RSA-2048 bits utilizado para cifrado
 * de capa de aplicación (E2EE / Zero-Trust) entre el cliente y el servidor.
 */

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
    // Si no se puede leer del disco
  }

  rsaPrivateKey = DEFAULT_RSA_PRIVATE_KEY;
  rsaPublicKey = DEFAULT_RSA_PUBLIC_KEY;

  try {
    if (!fs.existsSync(KEYS_DIR)) {
      fs.mkdirSync(KEYS_DIR, { recursive: true });
    }
    fs.writeFileSync(PRIVATE_KEY_PATH, rsaPrivateKey, { mode: 0o600 });
    fs.writeFileSync(PUBLIC_KEY_PATH, rsaPublicKey, { mode: 0o644 });
  } catch {
    // Si no se puede escribir a disco, persiste en memoria
  }

  return { publicKey: rsaPublicKey, privateKey: rsaPrivateKey };
}

// Inicialización inmediata al importar
initRsaKeys();

export function getPublicKeyPem(): string {
  return initRsaKeys().publicKey;
}

export function getPrivateKeyPem(): string {
  return initRsaKeys().privateKey;
}
