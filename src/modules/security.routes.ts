import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { encryptStealth, decryptStealth, caesarEncrypt, caesarDecrypt } from '../lib/security';
import { parseBody } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';

export const securityRouter = Router();

securityRouter.use(requireAuth);

/**
 * POST /api/security/encrypt
 * Cifra un texto utilizando cifrado híbrido asimétrico RSA + César.
 */
securityRouter.post(
  '/encrypt',
  asyncHandler(async (req, res) => {
    const { text, shift } = parseBody(
      z.object({
        text: z.string(),
        shift: z.number().int().optional(),
      }),
      req,
    );

    const encrypted = encryptStealth(text, shift);
    res.json({
      encrypted,
      algorithm: 'RSA-2048-OAEP + CAESAR',
      success: true,
    });
  }),
);

/**
 * POST /api/security/decrypt
 * Descifra un texto previamente protegido con RSA + César.
 */
securityRouter.post(
  '/decrypt',
  asyncHandler(async (req, res) => {
    const { text } = parseBody(
      z.object({
        text: z.string(),
      }),
      req,
    );

    const decrypted = decryptStealth(text);
    res.json({
      decrypted,
      algorithm: 'RSA-2048-OAEP + CAESAR',
      success: true,
    });
  }),
);

/**
 * GET /api/security/status
 * Verifica el estado del sistema criptográfico (RSA asimétrico y César).
 */
securityRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const testSample = 'Seguridad de información Lavadero 2026';
    const encrypted = encryptStealth(testSample);
    const decrypted = decryptStealth(encrypted);

    res.json({
      active: true,
      asymmetric: 'RSA 2048-bit PKCS#1 OAEP SHA-256',
      symmetricPreCipher: 'César Shift Cipher',
      verification: decrypted === testSample ? 'PASSED' : 'FAILED',
    });
  }),
);
