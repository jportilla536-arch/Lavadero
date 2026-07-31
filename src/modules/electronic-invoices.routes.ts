import { Router } from 'express';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { asyncHandler, HttpError } from '../lib/http';
import { run, runOne, sb } from '../lib/supabase';
import { requireAuth, requireRole } from '../middleware/auth';
import { parseQuery } from '../middleware/validate';
import type { PaymentMethod } from '../types';
import { buildFactusPayload } from '../integrations/factus/build-payload';
import { factusClient, FactusError } from '../integrations/factus/factus.client';
import type { FactusJson } from '../integrations/factus/types';

interface OrderRow {
  id: string;
  number: string;
  status: string;
  customer_id: string;
  subtotal: number;
  discount_total: number;
  promotion_total: number;
  tip: number;
  total: number;
  notes: string | null;
}

interface CustomerRow {
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  identification_document_code: string | null;
  identification: string | null;
  address: string | null;
  municipality_code: string | null;
  legal_organization_code: string | null;
  tribute_code: string | null;
}

interface BusinessRow {
  factus_enabled: boolean;
  factus_numbering_range_id: number | null;
  factus_document: string;
  factus_operation_type: string;
  factus_send_email: boolean;
  factus_tax_id: string | null;
  factus_tax_rate: number;
  factus_default_municipality_code: string | null;
  factus_default_legal_organization_code: string;
  factus_default_tribute_code: string;
}
interface ItemRow { id: string; name: string; price: number; quantity: number }
interface PaymentRow { method: PaymentMethod; amount: number; reference: string | null }
interface InvoiceRow {
  id: string;
  order_id: string;
  document: string;
  status: 'PENDING' | 'SUBMITTING' | 'VALIDATED' | 'FAILED';
  attempt_count: number;
  number: string | null;
}

const PUBLIC_INVOICE_SELECT = [
  'id',
  'order_id',
  'provider',
  'reference_code',
  'document',
  'status',
  'number',
  'cufe',
  'qr_url',
  'attempt_count',
  'last_attempt_at',
  'validated_at',
  'created_at',
  'updated_at',
].join(',');

function factusData(response: FactusJson): FactusJson {
  const data = response.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as FactusJson) : {};
}

function stringValue(record: FactusJson, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value ? value : null;
}

function recordValue(value: unknown): FactusJson | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as FactusJson)
    : null;
}

function validationMessage(error: FactusError): string {
  if (error.status !== 422) return 'Factus no pudo validar la factura electrónica';
  const details = recordValue(error.providerDetails);
  const data = recordValue(details?.data);
  const errors = recordValue(data?.errors);
  const fields = Object.keys(errors ?? {});
  const messages: string[] = [];
  if (fields.includes('numbering_range_id')) messages.push('el rango de numeración no es válido');
  if (fields.some((field) => field.endsWith('.discount_rate'))) {
    messages.push('el porcentaje de descuento tiene un formato inválido');
  }
  if (fields.some((field) => field.startsWith('customer.'))) {
    messages.push('los datos fiscales del cliente son inválidos');
  }
  return messages.length > 0
    ? `Factus rechazó la factura: ${messages.join(' y ')}.`
    : 'Factus rechazó la factura. Verifica el rango de numeración y los datos fiscales.';
}

function numberingRanges(response: FactusJson) {
  const page = factusData(response);
  const rows = Array.isArray(page.data) ? page.data : [];
  return rows
    .map(recordValue)
    .filter((row): row is FactusJson => Boolean(row))
    .filter((row) => row.is_active === true && String(row.document).includes('Factura'))
    .map((row) => ({
      id: Number(row.id),
      document: String(row.document ?? ''),
      prefix: String(row.prefix ?? ''),
      from: typeof row.from === 'number' ? row.from : null,
      to: typeof row.to === 'number' ? row.to : null,
      resolutionNumber: typeof row.resolution_number === 'string' ? row.resolution_number : null,
      isActive: true,
    }));
}

