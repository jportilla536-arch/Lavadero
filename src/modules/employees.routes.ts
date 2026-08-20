import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { asyncHandler, HttpError } from '../lib/http';
import { rpc, run, sb } from '../lib/supabase';
import { getTenantId, requireAuth, requireRole } from '../middleware/auth';
import { parseBody } from '../middleware/validate';
import { EMPLOYEE_STATUSES } from '../types';

const userAccountSchema = z.object({
  email: z.string().trim().toLowerCase().email('Correo inválido'),
  password: z.string().min(6, 'Mínimo 6 caracteres'),
});

const employeeSchema = z.object({
  name: z.string().trim().min(2, 'Nombre requerido').max(80),
  position: z.string().trim().max(60).default('Lavador'),
  phone: z.string().trim().max(30).nullable().optional(),
  status: z.enum(EMPLOYEE_STATUSES).default('ACTIVE'),
  hiredAt: z.string().date().nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
  userAccount: userAccountSchema.nullable().optional(),
});

type EmployeeInput = z.output<typeof employeeSchema>;

function toRow(input: Partial<EmployeeInput>, businessId?: string | null) {
  const row: Record<string, unknown> = {};
  if (businessId !== undefined && businessId !== null) row.business_id = businessId;
  if (input.name !== undefined) row.name = input.name;
  if (input.position !== undefined) row.position = input.position;
  if (input.phone !== undefined) row.phone = input.phone || null;
  if (input.status !== undefined) row.status = input.status;
  if (input.hiredAt !== undefined) row.hired_at = input.hiredAt || null;
  if (input.userId !== undefined) row.user_id = input.userId || null;
  return row;
}

export const employeesRouter = Router();

employeesRouter.use(requireAuth);

/** GET /api/employees?onlyActive=true · incluye métricas del día */
employeesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    // Consultar empleados por negocio
    let query = sb()
      .from('employees')
      .select('*, users(email, active)')
      .order('name', { ascending: true });

    if (businessId) query = query.eq('business_id', businessId);
    if (req.query.onlyActive === 'true') query = query.eq('status', 'ACTIVE');

    const employees = await run<any[]>(query);

    // Mapear con métricas
    const today = new Date().toISOString().slice(0, 10);
    const enriched = await Promise.all(
      employees.map(async (emp) => {
        let orderQuery = sb()
          .from('orders')
          .select('id, status, tip, finished_at')
          .eq('employee_id', emp.id);

        if (businessId) orderQuery = orderQuery.eq('business_id', businessId);

        const orders = await run<any[]>(orderQuery);

        const activeOrders = orders.filter((o) =>
          ['PENDING', 'IN_PROGRESS', 'READY'].includes(o.status),
        ).length;
        const finishedTodayOrders = orders.filter(
          (o) => o.status === 'FINISHED' && o.finished_at && o.finished_at.slice(0, 10) === today,
        );
        const finishedToday = finishedTodayOrders.length;
        const tipsToday = finishedTodayOrders.reduce((sum, o) => sum + (o.tip || 0), 0);

        return {
          id: emp.id,
          name: emp.name,
          position: emp.position,
          phone: emp.phone,
          status: emp.status,
          hiredAt: emp.hired_at,
          userId: emp.user_id,
          businessId: emp.business_id,
          userEmail: emp.users?.email ?? null,
          userActive: emp.users?.active ?? null,
          activeOrders,
          finishedToday,
          tipsToday,
        };
      }),
    );

    res.json(camelize(enriched));
  }),
);

/** GET /api/employees/working · solo quienes tienen órdenes en curso */
employeesRouter.get(
  '/working',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    let query = sb().from('employees').select('*').eq('status', 'ACTIVE');
    if (businessId) query = query.eq('business_id', businessId);

    const employees = await run<any[]>(query);
    const result = [];

    for (const emp of employees) {
      let orderQuery = sb()
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('employee_id', emp.id)
        .in('status', ['PENDING', 'IN_PROGRESS', 'READY']);

      if (businessId) orderQuery = orderQuery.eq('business_id', businessId);

      const { count } = await orderQuery;
      if ((count ?? 0) > 0) {
        result.push({
          id: emp.id,
          name: emp.name,
          position: emp.position,
          phone: emp.phone,
          status: emp.status,
          activeOrders: count,
        });
      }
    }

    res.json(camelize(result));
  }),
);

