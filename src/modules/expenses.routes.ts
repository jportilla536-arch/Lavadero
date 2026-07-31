import { Router } from 'express';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { resolveRange } from '../lib/dates';
import { asyncHandler, HttpError } from '../lib/http';
import { run, sb } from '../lib/supabase';
import { requireAuth, requireRole } from '../middleware/auth';
import { parseBody, parseQuery } from '../middleware/validate';
import { EXPENSE_CATEGORIES } from '../types';

const expenseSchema = z.object({
  concept: z.string().trim().min(2, 'Describe el gasto').max(120),
  category: z.enum(EXPENSE_CATEGORIES).default('OTHER'),
  amount: z.coerce.number().int().min(1, 'El monto debe ser mayor a cero'),
  notes: z.string().trim().max(500).nullable().optional(),
  spentAt: z.string().min(1).optional(),
});

type ExpenseInput = z.output<typeof expenseSchema>;

function toRow(input: Partial<ExpenseInput>) {
  const row: Record<string, unknown> = {};
  if (input.concept !== undefined) row.concept = input.concept;
  if (input.category !== undefined) row.category = input.category;
  if (input.amount !== undefined) row.amount = input.amount;
  if (input.notes !== undefined) row.notes = input.notes || null;
  if (input.spentAt !== undefined) row.spent_at = new Date(input.spentAt).toISOString();
  return row;
}

interface ExpenseRow {
  amount: number;
}

export const expensesRouter = Router();

expensesRouter.use(requireAuth);

/** GET /api/expenses?preset=today */
expensesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const range = resolveRange(
      parseQuery(
        z.object({
          preset: z.enum(['today', 'week', 'month', 'year', 'custom']).optional(),
          from: z.string().optional(),
          to: z.string().optional(),
        }),
        req,
      ),
    );

    const rows = await run<ExpenseRow[]>(
      sb()
        .from('expenses')
        .select('*')
        .gte('spent_at', range.from.toISOString())
        .lte('spent_at', range.to.toISOString())
        .order('spent_at', { ascending: false }),
    );

    res.json({
      range: { from: range.from, to: range.to, preset: range.preset },
      total: rows.reduce((acc, row) => acc + Number(row.amount), 0),
      data: camelize(rows),
    });
  }),
);

/** POST /api/expenses */
expensesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseBody(expenseSchema, req);
    const created = await run<unknown[]>(sb().from('expenses').insert(toRow(body)).select('*'));
    res.status(201).json(camelize(created[0]));
  }),
);

/** PATCH /api/expenses/:id */
expensesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = parseBody(expenseSchema.partial(), req);
    const patch = toRow(body);
    if (Object.keys(patch).length === 0) throw HttpError.badRequest('No hay cambios que aplicar');

    const updated = await run<unknown[]>(
      sb().from('expenses').update(patch).eq('id', req.params.id).select('*'),
    );
    if (!updated[0]) throw HttpError.notFound('Gasto no encontrado');
    res.json(camelize(updated[0]));
  }),
);

/** DELETE /api/expenses/:id */
expensesRouter.delete(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const deleted = await run<unknown[]>(
      sb().from('expenses').delete().eq('id', req.params.id).select('id'),
    );
    if (!deleted[0]) throw HttpError.notFound('Gasto no encontrado');
    res.status(204).send();
  }),
);
