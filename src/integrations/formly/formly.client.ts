import crypto from 'node:crypto';
import { env } from '../../config/env';
import type {
  CreateSurveyPayload,
  CreateSurveyResponse,
  IntegrationRequestPayload,
  IntegrationRequestResponse,
  SubmitResponsePayload,
  SubmitResponseResult,
  SurveyAnalyticsResponse,
} from './types';

export interface FormlyClientOptions {
  baseUrl?: string;
  apiKey?: string;
  tenantId?: string;
  webhookSecret?: string;
  timeoutMs?: number;
}

export class FormlyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string = 'FORMLY_ERROR',
    readonly providerDetails?: unknown,
  ) {
    super(message);
    this.name = 'FormlyError';
  }
}

export class FormlyClient {
  private baseUrl: string;
  private apiKey: string;
  private tenantId?: string;
  private webhookSecret?: string;
  private timeoutMs: number;

  constructor(options?: FormlyClientOptions) {
    this.baseUrl = (options?.baseUrl || env.formly.baseUrl || 'http://localhost:8080/api/v1').replace(/\/+$/, '');
    this.apiKey = options?.apiKey || env.formly.apiKey || '';
    this.tenantId = options?.tenantId || env.formly.tenantId || undefined;
    this.webhookSecret = options?.webhookSecret || env.formly.webhookSecret || undefined;
    this.timeoutMs = options?.timeoutMs || env.formly.timeoutMs || 15000;
  }

  private assertApiKey(apiKeyOverride?: string): string {
    const key = apiKeyOverride || this.apiKey;
    if (!key) {
      throw new FormlyError(
        'Falta la API Key de Formly (fmly_live_...). Configúrala en los ajustes del negocio o en FORMLY_API_KEY.',
        401,
        'INVALID_API_KEY',
      );
    }
    return key;
  }

  private async fetchJson<T>(
    path: string,
    init: RequestInit,
    customBaseUrl?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const root = (customBaseUrl || this.baseUrl).replace(/\/+$/, '');
    const url = `${root}${path.startsWith('/') ? path : `/${path}`}`;

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...init.headers,
        },
      });

      const text = await response.text();
      let body: any = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { message: text.slice(0, 500) };
        }
      }

      if (!response.ok) {
        const errorMsg =
          body?.message || body?.error || `Formly API respondió HTTP ${response.status}`;
        const errorCode = body?.code || (response.status === 401 ? 'INVALID_API_KEY' : 'API_ERROR');
        throw new FormlyError(errorMsg, response.status, errorCode, body);
      }

      return body as T;
    } catch (error) {
      if (error instanceof FormlyError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new FormlyError(
          `Formly no respondió dentro del tiempo límite (${this.timeoutMs}ms)`,
          504,
          'TIMEOUT',
        );
      }
      const msg = error instanceof Error ? error.message : 'Error al conectar con Formly Engine';
      const isLocalhost = root.includes('localhost') || root.includes('127.0.0.1');
      const hint = isLocalhost
        ? ' (Nota: Si tu aplicación está en Render o la nube, localhost se refiere al servidor de Render y no a tu PC local. Configura la URL pública de Formly en Configuración -> Formly o prueba en tu entorno local).'
        : '';
      throw new FormlyError(
        `No fue posible conectar con Formly en ${root}: ${msg}${hint}`,
        502,
        'CONNECTION_FAILED',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 1. Solicitar Credenciales API (Estilo Factus)
   * Endpoint público sin autenticación previa.
   */
  async requestIntegration(
    payload: IntegrationRequestPayload,
    customBaseUrl?: string,
  ): Promise<IntegrationRequestResponse> {
    return this.fetchJson<IntegrationRequestResponse>(
      '/public/integrations/requests',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      customBaseUrl,
    );
  }

  /**
   * 2. Crear Encuesta Dinámica B2B
   * Requiere X-Formly-Api-Key
   */
  async createSurvey(
    payload: CreateSurveyPayload,
    override?: { apiKey?: string; tenantId?: string; baseUrl?: string },
  ): Promise<CreateSurveyResponse> {
    const key = this.assertApiKey(override?.apiKey);
    const tenantId = override?.tenantId || this.tenantId;

    const headers: Record<string, string> = {
      'X-Formly-Api-Key': key,
    };
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.fetchJson<CreateSurveyResponse>(
      '/integrations/external/surveys',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      },
      override?.baseUrl,
    );
  }

  /**
   * 3. Enviar Respuestas Programáticamente
   */
  async submitResponse(
    surveyId: string,
    payload: SubmitResponsePayload,
    override?: { apiKey?: string; baseUrl?: string },
  ): Promise<SubmitResponseResult> {
    const headers: Record<string, string> = {};
    const key = override?.apiKey || this.apiKey;
    if (key) {
      headers['X-Formly-Api-Key'] = key;
    }

    return this.fetchJson<SubmitResponseResult>(
      `/public/surveys/${encodeURIComponent(surveyId)}/responses`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      },
      override?.baseUrl,
    );
  }

  /**
   * 4. Consultar Respuestas & Analítica
   * Requiere X-Formly-Api-Key
   */
  async getSurveyResponses(
    surveyId: string,
    override?: { apiKey?: string; tenantId?: string; baseUrl?: string },
  ): Promise<SurveyAnalyticsResponse> {
    const key = this.assertApiKey(override?.apiKey);
    const tenantId = override?.tenantId || this.tenantId;

    const headers: Record<string, string> = {
      'X-Formly-Api-Key': key,
    };
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.fetchJson<SurveyAnalyticsResponse>(
      `/surveys/${encodeURIComponent(surveyId)}/responses`,
      {
        method: 'GET',
        headers,
      },
      override?.baseUrl,
    );
  }

  /**
   * Verificación Criptográfica de la Firma Webhook (HMAC-SHA256)
   * Cabecera: X-Formly-Signature: sha256=...
   */
  verifyWebhookSignature(
    rawBody: Buffer | string,
    signatureHeader?: string,
    secretOverride?: string,
  ): boolean {
    const secret = secretOverride || this.webhookSecret;
    if (!secret) {
      console.warn('[Formly] No se ha configurado un Webhook Secret para validar la firma HMAC');
      return false;
    }
    if (!signatureHeader) {
      return false;
    }

    try {
      const bodyBuffer = Buffer.isBuffer(rawBody)
        ? rawBody
        : Buffer.from(rawBody, 'utf-8');

      const expectedSignature =
        'sha256=' +
        crypto.createHmac('sha256', secret).update(bodyBuffer).digest('hex');

      const headerBuffer = Buffer.from(signatureHeader);
      const expectedBuffer = Buffer.from(expectedSignature);

      if (headerBuffer.length !== expectedBuffer.length) {
        return false;
      }

      return crypto.timingSafeEqual(headerBuffer, expectedBuffer);
    } catch (err) {
      console.error('[Formly] Error verificando firma HMAC:', err);
      return false;
    }
  }
}

export const defaultFormlyClient = new FormlyClient();
