import { Router } from 'express';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { asyncHandler, HttpError } from '../lib/http';
import { run, sb } from '../lib/supabase';
import { getTenantId, requireAuth, requireRole } from '../middleware/auth';
import { parseBody } from '../middleware/validate';
import { env } from '../config/env';
import { FormlyClient, FormlyError } from '../integrations/formly/formly.client';
import { buildCarWashSurveyPayload } from '../integrations/formly/survey-builder';
import type { FormlyWebhookPayload, SubmitResponsePayload } from '../integrations/formly/types';

export const formlyRouter = Router();
function toHttpFormlyError(err: unknown): HttpError {
  if (err instanceof FormlyError) {
    const status = err.status === 401 ? 422 : err.status;
    return new HttpError(status, `Error de Formly: ${err.message}`, err.providerDetails);
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, err instanceof Error ? err.message : 'Error interno de Formly');
}


// =====================================================================
// Helper: Obtener configuración y cliente de Formly para el negocio actual
// =====================================================================
async function getFormlyClientForBusiness(businessId: string | null): Promise<{
  client: FormlyClient;
  business: Record<string, any>;
  apiKey: string;
  baseUrl: string;
  tenantId?: string;
  webhookSecret?: string;
  enabled: boolean;
}> {
  let business: Record<string, any> | null = null;
  if (businessId) {
    const rows = await run<any[]>(
      sb().from('businesses').select('*').eq('id', businessId).limit(1),
    );
    business = rows[0] || null;
  }
  if (!business) {
    const rows = await run<any[]>(
      sb().from('businesses').select('*').order('created_at', { ascending: true }).limit(1),
    );
    business = rows[0] || {};
  }

  const apiKey = business?.formly_api_key || env.formly.apiKey;
  const baseUrl = business?.formly_base_url || env.formly.baseUrl;
  const tenantId = business?.formly_tenant_id || env.formly.tenantId;
  const webhookSecret = business?.formly_webhook_secret || env.formly.webhookSecret;
  const enabled = Boolean(business?.formly_enabled ?? env.formly.enabled);

  const client = new FormlyClient({
    apiKey,
    baseUrl,
    tenantId,
    webhookSecret,
  });

  return {
    client,
    business: business || {},
    apiKey,
    baseUrl,
    tenantId,
    webhookSecret,
    enabled,
  };
}

// =====================================================================
// ⚡ Webhook Público (Verificación HMAC-SHA256)
// Debe responder a POST /api/formly/webhook sin requerir autenticación JWT
// =====================================================================
formlyRouter.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const signature = (req.headers['x-formly-signature'] as string) || '';
    const rawBody = (req as any).rawBody || JSON.stringify(req.body || {});
    const payload = req.body as FormlyWebhookPayload;

    if (!payload || !payload.eventType) {
      throw HttpError.badRequest('Cuerpo de webhook inválido');
    }

    // Identificar el secret apropiado (por tenant o secret global)
    let secret = env.formly.webhookSecret;
    if (payload.tenantId) {
      const { data: bData } = await sb()
        .from('businesses')
        .select('formly_webhook_secret')
        .eq('formly_tenant_id', payload.tenantId)
        .limit(1)
        .maybeSingle();
      if (bData?.formly_webhook_secret) {
        secret = bData.formly_webhook_secret;
      }
    }

    // Si aún no hay secret configurado por tenant, buscar si algún negocio tiene registrado el surveyId
    if (payload.data?.surveyId) {
      const { data: sRow } = await sb()
        .from('order_surveys')
        .select('business_id, businesses(formly_webhook_secret)')
        .eq('survey_id', payload.data.surveyId)
        .limit(1)
        .maybeSingle();
      const bSecret = (sRow as any)?.businesses?.formly_webhook_secret;
      if (bSecret) {
        secret = bSecret;
      }
    }

    // Verificar firma criptográfica si se ha provisto o configurado un secret
    if (secret) {
      const client = new FormlyClient({ webhookSecret: secret });
      const isValid = client.verifyWebhookSignature(rawBody, signature, secret);
      if (!isValid) {
        console.warn('[Formly Webhook] Firma HMAC inválida para evento:', payload.eventType);
        return res.status(401).json({ error: 'Firma criptográfica inválida (X-Formly-Signature)' });
      }
    }

    console.log(`[Formly Webhook] Evento recibido verificado: ${payload.eventType} (${payload.eventId})`);

    // Procesar evento RESPONSE_COMPLETED
    if (payload.eventType === 'RESPONSE_COMPLETED' && payload.data?.surveyId) {
      const surveyId = payload.data.surveyId;
      const answers = payload.data.answers || [];

      // Extraer métricas de satisfacción
      let rating: number | null = null;
      let npsScore: number | null = null;
      let feedbackComments: string | null = null;

      for (const ans of answers) {
        if (ans.questionType === 'RATING_STARS' && ans.value !== undefined) {
          const num = Number(ans.value);
          if (!isNaN(num) && (rating === null || num < rating)) rating = num; // Tomar calificación
        }
        if (ans.questionType === 'NPS_SCALE' && ans.value !== undefined) {
          const num = Number(ans.value);
          if (!isNaN(num)) npsScore = num;
        }
        if (ans.questionType === 'PARAGRAPH' || ans.text) {
          const text = (ans.text || (typeof ans.value === 'string' ? ans.value : '')).trim();
          if (text) feedbackComments = text;
        }
      }

      // Buscar encuesta vinculada
      const { data: surveyRow } = await sb()
        .from('order_surveys')
        .select('*')
        .eq('survey_id', surveyId)
        .limit(1)
        .maybeSingle();

      if (surveyRow) {
        const total = (surveyRow.total_responses || 0) + 1;
        await sb()
          .from('order_surveys')
          .update({
            total_responses: total,
            rating: rating ?? surveyRow.rating,
            nps_score: npsScore ?? surveyRow.nps_score,
            feedback: feedbackComments || surveyRow.feedback,
            raw_response: payload.data,
            updated_at: new Date().toISOString(),
          })
          .eq('id', surveyRow.id);

        // Registrar en la bitácora / historial de la orden
        if (surveyRow.order_id) {
          const parts = ['Cliente completó la encuesta de satisfacción'];
          if (rating !== null) parts.push(`Calificación: ${rating}/5 ⭐`);
          if (npsScore !== null) parts.push(`NPS: ${npsScore}/10`);
          if (feedbackComments) parts.push(`"${feedbackComments}"`);

          await sb().from('order_events').insert({
            order_id: surveyRow.order_id,
            status: 'FINISHED',
            message: parts.join(' | '),
            user_name: 'Formly B2B',
          });
        }
      }
    }

    return res.status(200).json({ received: true, eventId: payload.eventId });
  }),
);

