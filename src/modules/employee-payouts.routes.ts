import { Router } from 'express';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { resolveRange } from '../lib/dates';
import { asyncHandler, HttpError } from '../lib/http';
import { run, sb, rpc } from '../lib/supabase';
import { getTenantId, requireAuth, requireRole } from '../middleware/auth';
import { parseBody, parseQuery } from '../middleware/validate';

export const employeePayoutsRouter = Router();

employeePayoutsRouter.use(requireAuth);
employeePayoutsRouter.use(requireRole('ADMIN', 'SUPER_ADMIN'));

const payoutTypes = ['COMMISSION', 'ADVANCE', 'TIP', 'SALARY', 'BONUS', 'OTHER'] as const;
const paymentMethods = ['CASH', 'TRANSFER', 'CARD', 'OTHER'] as const;

const payoutSchema = z.object({
  employeeId: z.string().uuid('ID de empleado no válido'),
  amount: z.coerce.number().int().min(1, 'El monto debe ser mayor a cero'),
  payoutType: z.enum(payoutTypes).default('COMMISSION'),
  method: z.enum(paymentMethods).default('CASH'),
  paidAt: z.string().min(1).optional(),
  periodFrom: z.string().optional().nullable(),
  periodTo: z.string().optional().nullable(),
  notes: z.string().trim().max(500).nullable().optional(),
  deductFromCash: z.boolean().default(true),
});

const PAYOUT_TYPE_LABELS: Record<string, string> = {
  COMMISSION: 'Liquidación de comisiones (50%)',
  ADVANCE: 'Adelanto / Anticipo',
  TIP: 'Entrega de propinas',
  SALARY: 'Sueldo base / Jornal',
  BONUS: 'Bonificación / Premio',
  OTHER: 'Otro concepto',
};

/**
 * GET /api/employee-payouts/summary
 * Devuelve el resumen financiero por cada empleado:
 * comisiones generadas, propinas, total pagado y saldo pendiente.
 */
employeePayoutsRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const parsed = parseQuery(
      z.object({
        preset: z.enum(['today', 'week', 'month', 'year', 'custom']).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      }),
      req,
    );
    const range = resolveRange(parsed);

    // 1. Obtener empleados
    let empQuery = sb().from('employees').select('id, name, position, status');
    if (businessId) empQuery = empQuery.eq('business_id', businessId);
    const employees = await run<any[]>(empQuery);

    // 2. Obtener pagos registrados en el rango
    let payouts: any[] = [];
    try {
      let pQuery = sb()
        .from('employee_payouts')
        .select('*')
        .gte('paid_at', range.from.toISOString())
        .lte('paid_at', range.to.toISOString());
      if (businessId) pQuery = pQuery.eq('business_id', businessId);
      payouts = await run<any[]>(pQuery);
    } catch {
      // Si la tabla employee_payouts no está creada aún en Supabase, consultar expenses (SALARY)
      let expQuery = sb()
        .from('expenses')
        .select('*')
        .eq('category', 'SALARY')
        .gte('spent_at', range.from.toISOString())
        .lte('spent_at', range.to.toISOString());
      if (businessId) expQuery = expQuery.eq('business_id', businessId);
      const expRows = await run<any[]>(expQuery);
      payouts = expRows.map((e) => ({
        id: e.id,
        employee_id: e.employee_id,
        amount: e.amount,
        paid_at: e.spent_at,
        notes: e.notes,
        payout_type: 'COMMISSION',
        method: 'CASH',
      }));
    }

    // 3. Para cada empleado, calcular lo generado en órdenes finalizadas
    const summaries = await Promise.all(
      employees.map(async (emp) => {
        let earnedData: any = { commissionTotal: 0, tipsTotal: 0, ordersCount: 0, servicesTotal: 0 };
        try {
          const report = await rpc<any>('report_employee_earnings', {
            p_employee_id: emp.id,
            p_from: range.from.toISOString(),
            p_to: range.to.toISOString(),
          });
          if (report?.summary) {
            earnedData = report.summary;
          }
        } catch {
          // Fallback seguro si falla RPC
        }

        const empPayouts = payouts.filter(
          (p) => p.employee_id === emp.id || (p.notes && p.notes.includes(emp.id)),
        );
        const totalPaid = empPayouts.reduce((acc, p) => acc + Number(p.amount || 0), 0);
        const totalEarned = Number(earnedData.commissionTotal || 0) + Number(earnedData.tipsTotal || 0);
        const pendingBalance = totalEarned - totalPaid;

        return {
          employeeId: emp.id,
          employeeName: emp.name,
          position: emp.position,
          status: emp.status,
          ordersCount: earnedData.ordersCount || 0,
          servicesTotal: earnedData.servicesTotal || 0,
          commissionTotal: earnedData.commissionTotal || 0,
          tipsTotal: earnedData.tipsTotal || 0,
          totalEarned,
          totalPaid,
          pendingBalance,
          payoutsCount: empPayouts.length,
        };
      }),
    );

    res.json({
      range: { from: range.from, to: range.to, preset: range.preset },
      data: summaries,
      totalEarned: summaries.reduce((acc, s) => acc + s.totalEarned, 0),
      totalPaid: summaries.reduce((acc, s) => acc + s.totalPaid, 0),
      totalPending: summaries.reduce((acc, s) => acc + s.pendingBalance, 0),
    });
  }),
);

