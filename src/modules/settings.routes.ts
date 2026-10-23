import { Router } from 'express';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { asyncHandler, HttpError } from '../lib/http';
import { run, sb } from '../lib/supabase';
import { getTenantId, requireAuth, requireRole } from '../middleware/auth';
import { parseBody } from '../middleware/validate';
import { wipeBusinessData } from '../lib/wipeBusiness';

const businessSchema = z.object({
  name: z.string().trim().min(2, 'Nombre requerido').max(120),
  legalName: z.string().trim().max(160).nullable().optional(),
  taxId: z.string().trim().max(40).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(200).nullable().optional(),
  logoUrl: z.string().url().nullable().optional().or(z.literal('')),
  currency: z.string().trim().length(3).optional(),
  currencySign: z.string().trim().max(5).optional(),
  ticketFooter: z.string().trim().max(200).nullable().optional(),
  ticketWidth: z.enum(['58mm', '80mm']).optional(),
  showQr: z.boolean().optional(),
  factusEnabled: z.boolean().optional(),
  factusNumberingRangeId: z.coerce.number().int().positive().nullable().optional(),
  factusDocument: z.string().trim().min(2).max(4).optional(),
  factusOperationType: z.string().trim().min(2).max(4).optional(),
  factusSendEmail: z.boolean().optional(),
  factusTaxId: z.string().trim().max(10).nullable().optional(),
  factusTaxRate: z.coerce.number().min(0).max(100).optional(),
  factusDefaultMunicipalityCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/, 'Código DANE inválido')
    .nullable()
    .optional(),
  factusDefaultLegalOrganizationCode: z.enum(['1', '2']).optional(),
  factusDefaultTributeCode: z.string().trim().min(1).max(10).optional(),
  formlyEnabled: z.boolean().optional(),
  formlyApiKey: z.string().trim().nullable().optional(),
  formlyTenantId: z.string().trim().nullable().optional(),
  formlyWebhookSecret: z.string().trim().nullable().optional(),
  formlyBaseUrl: z.string().trim().optional(),
  formlyAutoCreateSurvey: z.boolean().optional(),
});

type BusinessInput = z.output<typeof businessSchema>;

interface BusinessRow {
  id: string;
}

/** Devuelve la configuración del negocio del tenant. */
async function getBusiness(businessId: string | null): Promise<BusinessRow> {
  if (businessId) {
    const rows = await run<BusinessRow[]>(
      sb().from('businesses').select('*').eq('id', businessId).limit(1),
    );
    if (rows[0]) return rows[0];
  }

  // Fallback para superadmin sin contexto o primer inicio
  const rows = await run<BusinessRow[]>(
    sb().from('businesses').select('*').order('created_at', { ascending: true }).limit(1),
  );
  if (rows[0]) return rows[0];

  const created = await run<BusinessRow[]>(sb().from('businesses').insert({}).select('*'));
  return created[0];
}

function toRow(input: Partial<BusinessInput>) {
  const row: Record<string, unknown> = {};
  if (input.name !== undefined) row.name = input.name;
  if (input.legalName !== undefined) row.legal_name = input.legalName || null;
  if (input.taxId !== undefined) row.tax_id = input.taxId || null;
  if (input.phone !== undefined) row.phone = input.phone || null;
  if (input.address !== undefined) row.address = input.address || null;
  if (input.logoUrl !== undefined) row.logo_url = input.logoUrl || null;
  if (input.currency !== undefined) row.currency = input.currency;
  if (input.currencySign !== undefined) row.currency_sign = input.currencySign;
  if (input.ticketFooter !== undefined) row.ticket_footer = input.ticketFooter || null;
  if (input.ticketWidth !== undefined) row.ticket_width = input.ticketWidth;
  if (input.showQr !== undefined) row.show_qr = input.showQr;
  if (input.factusEnabled !== undefined) row.factus_enabled = input.factusEnabled;
  if (input.factusNumberingRangeId !== undefined) {
    row.factus_numbering_range_id = input.factusNumberingRangeId;
  }
  if (input.factusDocument !== undefined) row.factus_document = input.factusDocument;
  if (input.factusOperationType !== undefined) row.factus_operation_type = input.factusOperationType;
  if (input.factusSendEmail !== undefined) row.factus_send_email = input.factusSendEmail;
  if (input.factusTaxId !== undefined) row.factus_tax_id = input.factusTaxId || null;
  if (input.factusTaxRate !== undefined) row.factus_tax_rate = input.factusTaxRate;
  if (input.factusDefaultMunicipalityCode !== undefined) {
    row.factus_default_municipality_code = input.factusDefaultMunicipalityCode || null;
  }
  if (input.factusDefaultLegalOrganizationCode !== undefined) {
    row.factus_default_legal_organization_code = input.factusDefaultLegalOrganizationCode;
  }
  if (input.factusDefaultTributeCode !== undefined) {
    row.factus_default_tribute_code = input.factusDefaultTributeCode;
  }
  if (input.formlyEnabled !== undefined) row.formly_enabled = input.formlyEnabled;
  if (input.formlyApiKey !== undefined) row.formly_api_key = input.formlyApiKey || null;
  if (input.formlyTenantId !== undefined) row.formly_tenant_id = input.formlyTenantId || null;
  if (input.formlyWebhookSecret !== undefined) row.formly_webhook_secret = input.formlyWebhookSecret || null;
  if (input.formlyBaseUrl !== undefined) row.formly_base_url = input.formlyBaseUrl || 'http://localhost:8080/api/v1';
  if (input.formlyAutoCreateSurvey !== undefined) row.formly_auto_create_survey = input.formlyAutoCreateSurvey;

  return row;
}

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

/** GET /api/settings/business */
settingsRouter.get(
  '/business',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    res.json(camelize(await getBusiness(businessId)));
  }),
);

/** PATCH /api/settings/business */
settingsRouter.patch(
  '/business',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const body = parseBody(businessSchema.partial(), req);
    const current = await getBusiness(businessId);
    const patch = toRow(body);

    if (Object.keys(patch).length === 0) {
      res.json(camelize(current));
      return;
    }

    const updated = await run<BusinessRow[]>(
      sb().from('businesses').update(patch).eq('id', current.id).select('*'),
    );
    res.json(camelize(updated[0]));
  }),
);

const wipeBusinessSchema = z.object({
  confirmName: z.string().trim().min(1, 'Debes escribir el nombre de la empresa para confirmar'),
  wipeCatalog: z.boolean().default(false),
  wipeEmployees: z.boolean().default(false),
});

/** POST /api/settings/wipe-data */
settingsRouter.post(
  '/wipe-data',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const body = parseBody(wipeBusinessSchema, req);
    const business = await getBusiness(businessId);

    const [fullBusiness] = await run<{ id: string; name: string }[]>(
      sb().from('businesses').select('id, name').eq('id', business.id).limit(1),
    );
    if (!fullBusiness) {
      throw HttpError.notFound('Establecimiento no encontrado');
    }

    if (body.confirmName.trim().toLowerCase() !== fullBusiness.name.trim().toLowerCase()) {
      throw HttpError.badRequest(
        `El nombre ingresado ("${body.confirmName}") no coincide con el nombre de tu empresa ("${fullBusiness.name}").`,
      );
    }

    const result = await wipeBusinessData(fullBusiness.id, {
      wipeCatalog: body.wipeCatalog,
      wipeEmployees: body.wipeEmployees,
    });

    res.json({
      success: true,
      message: `Se han eliminado los datos operativos de ${fullBusiness.name} (${result.deletedOrders} órdenes, ${result.deletedCustomers} clientes).`,
      result,
    });
  }),
);
