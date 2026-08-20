import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { asyncHandler, HttpError } from '../lib/http';
import { run, runOne, sb } from '../lib/supabase';
import { requireAuth, requireRole } from '../middleware/auth';
import { parseBody, parseQuery } from '../middleware/validate';
import { USER_ROLES } from '../types';

export const superadminRouter = Router();

// Todas las rutas de este router requieren rol SUPER_ADMIN
superadminRouter.use(requireAuth);
superadminRouter.use(requireRole('SUPER_ADMIN'));

// ---------------------------------------------------------------------
// Esquemas de validación
// ---------------------------------------------------------------------

const establishmentSchema = z.object({
  name: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres').max(120),
  legalName: z.string().trim().max(160).nullable().optional(),
  taxId: z.string().trim().max(40).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(200).nullable().optional(),
  contactName: z.string().trim().max(120).nullable().optional(),
  contactEmail: z.string().trim().toLowerCase().email().nullable().optional().or(z.literal('')),
  currency: z.string().trim().length(3).default('COP'),
  currencySign: z.string().trim().max(5).default('$'),
  ticketWidth: z.enum(['58mm', '80mm']).default('80mm'),
  active: z.boolean().default(true),
  // Datos del admin inicial opcional
  admin: z
    .object({
      name: z.string().trim().min(2, 'Nombre del administrador requerido'),
      email: z.string().trim().toLowerCase().email('Correo de administrador inválido'),
      password: z.string().min(6, 'Contraseña mínima de 6 caracteres'),
    })
    .optional(),
});

const updateEstablishmentSchema = establishmentSchema.omit({ admin: true }).partial();

const createAdminSchema = z.object({
  name: z.string().trim().min(2, 'Nombre demasiado corto'),
  email: z.string().trim().toLowerCase().email('Correo inválido'),
  password: z.string().min(6, 'Mínimo 6 caracteres'),
  role: z.enum(USER_ROLES).default('ADMIN'),
});

const updateUserSchema = z.object({
  name: z.string().trim().min(2).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  role: z.enum(USER_ROLES).optional(),
  active: z.boolean().optional(),
  password: z.string().min(6).optional(),
  businessId: z.string().uuid().nullable().optional(),
});

// ---------------------------------------------------------------------
// Endpoints de Estadísticas Globales
// ---------------------------------------------------------------------

/** GET /api/superadmin/stats */
superadminRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const [businesses, users, orders] = await Promise.all([
      run<{ id: string; active: boolean }[]>(sb().from('businesses').select('id, active')),
      run<{ id: string; role: string; active: boolean }[]>(sb().from('users').select('id, role, active')),
      run<{ id: string; total: number; status: string }[]>(sb().from('orders').select('id, total, status')),
    ]);

    const totalBusinesses = businesses.length;
    const activeBusinesses = businesses.filter((b) => b.active).length;
    const totalAdmins = users.filter((u) => u.role === 'ADMIN').length;
    const totalUsers = users.length;
    const totalOrders = orders.length;
    const totalRevenue = orders
      .filter((o) => o.status === 'FINISHED')
      .reduce((sum, o) => sum + (o.total || 0), 0);

    res.json({
      totalBusinesses,
      activeBusinesses,
      inactiveBusinesses: totalBusinesses - activeBusinesses,
      totalAdmins,
      totalUsers,
      totalOrders,
      totalRevenue,
    });
  }),
);

// ---------------------------------------------------------------------
// Endpoints de Establecimientos
// ---------------------------------------------------------------------