// =====================================================================
// Endpoints Protegidos con Autenticación de Usuario
// =====================================================================
formlyRouter.use(requireAuth);

/**
 * GET /api/formly/config
 * Obtiene el estado y configuración de Formly del lavadero
 */
formlyRouter.get(
  '/config',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const { business, enabled, apiKey, baseUrl, tenantId, webhookSecret } =
      await getFormlyClientForBusiness(businessId);

    res.json({
      enabled,
      apiKey: apiKey ? `${apiKey.slice(0, 10)}...${apiKey.slice(-4)}` : null,
      hasApiKey: Boolean(apiKey),
      tenantId: tenantId || null,
      webhookSecret: webhookSecret ? '********' : null,
      hasWebhookSecret: Boolean(webhookSecret),
      baseUrl: baseUrl || 'http://localhost:8080/api/v1',
      autoCreateSurvey: Boolean(business.formly_auto_create_survey ?? true),
      webhookUrl: `${env.publicUrl}/api/formly/webhook`,
    });
  }),
);

/**
 * POST /api/formly/request-access
 * Solicita credenciales oficiales B2B al Administrador Maestro (julianrosales0703@hotmail.com)
 */
formlyRouter.post(
  '/request-access',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const { client, business } = await getFormlyClientForBusiness(businessId);

    const schema = z.object({
      companyName: z.string().trim().min(2).default(business.name || 'Lavadero'),
      applicantName: z.string().trim().min(2).default(req.user?.name || 'Administrador'),
      applicantEmail: z.string().trim().email().default(req.user?.email || 'admin@lavadero.com'),
      systemType: z.string().trim().min(2).default('ERP / Gestión de Lavadero y Automotriz'),
      intendedUse: z.string().trim().min(5).default('Generación automatizada de encuestas de calidad y métricas NPS post-servicio para clientes.'),
      webhookUrl: z.string().trim().optional().default(`${env.publicUrl}/api/formly/webhook`),
      baseUrl: z.string().trim().optional(),
    });

    const body = parseBody(schema, req);

    try {
      const response = await client.requestIntegration(
        {
          companyName: body.companyName,
          applicantName: body.applicantName,
          applicantEmail: body.applicantEmail,
          systemType: body.systemType,
          intendedUse: body.intendedUse,
          webhookUrl: body.webhookUrl,
        },
        body.baseUrl,
      );

      // Si nos devolvió un tenantId o status, podemos guardar notas
      if (business.id && response.tenantId) {
        await sb()
          .from('businesses')
          .update({
            formly_tenant_id: response.tenantId,
            formly_webhook_secret: (response as any).signingSecret || business.formly_webhook_secret,
          })
          .eq('id', business.id);
      }

      res.status(201).json(response);
    } catch (err) {
      throw toHttpFormlyError(err);
    }
  }),
);

/**
 * POST /api/formly/orders/:orderId/survey
 * Genera o recupera la encuesta de satisfacción Formly para una orden específica
 */