/** GET /api/employees/:id */
employeesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    let query = sb()
      .from('employees')
      .select('*, users(email, active)')
      .eq('id', req.params.id)
      .limit(1);

    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      query = query.eq('business_id', businessId);
    }

    const rows = await run<any[]>(query);
    if (!rows[0]) throw HttpError.notFound('Empleado no encontrado');
    res.json(camelize(rows[0]));
  }),
);

/** POST /api/employees */
employeesRouter.post(
  '/',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const body = parseBody(employeeSchema, req);
    let createdUserId = body.userId || null;

    if (body.userAccount) {
      const existing = await run<{ id: string }[]>(
        sb().from('users').select('id').eq('email', body.userAccount.email).limit(1),
      );
      if (existing[0]) {
        throw HttpError.conflict('Ya existe un usuario con ese correo electrónico');
      }

      const passwordHash = await bcrypt.hash(body.userAccount.password, 10);
      const createdUser = await run<{ id: string }[]>(
        sb()
          .from('users')
          .insert({
            name: body.name,
            email: body.userAccount.email,
            password_hash: passwordHash,
            role: 'OPERATOR',
            business_id: businessId,
          })
          .select('id'),
      );
      createdUserId = createdUser[0].id;
    }

    const row = toRow(body, businessId);
    row.user_id = createdUserId;

    const created = await run<unknown[]>(sb().from('employees').insert(row).select('*'));
    res.status(201).json(camelize(created[0]));
  }),
);

/** PATCH /api/employees/:id */
employeesRouter.patch(
  '/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const body = parseBody(employeeSchema.partial(), req);
    const patch = toRow(body);

    let query = sb().from('employees').select('id, user_id').eq('id', req.params.id);
    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      query = query.eq('business_id', businessId);
    }

    const currentEmployees = await run<{ id: string; user_id: string | null }[]>(query.limit(1));
    const currentEmployee = currentEmployees[0];
    if (!currentEmployee) throw HttpError.notFound('Empleado no encontrado');

    if (body.userAccount) {
      const passwordHash = await bcrypt.hash(body.userAccount.password, 10);
      if (currentEmployee.user_id) {
        await run(
          sb()
            .from('users')
            .update({
              email: body.userAccount.email,
              password_hash: passwordHash,
            })
            .eq('id', currentEmployee.user_id),
        );
      } else {
        const existing = await run<{ id: string }[]>(
          sb().from('users').select('id').eq('email', body.userAccount.email).limit(1),
        );
        if (existing[0]) {
          throw HttpError.conflict('Ya existe un usuario con ese correo electrónico');
        }

        const createdUser = await run<{ id: string }[]>(
          sb()
            .from('users')
            .insert({
              name: body.name ?? 'Empleado',
              email: body.userAccount.email,
              password_hash: passwordHash,
              role: 'OPERATOR',
              business_id: businessId,
            })
            .select('id'),
        );
        patch.user_id = createdUser[0].id;
      }
    }

    if (Object.keys(patch).length === 0 && !body.userAccount) {
      throw HttpError.badRequest('No hay cambios que aplicar');
    }

    if (Object.keys(patch).length > 0) {
      const updated = await run<unknown[]>(
        sb().from('employees').update(patch).eq('id', req.params.id).select('*'),
      );
      if (!updated[0]) throw HttpError.notFound('Empleado no encontrado');
      res.json(camelize(updated[0]));
      return;
    }

    const rows = await run<any[]>(
      sb().from('employees').select('*, users(email, active)').eq('id', req.params.id).limit(1),
    );
    res.json(camelize(rows[0]));
  }),
);

/** DELETE /api/employees/:id · se desactiva si tiene órdenes asociadas */
employeesRouter.delete(
  '/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const { count } = await sb()
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('employee_id', req.params.id);

    if ((count ?? 0) > 0) {
      let query = sb().from('employees').update({ status: 'INACTIVE' }).eq('id', req.params.id);
      if (businessId && req.user?.role !== 'SUPER_ADMIN') {
        query = query.eq('business_id', businessId);
      }
      const archived = await run<unknown[]>(query.select('*'));
      if (!archived[0]) throw HttpError.notFound('Empleado no encontrado');
      res.json({ archived: true, employee: camelize(archived[0]) });
      return;
    }

    let delQuery = sb().from('employees').delete().eq('id', req.params.id);
    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      delQuery = delQuery.eq('business_id', businessId);
    }
    const deleted = await run<unknown[]>(delQuery.select('id'));
    if (!deleted[0]) throw HttpError.notFound('Empleado no encontrado');
    res.status(204).send();
  }),
);
