import { Router } from 'express';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { asyncHandler, HttpError } from '../lib/http';
import { rpc, run, sb } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { parseBody, parseQuery } from '../middleware/validate';
import { VEHICLE_TYPES } from '../types';

const vehicleInput = z.object({
  plate: z.string().trim().min(2, 'Placa requerida').max(15).toUpperCase(),
  brand: z.string().trim().max(60).nullable().optional(),
  model: z.string().trim().max(60).nullable().optional(),
  color: z.string().trim().max(40).nullable().optional(),
  type: z.enum(VEHICLE_TYPES).default('CAR'),
  photoUrl: z.string().url().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

const customerInput = z.object({
  firstName: z.string().trim().min(2, 'Nombre requerido').max(80),
  lastName: z.string().trim().max(80).default(''),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().trim().email('Correo inválido').nullable().optional().or(z.literal('')),
  notes: z.string().trim().max(1000).nullable().optional(),
  vehicles: z.array(vehicleInput).max(10).optional(),
});

interface CustomerPage {
  data: unknown[];
  total: number;
}

export const customersRouter = Router();

customersRouter.use(requireAuth);

/** GET /api/customers?q=&page=&pageSize= */
customersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { q, page, pageSize } = parseQuery(
      z.object({
        q: z.string().trim().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      }),
      req,
    );

    const result = await rpc<CustomerPage>('search_customers', {
      p_query: q ?? null,
      p_limit: pageSize,
      p_offset: (page - 1) * pageSize,
    });

    res.json({ data: result.data, page, pageSize, total: result.total });
  }),
);

/** GET /api/customers/search?q= · buscador rápido para crear órdenes */
customersRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const result = await rpc<CustomerPage>('search_customers', {
      p_query: (req.query.q as string | undefined)?.trim() || null,
      p_limit: 15,
      p_offset: 0,
    });
    res.json(result.data);
  }),
);

/** GET /api/customers/:id */
customersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const customer = await rpc<unknown>('customer_detail', { p_id: req.params.id });
    if (!customer) throw HttpError.notFound('Cliente no encontrado');
    res.json(customer);
  }),
);

/** POST /api/customers · crea cliente y vehículos de forma atómica */
customersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseBody(customerInput, req);

    const created = await rpc<unknown>('create_customer', {
      payload: {
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone || null,
        email: body.email || null,
        notes: body.notes || null,
        vehicles: (body.vehicles ?? []).map((vehicle) => ({
          plate: vehicle.plate,
          brand: vehicle.brand || null,
          model: vehicle.model || null,
          color: vehicle.color || null,
          type: vehicle.type,
          photoUrl: vehicle.photoUrl || null,
          notes: vehicle.notes || null,
        })),
      },
    });

    res.status(201).json(created);
  }),
);

/** PATCH /api/customers/:id */
customersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = parseBody(customerInput.partial().omit({ vehicles: true }), req);

    const patch: Record<string, unknown> = {};
    if (body.firstName !== undefined) patch.first_name = body.firstName;
    if (body.lastName !== undefined) patch.last_name = body.lastName;
    if (body.phone !== undefined) patch.phone = body.phone || null;
    if (body.email !== undefined) patch.email = body.email || null;
    if (body.notes !== undefined) patch.notes = body.notes || null;

    if (Object.keys(patch).length === 0) throw HttpError.badRequest('No hay cambios que aplicar');

    const updated = await run<unknown[]>(
      sb().from('customers').update(patch).eq('id', req.params.id).select('id'),
    );
    if (!updated[0]) throw HttpError.notFound('Cliente no encontrado');

    res.json(await rpc('customer_detail', { p_id: req.params.id }));
  }),
);

/** Query opcional ?force=true para arrastrar las órdenes en el borrado. */
const forceQuery = z.object({
  force: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => value === 'true' || value === '1'),
});

/**
 * DELETE /api/customers/:id
 *
 * Sin `force` se bloquea si el cliente tiene órdenes (protege el histórico).
 * Con `force=true` se eliminan primero sus órdenes: items, pagos, evidencias y
 * eventos caen por cascada, así que esas ventas desaparecen de los reportes.
 */
customersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { force } = parseQuery(forceQuery, req);

    const { count } = await sb()
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', req.params.id);

    if ((count ?? 0) > 0) {
      if (!force) {
        throw HttpError.conflict(
          'No se puede eliminar: el cliente tiene órdenes registradas. Reintenta con force=true para eliminarlas también.',
        );
      }
      // Las tablas hijas de orders (items, pagos, evidencias, eventos) tienen
      // on delete cascade, por lo que basta con borrar las órdenes.
      await run(sb().from('orders').delete().eq('customer_id', req.params.id).select('id'));
    }

    const deleted = await run<unknown[]>(
      sb().from('customers').delete().eq('id', req.params.id).select('id'),
    );
    if (!deleted[0]) throw HttpError.notFound('Cliente no encontrado');
    res.status(204).send();
  }),
);

/** Rutas de vehículos (montadas aparte en /api/vehicles) */
export const vehiclesRouter = Router();

vehiclesRouter.use(requireAuth);

const vehicleWithOwner = vehicleInput.extend({ customerId: z.string().uuid('Cliente inválido') });

function vehicleToRow(input: Partial<z.output<typeof vehicleWithOwner>>) {
  const row: Record<string, unknown> = {};
  if (input.customerId !== undefined) row.customer_id = input.customerId;
  if (input.plate !== undefined) row.plate = input.plate;
  if (input.brand !== undefined) row.brand = input.brand || null;
  if (input.model !== undefined) row.model = input.model || null;
  if (input.color !== undefined) row.color = input.color || null;
  if (input.type !== undefined) row.type = input.type;
  if (input.photoUrl !== undefined) row.photo_url = input.photoUrl || null;
  if (input.notes !== undefined) row.notes = input.notes || null;
  return row;
}

/** GET /api/vehicles?customerId=&q= */
vehiclesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    let query = sb()
      .from('vehicles')
      .select('*, customer:customers(id, first_name, last_name, phone)')
      .order('created_at', { ascending: false })
      .limit(100);

    const customerId = req.query.customerId as string | undefined;
    const term = (req.query.q as string | undefined)?.trim();

    if (customerId) query = query.eq('customer_id', customerId);
    if (term) query = query.ilike('plate', `%${term}%`);

    res.json(camelize(await run(query)));
  }),
);

/** POST /api/vehicles */
vehiclesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseBody(vehicleWithOwner, req);
    const created = await run<unknown[]>(
      sb().from('vehicles').insert(vehicleToRow(body)).select('*'),
    );
    res.status(201).json(camelize(created[0]));
  }),
);

/** PATCH /api/vehicles/:id */
vehiclesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = parseBody(vehicleWithOwner.partial().omit({ customerId: true }), req);
    const patch = vehicleToRow(body);
    if (Object.keys(patch).length === 0) throw HttpError.badRequest('No hay cambios que aplicar');

    const updated = await run<unknown[]>(
      sb().from('vehicles').update(patch).eq('id', req.params.id).select('*'),
    );
    if (!updated[0]) throw HttpError.notFound('Vehículo no encontrado');
    res.json(camelize(updated[0]));
  }),
);

/** DELETE /api/vehicles/:id?force=true */
vehiclesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { force } = parseQuery(forceQuery, req);

    const { count } = await sb()
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('vehicle_id', req.params.id);

    if ((count ?? 0) > 0) {
      if (!force) {
        throw HttpError.conflict(
          'No se puede eliminar: el vehículo tiene órdenes registradas. Reintenta con force=true para eliminarlas también.',
        );
      }
      await run(sb().from('orders').delete().eq('vehicle_id', req.params.id).select('id'));
    }

    const deleted = await run<unknown[]>(
      sb().from('vehicles').delete().eq('id', req.params.id).select('id'),
    );
    if (!deleted[0]) throw HttpError.notFound('Vehículo no encontrado');
    res.status(204).send();
  }),
);