async function loadInvoiceSource(orderId: string) {
  const [order, business] = await Promise.all([
    runOne<OrderRow>(
      sb().from('orders').select('*').eq('id', orderId).single(),
      'Orden no encontrada',
    ),
    runOne<BusinessRow>(
      sb().from('businesses').select('*').order('created_at').limit(1).single(),
      'Configura los datos del negocio',
    ),
  ]);
  if (order.status !== 'FINISHED') {
    throw HttpError.conflict('Solo se pueden facturar órdenes cobradas y finalizadas');
  }
  if (!business.factus_enabled) {
    throw HttpError.conflict('Habilita Factus en la configuración del negocio');
  }
  if (!business.factus_numbering_range_id) {
    throw new HttpError(422, 'Configura el rango de numeración de Factus');
  }

  const [customer, items, payments] = await Promise.all([
    runOne<CustomerRow>(
      sb().from('customers').select('*').eq('id', order.customer_id).single(),
      'Cliente no encontrado',
    ),
    run<ItemRow[]>(sb().from('order_items').select('id,name,price,quantity').eq('order_id', order.id)),
    run<PaymentRow[]>(
      sb().from('payments').select('method,amount,reference').eq('order_id', order.id).order('paid_at'),
    ),
  ]);

  return {
    order: {
      number: order.number,
      subtotal: order.subtotal,
      discountTotal: order.discount_total,
      promotionTotal: order.promotion_total,
      tip: order.tip,
      total: order.total,
      notes: order.notes,
    },
    customer: {
      firstName: customer.first_name,
      lastName: customer.last_name,
      phone: customer.phone,
      email: customer.email,
      identificationDocumentCode: customer.identification_document_code,
      identification: customer.identification,
      address: customer.address,
      municipalityCode: customer.municipality_code,
      legalOrganizationCode: customer.legal_organization_code,
      tributeCode: customer.tribute_code,
    },
    business: {
      numberingRangeId: business.factus_numbering_range_id,
      document: business.factus_document,
      operationType: business.factus_operation_type,
      sendEmail: business.factus_send_email,
      taxId: business.factus_tax_id,
      taxRate: Number(business.factus_tax_rate),
      defaultMunicipalityCode: business.factus_default_municipality_code,
      defaultLegalOrganizationCode: business.factus_default_legal_organization_code,
      defaultTributeCode: business.factus_default_tribute_code,
    },
    items,
    payments,
  };
}

export const electronicInvoicesRouter = Router();
electronicInvoicesRouter.use(requireAuth);