/**
 * GET /api/employee-payouts
 * Lista de pagos a empleados en un rango de fechas.
 */
employeePayoutsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const parsed = parseQuery(
      z.object({
        preset: z.enum(['today', 'week', 'month', 'year', 'custom']).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        employeeId: z.string().optional(),
      }),
      req,
    );
    const range = resolveRange(parsed);

    let employeesMap: Record<string, string> = {};
    try {
      let empQuery = sb().from('employees').select('id, name');
      if (businessId) empQuery = empQuery.eq('business_id', businessId);
      const emps = await run<any[]>(empQuery);
      emps.forEach((e) => {
        employeesMap[e.id] = e.name;
      });
    } catch {}

    let payouts: any[] = [];
    try {
      let query = sb()
        .from('employee_payouts')
        .select('*')
        .gte('paid_at', range.from.toISOString())
        .lte('paid_at', range.to.toISOString())
        .order('paid_at', { ascending: false });

      if (businessId) query = query.eq('business_id', businessId);
      if (parsed.employeeId) query = query.eq('employee_id', parsed.employeeId);

      payouts = await run<any[]>(query);
    } catch {
      // Fallback a tabla expenses con categoría SALARY
      let expQuery = sb()
        .from('expenses')
        .select('*')
        .eq('category', 'SALARY')
        .gte('spent_at', range.from.toISOString())
        .lte('spent_at', range.to.toISOString())
        .order('spent_at', { ascending: false });

      if (businessId) expQuery = expQuery.eq('business_id', businessId);
      if (parsed.employeeId) expQuery = expQuery.eq('employee_id', parsed.employeeId);

      const expRows = await run<any[]>(expQuery);
      payouts = expRows.map((e) => ({
        id: e.id,
        employee_id: e.employee_id,
        amount: e.amount,
        payout_type: 'COMMISSION',
        method: 'CASH',
        paid_at: e.spent_at,
        notes: e.notes,
        expense_id: e.id,
      }));
    }

    const data = payouts.map((p) => ({
      ...p,
      employeeName: employeesMap[p.employee_id] ?? 'Empleado',
      payoutTypeLabel: PAYOUT_TYPE_LABELS[p.payout_type] ?? p.payout_type,
    }));

    res.json({
      range: { from: range.from, to: range.to, preset: range.preset },
      total: payouts.reduce((acc, p) => acc + Number(p.amount || 0), 0),
      count: payouts.length,
      data: camelize(data),
    });
  }),
);

