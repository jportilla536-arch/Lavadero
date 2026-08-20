import { Router } from 'express';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { asyncHandler, HttpError } from '../lib/http';
import { rpc, run, sb } from '../lib/supabase';
import { getTenantId, requireAuth } from '../middleware/auth';
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
  identificationDocumentCode: z.enum(['11', '12', '13', '22', '31', '41', '47']).nullable().optional(),
  identification: z.string().trim().max(30).nullable().optional(),
  address: z.string().trim().max(200).nullable().optional(),
  municipalityCode: z.string().trim().regex(/^\d{5}$/, 'Código DANE inválido').nullable().optional(),
  legalOrganizationCode: z.enum(['1', '2']).nullable().optional(),
  tributeCode: z.string().trim().max(10).nullable().optional(),
  vehicles: z.array(vehicleInput).max(10).optional(),
});

export const customersRouter = Router();

customersRouter.use(requireAuth);

/** GET /api/customers?q=&page=&pageSize= */
customersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const { q, page, pageSize } = parseQuery(
      z.object({
        q: z.string().trim().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      }),
      req,
    );

    let query = sb()
      .from('customers')
      .select('*, vehicles(*)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (businessId) query = query.eq('business_id', businessId);
    if (q) {
      query = query.or(
        `first_name.ilike.%${q}%,last_name.ilike.%${q}%,phone.ilike.%${q}%,identification.ilike.%${q}%`,
      );
    }

    const { data, count, error } = await query;
    if (error) throw error;

    res.json({
      data: camelize(data || []),
      page,
      pageSize,
      total: count || 0,
    });
  }),
);

/** GET /api/customers/search?q= · buscador rápido para crear órdenes */
customersRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const term = (req.query.q as string | undefined)?.trim();

    let query = sb()
      .from('customers')
      .select('*, vehicles(*)')
      .order('created_at', { ascending: false })
      .limit(15);

    if (businessId) query = query.eq('business_id', businessId);
    if (term) {
      query = query.or(
        `first_name.ilike.%${term}%,last_name.ilike.%${term}%,phone.ilike.%${term}%,identification.ilike.%${term}%`,
      );
    }

    const rows = await run<any[]>(query);
    res.json(camelize(rows));
  }),
);

/** GET /api/customers/:id */
customersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    let query = sb()
      .from('customers')
      .select('*, vehicles(*), orders(*)')
      .eq('id', req.params.id)
      .limit(1);

    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      query = query.eq('business_id', businessId);
    }

    const rows = await run<any[]>(query);
    if (!rows[0]) throw HttpError.notFound('Cliente no encontrado');
    res.json(camelize(rows[0]));
  }),
);

/** POST /api/customers · crea cliente y vehículos de forma atómica */
customersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const body = parseBody(customerInput, req);

    const customerRow = {
      first_name: body.firstName,
      last_name: body.lastName,
      phone: body.phone || null,
      email: body.email || null,
      notes: body.notes || null,
      identification_document_code: body.identificationDocumentCode || null,
      identification: body.identification || null,
      address: body.address || null,
      municipality_code: body.municipalityCode || null,
      legal_organization_code: body.legalOrganizationCode || null,
      tribute_code: body.tributeCode || null,
      business_id: businessId,
    };

    const createdCustomers = await run<any[]>(
      sb().from('customers').insert(customerRow).select('*'),
    );
    const createdCustomer = createdCustomers[0];

    const vehiclesToInsert = (body.vehicles ?? []).map((vehicle) => ({
      customer_id: createdCustomer.id,
      plate: vehicle.plate,
      brand: vehicle.brand || null,
      model: vehicle.model || null,
      color: vehicle.color || null,
      type: vehicle.type,
      photo_url: vehicle.photoUrl || null,
      notes: vehicle.notes || null,
    }));

    let insertedVehicles: any[] = [];
    if (vehiclesToInsert.length > 0) {
      insertedVehicles = await run<any[]>(
        sb().from('vehicles').insert(vehiclesToInsert).select('*'),
      );
    }

    createdCustomer.vehicles = insertedVehicles;
    res.status(201).json(camelize(createdCustomer));
  }),
);

/** PATCH /api/customers/:id */
customersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const body = parseBody(customerInput.partial().omit({ vehicles: true }), req);

    const patch: Record<string, unknown> = {};
    if (body.firstName !== undefined) patch.first_name = body.firstName;
    if (body.lastName !== undefined) patch.last_name = body.lastName;
    if (body.phone !== undefined) patch.phone = body.phone || null;
    if (body.email !== undefined) patch.email = body.email || null;
    if (body.notes !== undefined) patch.notes = body.notes || null;
    if (body.identificationDocumentCode !== undefined) {
      patch.identification_document_code = body.identificationDocumentCode || null;
    }
    if (body.identification !== undefined) patch.identification = body.identification || null;
    if (body.address !== undefined) patch.address = body.address || null;
    if (body.municipalityCode !== undefined) patch.municipality_code = body.municipalityCode || null;
    if (body.legalOrganizationCode !== undefined) {
      patch.legal_organization_code = body.legalOrganizationCode || null;
    }
    if (body.tributeCode !== undefined) patch.tribute_code = body.tributeCode || null;

    if (Object.keys(patch).length === 0) throw HttpError.badRequest('No hay cambios que aplicar');

    let query = sb().from('customers').update(patch).eq('id', req.params.id);
    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      query = query.eq('business_id', businessId);
    }

    const updated = await run<unknown[]>(query.select('id'));
    if (!updated[0]) throw HttpError.notFound('Cliente no encontrado');

    const freshRows = await run<any[]>(
      sb().from('customers').select('*, vehicles(*)').eq('id', req.params.id).limit(1),
    );
    res.json(camelize(freshRows[0]));
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
 */
customersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const { force } = parseQuery(forceQuery, req);

    let countQuery = sb()
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', req.params.id);

    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      countQuery = countQuery.eq('business_id', businessId);
    }

    const { count } = await countQuery;

    if ((count ?? 0) > 0) {
      if (!force) {
        throw HttpError.conflict(
          'No se puede eliminar: el cliente tiene órdenes registradas. Reintenta con force=true para eliminarlas también.',
        );
      }
      await run(sb().from('orders').delete().eq('customer_id', req.params.id).select('id'));
    }

    let delQuery = sb().from('customers').delete().eq('id', req.params.id);
    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      delQuery = delQuery.eq('business_id', businessId);
    }

    const deleted = await run<unknown[]>(delQuery.select('id'));
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
    const businessId = getTenantId(req);
    let query = sb()
      .from('vehicles')
      .select('*, customer:customers!inner(id, first_name, last_name, phone, business_id)')
      .order('created_at', { ascending: false })
      .limit(100);

    if (businessId) query = query.eq('customer.business_id', businessId);

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
