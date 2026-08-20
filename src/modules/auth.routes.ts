import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http';
import { run, sb } from '../lib/supabase';
import { requireAuth, requireRole, signToken } from '../middleware/auth';
import { parseBody } from '../middleware/validate';
import { USER_ROLES, type UserRole } from '../types';

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  active: boolean;
  avatar_url: string | null;
  business_id: string | null;
  businesses?: { id: string; name: string; active: boolean }[] | { id: string; name: string; active: boolean } | null;
  employees: { id: string }[] | null;
}

const SELECT = 'id, name, email, password_hash, role, active, avatar_url, business_id, businesses(id, name, active), employees(id)';

const employeeIdOf = (row: UserRow) => row.employees?.[0]?.id ?? null;
const businessOf = (row: UserRow) =>
  Array.isArray(row.businesses) ? row.businesses[0] : row.businesses;

const toPublic = (row: UserRow) => {
  const business = businessOf(row);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active,
    avatarUrl: row.avatar_url,
    employeeId: employeeIdOf(row),
    businessId: row.business_id,
    businessName: business?.name ?? (row.role === 'SUPER_ADMIN' ? 'Super Admin' : null),
  };
};

async function findByEmail(email: string): Promise<UserRow | null> {
  const rows = await run<UserRow[]>(
    sb().from('users').select(SELECT).eq('email', email).limit(1),
  );
  return rows[0] ?? null;
}

export const authRouter = Router();

/** POST /api/auth/login */
authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        email: z.string().trim().toLowerCase().email('Correo inválido'),
        password: z.string().min(1, 'Ingresa tu contraseña'),
      }),
      req,
    );

    const user = await findByEmail(body.email);
    // Mensaje genérico para no revelar si el correo existe.
    if (!user) throw HttpError.unauthorized('Credenciales incorrectas');
    if (!user.active) throw HttpError.forbidden('Tu usuario está desactivado');

    // Si pertenece a un negocio, verificar que el negocio esté activo
    const business = businessOf(user);
    if (user.business_id && business && !business.active) {
      throw HttpError.forbidden('El establecimiento asociado se encuentra suspendido o inactivo');
    }

    const valid = await bcrypt.compare(body.password, user.password_hash);
    if (!valid) throw HttpError.unauthorized('Credenciales incorrectas');

    const token = signToken({
      sub: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      employeeId: employeeIdOf(user),
      businessId: user.business_id,
    });

    res.json({ token, user: toPublic(user) });
  }),
);

/** GET /api/auth/me */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await run<UserRow[]>(
      sb().from('users').select(SELECT).eq('id', req.user!.id).limit(1),
    );
    if (!rows[0]) throw HttpError.unauthorized('El usuario ya no existe');
    res.json({ user: toPublic(rows[0]) });
  }),
);

/** PATCH /api/auth/password */
authRouter.patch(
  '/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(6, 'Mínimo 6 caracteres'),
      }),
      req,
    );

    const rows = await run<UserRow[]>(
      sb().from('users').select(SELECT).eq('id', req.user!.id).limit(1),
    );
    const user = rows[0];
    if (!user) throw HttpError.unauthorized();

    const valid = await bcrypt.compare(body.currentPassword, user.password_hash);
    if (!valid) throw HttpError.badRequest('La contraseña actual no es correcta');

    await run(
      sb()
        .from('users')
        .update({ password_hash: await bcrypt.hash(body.newPassword, 10) })
        .eq('id', user.id),
    );

    res.status(204).send();
  }),
);

/** GET /api/auth/users · ADMIN o SUPER_ADMIN */
authRouter.get(
  '/users',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    let query = sb().from('users').select(SELECT).order('created_at', { ascending: true });
    
    // Si no es superadmin, restringir al negocio del usuario
    if (req.user!.role !== 'SUPER_ADMIN') {
      if (!req.user!.businessId) {
        throw HttpError.badRequest('No perteneces a ningún establecimiento');
      }
      query = query.eq('business_id', req.user!.businessId);
    }

    const rows = await run<UserRow[]>(query);
    res.json(rows.map(toPublic));
  }),
);

/** POST /api/auth/users · solo ADMIN o SUPER_ADMIN */
authRouter.post(
  '/users',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2, 'Nombre demasiado corto'),
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(6, 'Mínimo 6 caracteres'),
        role: z.enum(['ADMIN', 'CASHIER', 'OPERATOR']).default('CASHIER'),
        employeeId: z.string().uuid().nullable().optional(),
        businessId: z.string().uuid().optional(),
      }),
      req,
    );

    const businessId = req.user!.role === 'SUPER_ADMIN' ? (body.businessId ?? null) : req.user!.businessId;
    if (req.user!.role !== 'SUPER_ADMIN' && !businessId) {
      throw HttpError.badRequest('No tienes un establecimiento asignado');
    }

    if (await findByEmail(body.email)) {
      throw HttpError.conflict('Ya existe un usuario con ese correo');
    }

    const created = await run<UserRow[]>(
      sb()
        .from('users')
        .insert({
          name: body.name,
          email: body.email,
          password_hash: await bcrypt.hash(body.password, 10),
          role: body.role,
          business_id: businessId,
        })
        .select(SELECT),
    );

    const user = created[0];
    if (body.employeeId) {
      await run(
        sb().from('employees').update({ user_id: user.id }).eq('id', body.employeeId),
      );
    }

    const freshUser = (await findByEmail(user.email)) ?? user;
    res.status(201).json(toPublic(freshUser));
  }),
);

/** PATCH /api/auth/users/:id · solo ADMIN o SUPER_ADMIN */
authRouter.patch(
  '/users/:id',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2).optional(),
        role: z.enum(USER_ROLES).optional(),
        active: z.boolean().optional(),
        password: z.string().min(6).optional(),
        employeeId: z.string().uuid().nullable().optional(),
      }),
      req,
    );

    // Si es ADMIN, verificar que el usuario a editar pertenezca a su mismo negocio
    if (req.user!.role !== 'SUPER_ADMIN') {
      const targetUser = await run<UserRow[]>(
        sb().from('users').select(SELECT).eq('id', req.params.id).limit(1),
      );
      if (!targetUser[0] || targetUser[0].business_id !== req.user!.businessId) {
        throw HttpError.notFound('Usuario no encontrado en tu establecimiento');
      }
    }

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.role !== undefined) patch.role = body.role;
    if (body.active !== undefined) patch.active = body.active;
    if (body.password !== undefined) patch.password_hash = await bcrypt.hash(body.password, 10);

    if (Object.keys(patch).length === 0 && body.employeeId === undefined) {
      throw HttpError.badRequest('No hay cambios que aplicar');
    }

    if (Object.keys(patch).length > 0) {
      const updated = await run<UserRow[]>(
        sb().from('users').update(patch).eq('id', req.params.id).select(SELECT),
      );
      if (!updated[0]) throw HttpError.notFound('Usuario no encontrado');
    }

    if (body.employeeId !== undefined) {
      if (body.employeeId) {
        await run(
          sb().from('employees').update({ user_id: req.params.id }).eq('id', body.employeeId),
        );
      } else {
        await run(
          sb().from('employees').update({ user_id: null }).eq('user_id', req.params.id),
        );
      }
    }

    const rows = await run<UserRow[]>(
      sb().from('users').select(SELECT).eq('id', req.params.id).limit(1),
    );
    if (!rows[0]) throw HttpError.notFound('Usuario no encontrado');

    res.json(toPublic(rows[0]));
  }),
);
