import { Router } from 'express';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { asyncHandler, HttpError } from '../lib/http';
import { run, sb } from '../lib/supabase';
import { getTenantId, requireAuth, requireRole } from '../middleware/auth';
import { parseBody } from '../middleware/validate';
import { DISCOUNT_TYPES } from '../types';

const promotionSchema = z.object({
  name: z.string().trim().min(2, 'Nombre requerido').max(80),
  description: z.string().trim().max(500).nullable().optional(),
  type: z.enum(DISCOUNT_TYPES).default('PERCENT'),
  value: z.coerce.number().int().min(0),
  startsAt: z.string().date().nullable().optional(),
  endsAt: z.string().date().nullable().optional(),
  active: z.boolean().default(true),
});

type PromotionInput = z.output<typeof promotionSchema>;

function toRow(input: Partial<PromotionInput>, businessId?: string | null) {
  const row: Record<string, unknown> = {};
  if (businessId !== undefined && businessId !== null) row.business_id = businessId;
  if (input.name !== undefined) row.name = input.name;
  if (input.description !== undefined) row.description = input.description || null;
  if (input.type !== undefined) row.type = input.type;
  if (input.value !== undefined) row.value = input.value;
  if (input.startsAt !== undefined) row.starts_at = input.startsAt || null;
  if (input.endsAt !== undefined) row.ends_at = input.endsAt || null;
  if (input.active !== undefined) row.active = input.active;
  return row;
}

export const promotionsRouter = Router();

promotionsRouter.use(requireAuth);

/** GET /api/promotions?onlyActive=true · filtra también por vigencia */
promotionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    let query = sb().from('promotions').select('*').order('created_at', { ascending: false });

    if (businessId) query = query.eq('business_id', businessId);

    if (req.query.onlyActive !== 'false') {
      const today = new Date().toISOString().slice(0, 10);
      query = query
        .eq('active', true)
        .or(`starts_at.is.null,starts_at.lte.${today}`)
        .or(`ends_at.is.null,ends_at.gte.${today}`);
    }

    res.json(camelize(await run(query)));
  }),
);

/** POST /api/promotions */
promotionsRouter.post(
  '/',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const body = parseBody(promotionSchema, req);
    if (body.type === 'PERCENT' && body.value > 100) {
      throw HttpError.badRequest('Un descuento porcentual no puede superar 100%');
    }

    const created = await run<unknown[]>(
      sb().from('promotions').insert(toRow(body, businessId)).select('*'),
    );
    res.status(201).json(camelize(created[0]));
  }),
);

/** PATCH /api/promotions/:id */
promotionsRouter.patch(
  '/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const body = parseBody(promotionSchema.partial(), req);
    if (body.type === 'PERCENT' && (body.value ?? 0) > 100) {
      throw HttpError.badRequest('Un descuento porcentual no puede superar 100%');
    }

    const patch = toRow(body);
    if (Object.keys(patch).length === 0) throw HttpError.badRequest('No hay cambios que aplicar');

    let query = sb().from('promotions').update(patch).eq('id', req.params.id);
    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      query = query.eq('business_id', businessId);
    }

    const updated = await run<unknown[]>(query.select('*'));
    if (!updated[0]) throw HttpError.notFound('Promoción no encontrada');
    res.json(camelize(updated[0]));
  }),
);

/** DELETE /api/promotions/:id */
promotionsRouter.delete(
  '/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const { count } = await sb()
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('promotion_id', req.params.id);

    if ((count ?? 0) > 0) {
      let query = sb().from('promotions').update({ active: false }).eq('id', req.params.id);
      if (businessId && req.user?.role !== 'SUPER_ADMIN') {
        query = query.eq('business_id', businessId);
      }
      const archived = await run<unknown[]>(query.select('*'));
      if (!archived[0]) throw HttpError.notFound('Promoción no encontrada');
      res.json({ archived: true, promotion: camelize(archived[0]) });
      return;
    }

    let delQuery = sb().from('promotions').delete().eq('id', req.params.id);
    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      delQuery = delQuery.eq('business_id', businessId);
    }
    const deleted = await run<unknown[]>(delQuery.select('id'));
    if (!deleted[0]) throw HttpError.notFound('Promoción no encontrada');
    res.status(204).send();
  }),
);