/** GET /api/superadmin/establishments */
superadminRouter.get(
  '/establishments',
  asyncHandler(async (req, res) => {
    const query = parseQuery(
      z.object({
        q: z.string().trim().optional(),
        status: z.enum(['all', 'active', 'inactive']).default('all'),
      }),
      req,
    );

    let dbQuery = sb()
      .from('businesses')
      .select('*, users(count), employees(count), orders(count)')
      .order('created_at', { ascending: false });

    if (query.status === 'active') dbQuery = dbQuery.eq('active', true);
    if (query.status === 'inactive') dbQuery = dbQuery.eq('active', false);
    if (query.q) {
      dbQuery = dbQuery.or(`name.ilike.%${query.q}%,legal_name.ilike.%${query.q}%,phone.ilike.%${query.q}%`);
    }

    const rows = await run<any[]>(dbQuery);

    const establishments = rows.map((b) => ({
      id: b.id,
      name: b.name,
      legalName: b.legal_name,
      taxId: b.tax_id,
      phone: b.phone,
      address: b.address,
      contactName: b.contact_name,
      contactEmail: b.contact_email,
      logoUrl: b.logo_url,
      currency: b.currency,
      currencySign: b.currency_sign,
      active: b.active ?? true,
      ticketWidth: b.ticket_width,
      usersCount: b.users?.[0]?.count ?? 0,
      employeesCount: b.employees?.[0]?.count ?? 0,
      ordersCount: b.orders?.[0]?.count ?? 0,
      createdAt: b.created_at,
      updatedAt: b.updated_at,
    }));

    res.json(camelize(establishments));
  }),
);

/** POST /api/superadmin/establishments */
superadminRouter.post(
  '/establishments',
  asyncHandler(async (req, res) => {
    const body = parseBody(establishmentSchema, req);

    // Verificar si se especificó admin y si el email ya existe
    if (body.admin) {
      const existingUser = await run<any[]>(
        sb().from('users').select('id').eq('email', body.admin.email).limit(1),
      );
      if (existingUser.length > 0) {
        throw HttpError.conflict('Ya existe un usuario con el correo del administrador especificado');
      }
    }

    // 1. Crear el establecimiento
    const businessRow: Record<string, unknown> = {
      name: body.name,
      legal_name: body.legalName || null,
      tax_id: body.taxId || null,
      phone: body.phone || null,
      address: body.address || null,
      contact_name: body.contactName || null,
      contact_email: body.contactEmail || null,
      currency: body.currency,
      currency_sign: body.currencySign,
      ticket_width: body.ticketWidth,
      active: body.active,
    };

    const createdBusiness = await run<any[]>(
      sb().from('businesses').insert(businessRow).select('*'),
    );

    const business = createdBusiness[0];
    if (!business) {
      throw new HttpError(500, 'Error al crear el establecimiento');
    }

    // 2. Si se especificó admin, crearlo y vincularlo
    let adminUser = null;
    if (body.admin) {
      const createdUser = await run<any[]>(
        sb()
          .from('users')
          .insert({
            name: body.admin.name,
            email: body.admin.email,
            password_hash: await bcrypt.hash(body.admin.password, 10),
            role: 'ADMIN',
            business_id: business.id,
            active: true,
          })
          .select('id, name, email, role, active, business_id'),
      );
      adminUser = createdUser[0];
    }

    res.status(201).json({
      establishment: camelize(business),
      admin: adminUser ? camelize(adminUser) : null,
    });
  }),
);

/** GET /api/superadmin/establishments/:id */
superadminRouter.get(
  '/establishments/:id',
  asyncHandler(async (req, res) => {
    const business = await runOne<any>(
      sb()
        .from('businesses')
        .select('*, users(*), employees(*)')
        .eq('id', req.params.id)
        .single(),
      'Establecimiento no encontrado',
    );

    res.json(camelize(business));
  }),
);

/** PATCH /api/superadmin/establishments/:id */
superadminRouter.patch(
  '/establishments/:id',
  asyncHandler(async (req, res) => {
    const body = parseBody(updateEstablishmentSchema, req);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.legalName !== undefined) patch.legal_name = body.legalName || null;
    if (body.taxId !== undefined) patch.tax_id = body.taxId || null;
    if (body.phone !== undefined) patch.phone = body.phone || null;
    if (body.address !== undefined) patch.address = body.address || null;
    if (body.contactName !== undefined) patch.contact_name = body.contactName || null;
    if (body.contactEmail !== undefined) patch.contact_email = body.contactEmail || null;
    if (body.currency !== undefined) patch.currency = body.currency;
    if (body.currencySign !== undefined) patch.currency_sign = body.currencySign;
    if (body.ticketWidth !== undefined) patch.ticket_width = body.ticketWidth;
    if (body.active !== undefined) patch.active = body.active;

    if (Object.keys(patch).length === 0) {
      throw HttpError.badRequest('No hay cambios que aplicar');
    }

    const updated = await run<any[]>(
      sb().from('businesses').update(patch).eq('id', req.params.id).select('*'),
    );

    if (!updated[0]) throw HttpError.notFound('Establecimiento no encontrado');

    res.json(camelize(updated[0]));
  }),
);