/** POST /api/electronic-invoices/orders/:orderId · emite o reintenta idempotentemente. */
electronicInvoicesRouter.post(
  '/orders/:orderId',
  requireRole('ADMIN', 'CASHIER'),
  asyncHandler(async (req, res) => {
    const source = await loadInvoiceSource(req.params.orderId);
    const payload = buildFactusPayload(source);

    await run(
      sb().from('electronic_invoices').upsert(
        {
          order_id: req.params.orderId,
          reference_code: source.order.number,
          document: source.business.document,
          request_payload: payload,
        },
        { onConflict: 'order_id,document', ignoreDuplicates: true },
      ),
    );

    let invoice = await runOne<InvoiceRow>(
      sb()
        .from('electronic_invoices')
        .select('*')
        .eq('order_id', req.params.orderId)
        .eq('document', source.business.document)
        .single(),
    );
    if (invoice.status === 'VALIDATED') {
      res.json(camelize(invoice));
      return;
    }

    const claimed = await run<InvoiceRow[]>(
      sb()
        .from('electronic_invoices')
        .update({
          status: 'SUBMITTING',
          request_payload: payload,
          error_payload: null,
          attempt_count: invoice.attempt_count + 1,
          last_attempt_at: new Date().toISOString(),
        })
        .eq('id', invoice.id)
        .in('status', ['PENDING', 'FAILED'])
        .select('*'),
    );
    if (!claimed[0]) {
      throw HttpError.conflict('La factura ya se está procesando');
    }
    invoice = claimed[0];

    try {
      const response = await factusClient.createInvoice(payload);
      const data = factusData(response);
      const number = stringValue(data, 'number');
      const cufe = stringValue(data, 'cufe');
      if (!number || !cufe || data.is_validated === false) {
        throw new FactusError('Factus devolvió una factura sin validar', 502, response);
      }
      const links = data.links && typeof data.links === 'object' ? (data.links as FactusJson) : {};
      const updated = await run<InvoiceRow[]>(
        sb()
          .from('electronic_invoices')
          .update({
            status: 'VALIDATED',
            number,
            cufe,
            qr_url: stringValue(links, 'qr'),
            response_payload: response,
            validated_at: new Date().toISOString(),
          })
          .eq('id', invoice.id)
          .select('*'),
      );
      res.status(invoice.attempt_count === 1 ? 201 : 200).json(camelize(updated[0]));
    } catch (error) {
      const providerError = error instanceof FactusError
        ? { status: error.status, details: error.providerDetails ?? null, message: error.message }
        : { message: error instanceof Error ? error.message : 'Error desconocido' };
      await run(
        sb()
          .from('electronic_invoices')
          .update({ status: 'FAILED', error_payload: providerError })
          .eq('id', invoice.id),
      );
      throw new HttpError(
        error instanceof FactusError ? error.status : 502,
        error instanceof FactusError
          ? validationMessage(error)
          : 'Factus no pudo validar la factura electrónica',
        { invoiceId: invoice.id, code: 'FACTUS_VALIDATION_FAILED' },
      );
    }
  }),
);

/** GET /api/electronic-invoices/numbering-ranges · rangos activos de factura. */
electronicInvoicesRouter.get(
  '/numbering-ranges',
  requireRole('ADMIN'),
  asyncHandler(async (_req, res) => {
    res.json(numberingRanges(await factusClient.listNumberingRanges()));
  }),
);

/** GET /api/electronic-invoices?orderId=&status= */
electronicInvoicesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parseQuery(
      z.object({
        orderId: z.string().uuid().optional(),
        status: z.enum(['PENDING', 'SUBMITTING', 'VALIDATED', 'FAILED']).optional(),
      }),
      req,
    );
    let statement = sb()
      .from('electronic_invoices')
      .select(PUBLIC_INVOICE_SELECT)
      .order('created_at', { ascending: false });
    if (query.orderId) statement = statement.eq('order_id', query.orderId);
    if (query.status) statement = statement.eq('status', query.status);
    res.json(camelize(await run(statement.limit(100))));
  }),
);

/** GET /api/electronic-invoices/provider · listado directo de Factus. */
electronicInvoicesRouter.get(
  '/provider',
  requireRole('ADMIN', 'CASHIER'),
  asyncHandler(async (req, res) => {
    const query = parseQuery(
      z.object({
        identification: z.string().trim().optional(),
        number: z.string().trim().optional(),
        page: z.coerce.number().int().positive().optional(),
      }),
      req,
    );
    res.json(await factusClient.listInvoices(query));
  }),
);

/** GET /api/electronic-invoices/provider/:number · consulta directa de Factus. */
electronicInvoicesRouter.get(
  '/provider/:number',
  requireRole('ADMIN', 'CASHIER'),
  asyncHandler(async (req, res) => {
    res.json(await factusClient.getInvoice(req.params.number));
  }),
);

/** GET /api/electronic-invoices/:id · estado persistido localmente. */
electronicInvoicesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const invoice = await runOne<InvoiceRow>(
      sb()
        .from('electronic_invoices')
        .select(PUBLIC_INVOICE_SELECT)
        .eq('id', req.params.id)
        .single(),
      'Factura electrónica no encontrada',
    );
    res.json(camelize(invoice));
  }),
);