/**
 * POST /api/employee-payouts
 * Registrar un nuevo pago a un empleado.
 * Si deductFromCash es true (por defecto), se crea un gasto en public.expenses
 * para que se descuente automáticamente de la caja del administrador.
 */
employeePayoutsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const body = parseBody(payoutSchema, req);

    // Obtener nombre del empleado
    let empName = 'Empleado';
    try {
      const empRes = await run<any[]>(
        sb().from('employees').select('name').eq('id', body.employeeId).limit(1),
      );
      if (empRes[0]?.name) empName = empRes[0].name;
    } catch {}

    const paidAtIso = body.paidAt ? new Date(body.paidAt).toISOString() : new Date().toISOString();
    const typeLabel = PAYOUT_TYPE_LABELS[body.payoutType] ?? body.payoutType;

    // 1. Si descuenta de caja, registrar gasto en public.expenses
    let expenseId: string | null = null;
    if (body.deductFromCash) {
      try {
        const expRow: Record<string, unknown> = {
          concept: `Pago a empleado: ${empName} (${typeLabel})`,
          category: 'SALARY',
          amount: body.amount,
          notes: body.notes ? `[EmpID: ${body.employeeId}] ${body.notes}` : `[EmpID: ${body.employeeId}] Pago de liquidación / comisión`,
          spent_at: paidAtIso,
        };
        if (businessId) expRow.business_id = businessId;

        const createdExp = await run<any[]>(
          sb().from('expenses').insert(expRow).select('id'),
        );
        expenseId = createdExp[0]?.id ?? null;
      } catch (err) {
        console.error('Error registrando gasto en caja para pago de empleado:', err);
      }
    }

    // 2. Insertar en employee_payouts
    let payoutRecord: any = null;
    try {
      const payoutRow: Record<string, unknown> = {
        employee_id: body.employeeId,
        amount: body.amount,
        payout_type: body.payoutType,
        method: body.method,
        paid_at: paidAtIso,
        period_from: body.periodFrom ? new Date(body.periodFrom).toISOString() : null,
        period_to: body.periodTo ? new Date(body.periodTo).toISOString() : null,
        notes: body.notes || null,
        expense_id: expenseId,
      };
      if (businessId) payoutRow.business_id = businessId;

      const created = await run<any[]>(
        sb().from('employee_payouts').insert(payoutRow).select('*'),
      );
      payoutRecord = created[0];
    } catch {
      // Fallback si la tabla employee_payouts aún no existe en Supabase
      payoutRecord = {
        id: expenseId || `temp-${Date.now()}`,
        employee_id: body.employeeId,
        amount: body.amount,
        payout_type: body.payoutType,
        method: body.method,
        paid_at: paidAtIso,
        notes: body.notes,
        expense_id: expenseId,
      };
    }

    res.status(201).json(
      camelize({
        ...payoutRecord,
        employeeName: empName,
        payoutTypeLabel: typeLabel,
      }),
    );
  }),
);

/**
 * DELETE /api/employee-payouts/:id
 * Anula/elimina un pago y revierte el gasto en caja si existía.
 */
employeePayoutsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    const { id } = req.params;

    // Buscar si tiene expense_id asociado
    let expenseId: string | null = null;
    try {
      let query = sb().from('employee_payouts').select('expense_id').eq('id', id);
      if (businessId) query = query.eq('business_id', businessId);
      const rows = await run<any[]>(query);
      expenseId = rows[0]?.expense_id ?? null;

      // Eliminar de employee_payouts
      let delQuery = sb().from('employee_payouts').delete().eq('id', id);
      if (businessId) delQuery = delQuery.eq('business_id', businessId);
      await run(delQuery);
    } catch {
      // Si el id era directamente de expenses
      expenseId = id;
    }

    // Si tiene gasto en caja, eliminarlo para devolver el balance
    if (expenseId) {
      try {
        let delExp = sb().from('expenses').delete().eq('id', expenseId);
        if (businessId) delExp = delExp.eq('business_id', businessId);
        await run(delExp);
      } catch {}
    }

    res.status(204).send();
  }),
);
