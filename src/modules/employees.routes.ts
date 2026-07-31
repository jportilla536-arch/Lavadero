import { Router } from 'express';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { asyncHandler, HttpError } from '../lib/http';
import { rpc, run, sb } from '../lib/supabase';
import { requireAuth, requireRole } from '../middleware/auth';
import { parseBody } from '../middleware/validate';
import { EMPLOYEE_STATUSES } from '../types';

const employeeSchema = z.object({
  name: z.string().trim().min(2, 'Nombre requerido').max(80),
  position: z.string().trim().max(60).default('Lavador'),
  phone: z.string().trim().max(30).nullable().optional(),
  status: z.enum(EMPLOYEE_STATUSES).default('ACTIVE'),
  hiredAt: z.string().date().nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
});

type EmployeeInput = z.output<typeof employeeSchema>;

function toRow(input: Partial<EmployeeInput>) {
  const row: Record<string, unknown> = {};
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
    res.json(
      await rpc<unknown[]>('list_employees', {
        p_only_active: req.query.onlyActive === 'true',
        p_working_only: false,
      }),
    );
  }),
);

/** GET /api/employees/working · solo quienes tienen órdenes en curso */
employeesRouter.get(
  '/working',
  asyncHandler(async (_req, res) => {
    res.json(
      await rpc<unknown[]>('list_employees', { p_only_active: true, p_working_only: true }),
    );
  }),
);

/** GET /api/employees/:id */
employeesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const employee = await rpc<unknown>('employee_detail', { p_id: req.params.id });
    if (!employee) throw HttpError.notFound('Empleado no encontrado');
    res.json(employee);
  }),
);

/** POST /api/employees */
employeesRouter.post(
  '/',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const body = parseBody(employeeSchema, req);
    const created = await run<unknown[]>(sb().from('employees').insert(toRow(body)).select('*'));
    res.status(201).json(camelize(created[0]));
  }),
);

/** PATCH /api/employees/:id */
employeesRouter.patch(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const body = parseBody(employeeSchema.partial(), req);
    const patch = toRow(body);
    if (Object.keys(patch).length === 0) throw HttpError.badRequest('No hay cambios que aplicar');

    const updated = await run<unknown[]>(
      sb().from('employees').update(patch).eq('id', req.params.id).select('*'),
    );
    if (!updated[0]) throw HttpError.notFound('Empleado no encontrado');
    res.json(camelize(updated[0]));
  }),
);

/** DELETE /api/employees/:id · se desactiva si tiene órdenes asociadas */
employeesRouter.delete(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const { count } = await sb()
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('employee_id', req.params.id);

    if ((count ?? 0) > 0) {
      const archived = await run<unknown[]>(
        sb().from('employees').update({ status: 'INACTIVE' }).eq('id', req.params.id).select('*'),
      );
      if (!archived[0]) throw HttpError.notFound('Empleado no encontrado');
      res.json({ archived: true, employee: camelize(archived[0]) });
      return;
    }

    const deleted = await run<unknown[]>(
      sb().from('employees').delete().eq('id', req.params.id).select('id'),
    );
    if (!deleted[0]) throw HttpError.notFound('Empleado no encontrado');
    res.status(204).send();
  }),
);