// ---------------------------------------------------------------------
// Endpoints de Administradores por Establecimiento
// ---------------------------------------------------------------------

/** GET /api/superadmin/establishments/:id/admins */
superadminRouter.get(
  '/establishments/:id/admins',
  asyncHandler(async (req, res) => {
    const users = await run<any[]>(
      sb()
        .from('users')
        .select('id, name, email, role, active, avatar_url, created_at, business_id')
        .eq('business_id', req.params.id)
        .order('created_at', { ascending: true }),
    );

    res.json(camelize(users));
  }),
);

/** POST /api/superadmin/establishments/:id/admins */
superadminRouter.post(
  '/establishments/:id/admins',
  asyncHandler(async (req, res) => {
    const businessId = req.params.id;
    const body = parseBody(createAdminSchema, req);

    // Verificar que el establecimiento exista
    await runOne(
      sb().from('businesses').select('id').eq('id', businessId).single(),
      'Establecimiento no encontrado',
    );

    // Verificar si el email ya existe
    const existing = await run<any[]>(
      sb().from('users').select('id').eq('email', body.email).limit(1),
    );
    if (existing.length > 0) {
      throw HttpError.conflict('Ya existe un usuario con ese correo electrónico');
    }

    const created = await run<any[]>(
      sb()
        .from('users')
        .insert({
          name: body.name,
          email: body.email,
          password_hash: await bcrypt.hash(body.password, 10),
          role: body.role,
          business_id: businessId,
          active: true,
        })
        .select('id, name, email, role, active, business_id, created_at'),
    );

    res.status(201).json(camelize(created[0]));
  }),
);

// ---------------------------------------------------------------------
// Endpoints de Usuarios Globales
// ---------------------------------------------------------------------

/** GET /api/superadmin/users */
superadminRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    const query = parseQuery(
      z.object({
        businessId: z.string().uuid().optional(),
        role: z.enum(USER_ROLES).optional(),
        q: z.string().trim().optional(),
      }),
      req,
    );

    let dbQuery = sb()
      .from('users')
      .select('id, name, email, role, active, avatar_url, created_at, business_id, businesses(id, name)')
      .order('created_at', { ascending: false });

    if (query.businessId) dbQuery = dbQuery.eq('business_id', query.businessId);
    if (query.role) dbQuery = dbQuery.eq('role', query.role);
    if (query.q) dbQuery = dbQuery.or(`name.ilike.%${query.q}%,email.ilike.%${query.q}%`);

    const rows = await run<any[]>(dbQuery);
    const users = rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      active: u.active,
      avatarUrl: u.avatar_url,
      createdAt: u.created_at,
      businessId: u.business_id,
      businessName: u.businesses?.name ?? (u.role === 'SUPER_ADMIN' ? 'Global (Super Admin)' : 'Sin Asignar'),
    }));

    res.json(camelize(users));
  }),
);

/** PATCH /api/superadmin/users/:id */
superadminRouter.patch(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const body = parseBody(updateUserSchema, req);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.email !== undefined) patch.email = body.email;
    if (body.role !== undefined) patch.role = body.role;
    if (body.active !== undefined) patch.active = body.active;
    if (body.businessId !== undefined) patch.business_id = body.businessId;
    if (body.password !== undefined) patch.password_hash = await bcrypt.hash(body.password, 10);

    if (Object.keys(patch).length === 0) {
      throw HttpError.badRequest('No hay cambios que aplicar');
    }

    const updated = await run<any[]>(
      sb()
        .from('users')
        .update(patch)
        .eq('id', req.params.id)
        .select('id, name, email, role, active, business_id, created_at'),
    );

    if (!updated[0]) throw HttpError.notFound('Usuario no encontrado');

    res.json(camelize(updated[0]));
  }),
);
