import { Router } from 'express';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { asyncHandler } from '../lib/http';
import { run, sb } from '../lib/supabase';
import { requireAuth, requireRole } from '../middleware/auth';
import { parseBody } from '../middleware/validate';

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
});

type BusinessInput = z.output<typeof businessSchema>;

interface BusinessRow {
  id: string;
}

/** Devuelve la configuración del negocio, creándola si aún no existe. */
async function getBusiness(): Promise<BusinessRow> {
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
  return row;
}

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

/** GET /api/settings/business */
settingsRouter.get(
  '/business',
  asyncHandler(async (_req, res) => {
    res.json(camelize(await getBusiness()));
  }),
);

/** PATCH /api/settings/business */
settingsRouter.patch(
  '/business',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const body = parseBody(businessSchema.partial(), req);
    const current = await getBusiness();
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
