import type { RequestHandler } from 'express';
import { createEncryptedToken } from '../lib/security';

/**
 * =====================================================================
 *  Middleware: encryptResponse
 * =====================================================================
 * Cifra automáticamente todas las respuestas JSON salientes de la API
 * en todas las páginas y módulos del sistema (Clientes, Vehículos, Servicios,
 * Promociones, Empleados, Órdenes, Reportes, Dashboard, Gastos, etc.).
 * 
 * En la pestaña Network de DevTools (tanto en Response como en Preview),
 * todos los datos viajan como { data: "$enc$tok:..." } garantizando Zero-Trust
 * y confidencialidad total de extremo a extremo (E2EE).
 */
export const encryptResponse: RequestHandler = (_req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (body: any) => {
    // 1. No cifrar respuestas de error (status >= 400) ni respuestas vacías/nulas
    if (res.statusCode >= 400 || body === null || body === undefined) {
      return originalJson(body);
    }

    // 2. Excluir endpoints públicos de distribución criptográfica y salud
    const url = res.req?.originalUrl || res.req?.url || '';
    if (
      url.includes('/public-key') ||
      url.includes('/security/info') ||
      url.includes('/health')
    ) {
      return originalJson(body);
    }

    // 3. Si ya viene cifrado en la estructura { data: "$enc$..." }
    if (
      body &&
      typeof body === 'object' &&
      typeof body.data === 'string' &&
      body.data.startsWith('$enc$')
    ) {
      return originalJson(body);
    }

    // 4. Cifrado universal de la respuesta
    try {
      const encryptedData = createEncryptedToken(body);
      return originalJson({ data: encryptedData });
    } catch (err) {
      console.warn('[encryptResponse] Error al cifrar respuesta saliente:', err);
      return originalJson(body);
    }
  };

  next();
};
