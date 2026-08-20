import { Router } from 'express';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { asyncHandler, HttpError } from '../lib/http';
import { run, sb } from '../lib/supabase';
import { getTenantId, requireAuth, requireRole } from '../middleware/auth';
import { parseBody } from '../middleware/validate';

const serviceSchema = z.object({
  name: z.string().trim().min(2, 'Nombre requerido').max(80),
  description: z.string().trim().max(500).nullable().optional(),
  price: z.coerce.number().int().min(0, 'El precio no puede ser negativo'),
  durationMin: z.coerce.number().int().min(0).max(1440).default(30),
  category: z.string().trim().max(60).default('Lavado'),
  color: z.string().trim().max(20).nullable().optional(),
  active: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});

type ServiceInput = z.output<typeof serviceSchema>;

/** Convierte el payload de la API a columnas de la tabla. */
function toRow(input: Partial<ServiceInput>, businessId?: string | null) {
  const row: Record<string, unknown> = {};
  if (businessId !== undefined && businessId !== null) row.business_id = businessId;
  if (input.name !== undefined) row.name = input.name;
  if (input.description !== undefined) row.description = input.description || null;
  if (input.price !== undefined) row.price = input.price;
  if (input.durationMin !== undefined) row.duration_min = input.durationMin;
  if (input.category !== undefined) row.category = input.category;
  if (input.color !== undefined) row.color = input.color || null;
  if (input.active !== undefined) row.active = input.active;
  if (input.sortOrder !== undefined) row.sort_order = input.sortOrder;
  return row;
}

export const servicesRouter = Router();

servicesRouter.use(requireAuth);

/** GET /api/services?onlyActive=true */
servicesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    let query = sb()
      .from('services')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (businessId) query = query.eq('business_id', businessId);
    if (req.query.onlyActive !== 'false') query = query.eq('active', true);

    res.json(camelize(await run(query)));
  }),
);

/** POST /api/services */
servicesRouter.post(
  '/',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const body = parseBody(serviceSchema, req);
    const created = await run<unknown[]>(
      sb().from('services').insert(toRow(body, businessId)).select('*'),
    );
    res.status(201).json(camelize(created[0]));
  }),
);

/** PATCH /api/services/:id */
servicesRouter.patch(
  '/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const body = parseBody(serviceSchema.partial(), req);
    const patch = toRow(body);
    if (Object.keys(patch).length === 0) throw HttpError.badRequest('No hay cambios que aplicar');

    let query = sb().from('services').update(patch).eq('id', req.params.id);
    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      query = query.eq('business_id', businessId);
    }

    const updated = await run<unknown[]>(query.select('*'));
    if (!updated[0]) throw HttpError.notFound('Servicio no encontrado');
    res.json(camelize(updated[0]));
  }),
);

/**
 * DELETE /api/services/:id
 * Si el servicio ya se usó en órdenes se desactiva para no perder el histórico.
 */
servicesRouter.delete(
  '/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const { count } = await sb()
      .from('order_items')
      .select('id', { count: 'exact', head: true })
      .eq('service_id', req.params.id);

    if ((count ?? 0) > 0) {
      let query = sb().from('services').update({ active: false }).eq('id', req.params.id);
      if (businessId && req.user?.role !== 'SUPER_ADMIN') {
        query = query.eq('business_id', businessId);
      }
      const archived = await run<unknown[]>(query.select('*'));
      if (!archived[0]) throw HttpError.notFound('Servicio no encontrado');
      res.json({ archived: true, service: camelize(archived[0]) });
      return;
    }

    let delQuery = sb().from('services').delete().eq('id', req.params.id);
    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      delQuery = delQuery.eq('business_id', businessId);
    }
    const deleted = await run<unknown[]>(delQuery.select('id'));
    if (!deleted[0]) throw HttpError.notFound('Servicio no encontrado');
    res.status(204).send();
  }),
);
