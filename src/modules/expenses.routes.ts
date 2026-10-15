import { Router } from 'express';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { resolveRange } from '../lib/dates';
import { asyncHandler, HttpError } from '../lib/http';
import { run, sb } from '../lib/supabase';
import { getTenantId, requireAuth, requireRole } from '../middleware/auth';
import { parseBody, parseQuery } from '../middleware/validate';
import { EXPENSE_CATEGORIES } from '../types';

const expenseSchema = z.object({
  concept: z.string().trim().min(2, 'Describe el gasto').max(120),
  category: z.enum(EXPENSE_CATEGORIES).default('OTHER'),
  amount: z.coerce.number().int().min(1, 'El monto debe ser mayor a cero'),
  supplier: z.string().trim().max(120).nullable().optional(),
  quantity: z.string().trim().max(60).nullable().optional(),
  paymentMethod: z.string().trim().nullable().optional(),
  employeeId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  spentAt: z.string().min(1).optional(),
});

type ExpenseInput = z.output<typeof expenseSchema>;

function extractMetaFromNotes(notes: string | null) {
  if (!notes) return { supplier: null, quantity: null, cleanNotes: null };
  let supplier: string | null = null;
  let quantity: string | null = null;
  const match = notes.match(/^\[(.*?)\]\s*(.*)$/);
  if (match) {
    const metaStr = match[1];
    const clean = match[2] || null;
    const qMatch = metaStr.match(/Cant:\s*([^|]+)/);
    if (qMatch) quantity = qMatch[1].trim();
    const pMatch = metaStr.match(/Prov:\s*([^|]+)/);
    if (pMatch) supplier = pMatch[1].trim();
    return { supplier, quantity, cleanNotes: clean };
  }
  return { supplier: null, quantity: null, cleanNotes: notes };
}

function toRow(input: Partial<ExpenseInput>, businessId?: string | null) {
  const row: Record<string, unknown> = {};
  if (businessId !== undefined && businessId !== null) row.business_id = businessId;
  if (input.concept !== undefined) row.concept = input.concept;
  if (input.category !== undefined) row.category = input.category;
  if (input.amount !== undefined) row.amount = input.amount;

  // Empaquetar supplier y quantity en notes para compatibilidad total
  let formattedNotes = input.notes || '';
  if (input.quantity || input.supplier) {
    const metaParts: string[] = [];
    if (input.quantity) metaParts.push(`Cant: ${input.quantity}`);
    if (input.supplier) metaParts.push(`Prov: ${input.supplier}`);
    formattedNotes = metaParts.length > 0 ? `[${metaParts.join(' | ')}] ${formattedNotes}`.trim() : formattedNotes;
  }
  if (input.notes !== undefined || input.quantity !== undefined || input.supplier !== undefined) {
    row.notes = formattedNotes || null;
  }

  if (input.spentAt !== undefined) row.spent_at = new Date(input.spentAt).toISOString();
  return row;
}

interface ExpenseRow {
  id: string;
  concept: string;
  category: string;
  amount: number;
  notes: string | null;
  spent_at: string;
  supplier?: string | null;
  quantity?: string | null;
  payment_method?: string | null;
  employee_id?: string | null;
}

export const expensesRouter = Router();

expensesRouter.use(requireAuth);

/** GET /api/expenses?preset=today&category=SUPPLIES */
expensesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const parsed = parseQuery(
      z.object({
        preset: z.enum(['today', 'week', 'month', 'year', 'custom']).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        category: z.string().optional(),
      }),
      req,
    );
    const range = resolveRange(parsed);

    let query = sb()
      .from('expenses')
      .select('*')
      .gte('spent_at', range.from.toISOString())
      .lte('spent_at', range.to.toISOString())
      .order('spent_at', { ascending: false });

    if (businessId) query = query.eq('business_id', businessId);
    if (parsed.category) query = query.eq('category', parsed.category);

    const rows = await run<ExpenseRow[]>(query);

    const data = rows.map((row) => {
      const meta = extractMetaFromNotes(row.notes);
      return {
        ...row,
        supplier: row.supplier || meta.supplier,
        quantity: row.quantity || meta.quantity,
        notes: meta.cleanNotes ?? row.notes,
      };
    });

    res.json({
      range: { from: range.from, to: range.to, preset: range.preset },
      total: rows.reduce((acc, row) => acc + Number(row.amount), 0),
      data: camelize(data),
    });
  }),
);

/** POST /api/expenses */
expensesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const body = parseBody(expenseSchema, req);
    const row = toRow(body, businessId);

    const created = await run<ExpenseRow[]>(
      sb().from('expenses').insert(row).select('*'),
    );
    const item = created[0];
    const meta = extractMetaFromNotes(item.notes);

    res.status(201).json(
      camelize({
        ...item,
        supplier: item.supplier || meta.supplier || body.supplier,
        quantity: item.quantity || meta.quantity || body.quantity,
        notes: meta.cleanNotes ?? item.notes,
      }),
    );
  }),
);

/** PATCH /api/expenses/:id */
expensesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const body = parseBody(expenseSchema.partial(), req);
    const patch = toRow(body);
    if (Object.keys(patch).length === 0) throw HttpError.badRequest('No hay cambios que aplicar');

    let query = sb().from('expenses').update(patch).eq('id', req.params.id);
    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      query = query.eq('business_id', businessId);
    }

    const updated = await run<unknown[]>(query.select('*'));
    if (!updated[0]) throw HttpError.notFound('Gasto no encontrado');
    res.json(camelize(updated[0]));
  }),
);

/** DELETE /api/expenses/:id */
expensesRouter.delete(
  '/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    let query = sb().from('expenses').delete().eq('id', req.params.id);
    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      query = query.eq('business_id', businessId);
    }

    const deleted = await run<unknown[]>(query.select('id'));
    if (!deleted[0]) throw HttpError.notFound('Gasto no encontrado');
    res.status(204).send();
  }),
);