formlyRouter.post(
  '/orders/:orderId/survey',
  asyncHandler(async (req, res) => {
    const orderId = req.params.orderId;
    const businessId = getTenantId(req);
    const { client, business, apiKey } = await getFormlyClientForBusiness(businessId);

    if (!apiKey) {
      throw HttpError.badRequest(
        'Formly no está configurado. Registra tu API Key oficial en Configuración -> Formly.',
      );
    }

    // 1. Verificar si ya existe una encuesta registrada en order_surveys
    const { data: existingSurvey } = await sb()
      .from('order_surveys')
      .select('*')
      .eq('order_id', orderId)
      .limit(1)
      .maybeSingle();

    if (existingSurvey) {
      return res.json(camelize(existingSurvey));
    }

    // 2. Cargar detalles completos de la orden
    const { data: order } = await sb()
      .from('orders')
      .select(
        'id, number, status, notes, customers(first_name, last_name, phone, email), vehicles(plate, type, brand, model), order_items(name, price)',
      )
      .eq('id', orderId)
      .single();

    if (!order) {
      throw HttpError.notFound('Orden no encontrada');
    }

    const customer = (order as any).customers || {};
    const vehicle = (order as any).vehicles || {};
    const items = (order as any).order_items || [];

    const surveyPayload = buildCarWashSurveyPayload({
      orderId: order.id,
      orderNumber: String(order.number || order.id.slice(0, 8)),
      businessName: business.name || 'Lavadero',
      customerName: customer.first_name ? `${customer.first_name} ${customer.last_name || ''}`.trim() : 'Cliente',
      vehiclePlate: vehicle.plate || '',
      vehicleType: vehicle.type || '',
      servicesSummary: items.map((i: any) => i.name).join(', '),
    });

    try {
      const created = await client.createSurvey(surveyPayload);

      // Guardar en base de datos
      const record = {
        order_id: order.id,
        business_id: business.id || null,
        survey_id: created.surveyId,
        title: created.title,
        status: created.status,
        public_url: created.publicUrl,
        share_url: created.shareUrl,
        total_responses: 0,
      };

      const { data: saved, error } = await sb()
        .from('order_surveys')
        .insert(record)
        .select('*')
        .maybeSingle();

      if (error) {
        console.warn('[Formly] Advertencia al persistir en order_surveys (la tabla podría no existir):', error.message);
        return res.status(201).json(camelize(record));
      }

      res.status(201).json(camelize(saved || record));
    } catch (err) {
      throw toHttpFormlyError(err);
    }
  }),
);

/**
 * GET /api/formly/orders/:orderId/survey
 * Consulta la encuesta y respuestas recibidas de la orden
 */
formlyRouter.get(
  '/orders/:orderId/survey',
  asyncHandler(async (req, res) => {
    const orderId = req.params.orderId;
    const businessId = getTenantId(req);
    const { client, apiKey } = await getFormlyClientForBusiness(businessId);

    const { data: surveyRow } = await sb()
      .from('order_surveys')
      .select('*')
      .eq('order_id', orderId)
      .limit(1)
      .maybeSingle();

    if (!surveyRow) {
      return res.json(null);
    }

    // Si tiene survey_id y tenemos API key, intentar consultar analítica fresca
    let liveAnalytics = null;
    if (apiKey && surveyRow.survey_id) {
      try {
        liveAnalytics = await client.getSurveyResponses(surveyRow.survey_id);
      } catch (err) {
        // Ignorar error si aún no hay respuestas o no se pudo consultar Formly
      }
    }

    res.json({
      ...camelize(surveyRow),
      liveAnalytics,
    });
  }),
);

/**
 * GET /api/formly/surveys/:surveyId/analytics
 * Consulta analítica y respuestas consolidadas directamente a Formly
 */
formlyRouter.get(
  '/surveys/:surveyId/analytics',
  asyncHandler(async (req, res) => {
    const surveyId = req.params.surveyId;
    const businessId = getTenantId(req);
    const { client } = await getFormlyClientForBusiness(businessId);

    try {
      const analytics = await client.getSurveyResponses(surveyId);
      res.json(analytics);
    } catch (err) {
      if (err instanceof FormlyError) {
        throw new HttpError(err.status, err.message, err.providerDetails);
      }
      throw err;
    }
  }),
);

/**
 * POST /api/formly/surveys/:surveyId/responses
 * Enviar respuestas programáticamente a Formly
 */
formlyRouter.post(
  '/surveys/:surveyId/responses',
  asyncHandler(async (req, res) => {
    const surveyId = req.params.surveyId;
    const businessId = getTenantId(req);
    const { client } = await getFormlyClientForBusiness(businessId);

    const body = parseBody(
      z.object({
        answers: z.array(
          z.object({
            questionId: z.string(),
            value: z.union([z.string(), z.number(), z.boolean()]).optional(),
            selectedOptions: z.array(z.string()).optional(),
            text: z.string().optional(),
          }),
        ),
        metadata: z.record(z.unknown()).optional(),
      }),
      req,
    ) as SubmitResponsePayload;

    try {
      const result = await client.submitResponse(surveyId, body);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof FormlyError) {
        throw new HttpError(err.status, err.message, err.providerDetails);
      }
      throw err;
    }
  }),
);
