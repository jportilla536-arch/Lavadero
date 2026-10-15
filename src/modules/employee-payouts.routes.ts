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

function parsePayoutFromExpense(
  e: any,
  employeesMap: Record<string, string>,
): {
  id: string;
  employeeId: string;
  employeeName: string;
  amount: number;
  payoutType: string;
  payoutTypeLabel: string;
  method: string;
  paidAt: string;
  periodFrom: string | null;
  periodTo: string | null;
  notes: string;
  expenseId: string;
} {
  const notesStr = e.notes || '';
  let employeeId = e.employee_id || '';
  let payoutType = 'COMMISSION';
  let method = 'CASH';
  let periodFrom: string | null = null;
  let periodTo: string | null = null;
  let cleanNotes = notesStr;

  // Extract structured tags like [EmpID: ...|Type: ...|Method: ...|From: ...|To: ...]
  const bracketMatch = notesStr.match(/^\[(.*?)\]\s*(.*)$/);
  if (bracketMatch) {
    const meta = bracketMatch[1];
    cleanNotes = bracketMatch[2] || '';
    const parts = meta.split('|');
    for (const part of parts) {
      const idx = part.indexOf(':');
      if (idx > -1) {
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k === 'EmpID') employeeId = v;
        if (k === 'Type') payoutType = v;
        if (k === 'Method') method = v;
        if (k === 'From') periodFrom = v;
        if (k === 'To') periodTo = v;
      }
    }
  } else if (!employeeId) {
    const idMatch = notesStr.match(/EmpID:\s*([0-9a-fA-F-]+)/i);
    if (idMatch) {
      employeeId = idMatch[1];
    }
  }

  // If still no employeeId, check if concept or notes mentions an employee name
  if (!employeeId) {
    const hay = `${e.concept || ''} ${notesStr}`.toLowerCase();
    for (const [id, name] of Object.entries(employeesMap)) {
      if (name && hay.includes(name.toLowerCase())) {
        employeeId = id;
        break;
      }
    }
  }

  // Also check if concept mentions type, e.g. (Adelanto), (Sueldo base), etc.
  if (payoutType === 'COMMISSION' && e.concept) {
    for (const [key, label] of Object.entries(PAYOUT_TYPE_LABELS)) {
      if (e.concept.includes(label) || e.concept.toLowerCase().includes(key.toLowerCase())) {
        payoutType = key;
        break;
      }
    }
  }

  const employeeName = employeesMap[employeeId] || 'Empleado';

  return {
    id: e.id,
    employeeId,
    employeeName,
    amount: Number(e.amount || 0),
    payoutType,
    payoutTypeLabel: PAYOUT_TYPE_LABELS[payoutType] || payoutType,
    method,
    paidAt: e.spent_at || e.paid_at || e.created_at,
    periodFrom,
    periodTo,
    notes: cleanNotes,
    expenseId: e.id,
  };
}

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

    const employeesMap: Record<string, string> = {};
    employees.forEach((emp) => {
      employeesMap[emp.id] = emp.name;
    });

    // 2. Obtener pagos registrados en el rango
    let payouts: any[] = [];
    try {
      let pQuery = sb()
        .from('employee_payouts')
        .select('*')
        .gte('paid_at', range.from.toISOString())
        .lte('paid_at', range.to.toISOString());
      if (businessId) pQuery = pQuery.eq('business_id', businessId);
      const rows = await run<any[]>(pQuery);
      payouts = rows.map((r) => ({
        id: r.id,
        employeeId: r.employee_id,
        employeeName: employeesMap[r.employee_id] || 'Empleado',
        amount: Number(r.amount || 0),
        payoutType: r.payout_type || 'COMMISSION',
        payoutTypeLabel: PAYOUT_TYPE_LABELS[r.payout_type] || r.payout_type,
        method: r.method || 'CASH',
        paidAt: r.paid_at,
        periodFrom: r.period_from,
        periodTo: r.period_to,
        notes: r.notes || '',
        expenseId: r.expense_id,
      }));
    } catch {
      // Fallback a expenses con categoría SALARY
      let expQuery = sb()
        .from('expenses')
        .select('*')
        .eq('category', 'SALARY')
        .gte('spent_at', range.from.toISOString())
        .lte('spent_at', range.to.toISOString());
      if (businessId) expQuery = expQuery.eq('business_id', businessId);
      const expRows = await run<any[]>(expQuery);
      payouts = expRows.map((e) => parsePayoutFromExpense(e, employeesMap));
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
          (p) => p.employeeId === emp.id,
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

      const rows = await run<any[]>(query);
      payouts = rows.map((r) => ({
        id: r.id,
        employeeId: r.employee_id,
        employeeName: employeesMap[r.employee_id] || 'Empleado',
        amount: Number(r.amount || 0),
        payoutType: r.payout_type || 'COMMISSION',
        payoutTypeLabel: PAYOUT_TYPE_LABELS[r.payout_type] || r.payout_type,
        method: r.method || 'CASH',
        paidAt: r.paid_at,
        periodFrom: r.period_from,
        periodTo: r.period_to,
        notes: r.notes || '',
        expenseId: r.expense_id,
      }));
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

      const expRows = await run<any[]>(expQuery);
      payouts = expRows.map((e) => parsePayoutFromExpense(e, employeesMap));

      if (parsed.employeeId) {
        payouts = payouts.filter((p) => p.employeeId === parsed.employeeId);
      }
    }

    res.json({
      range: { from: range.from, to: range.to, preset: range.preset },
      total: payouts.reduce((acc, p) => acc + Number(p.amount || 0), 0),
      count: payouts.length,
      data: camelize(payouts),
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

    // Etiqueta estructurada para guardar en expenses
    const metaTag = `[EmpID: ${body.employeeId}|Type: ${body.payoutType}|Method: ${body.method}|DeductCash: ${body.deductFromCash ? '1' : '0'}${body.periodFrom ? `|From: ${body.periodFrom}` : ''}${body.periodTo ? `|To: ${body.periodTo}` : ''}]`;
    const fullNotes = body.notes ? `${metaTag} ${body.notes}` : `${metaTag} Pago de liquidación / comisión`;

    let expenseId: string | null = null;
    let payoutRecord: any = null;

    // 1. Intentar registrar primero en employee_payouts si la tabla existe
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
      };
      if (businessId) payoutRow.business_id = businessId;

      const created = await run<any[]>(
        sb().from('employee_payouts').insert(payoutRow).select('*'),
      );
      payoutRecord = created[0];
    } catch {
      // Si la tabla employee_payouts no existe en la BD
    }

    // 2. Si descuenta de caja O si employee_payouts no existe (para asegurar persistencia)
    if (body.deductFromCash || !payoutRecord) {
      try {
        const expRow: Record<string, unknown> = {
          concept: `Pago a empleado: ${empName} (${typeLabel})`,
          category: 'SALARY',
          amount: body.amount,
          notes: fullNotes,
          spent_at: paidAtIso,
        };
        if (businessId) expRow.business_id = businessId;

        const createdExp = await run<any[]>(
          sb().from('expenses').insert(expRow).select('id'),
        );
        expenseId = createdExp[0]?.id ?? null;

        // Si tenemos registro en employee_payouts, vincularle el expense_id
        if (payoutRecord && expenseId) {
          try {
            await run(
              sb().from('employee_payouts').update({ expense_id: expenseId }).eq('id', payoutRecord.id),
            );
          } catch {}
        }
      } catch (err) {
        console.error('Error registrando gasto en caja para pago de empleado:', err);
      }
    }

    if (!payoutRecord) {
      payoutRecord = {
        id: expenseId || `temp-${Date.now()}`,
        employeeId: body.employeeId,
        amount: body.amount,
        payoutType: body.payoutType,
        method: body.method,
        paidAt: paidAtIso,
        notes: body.notes || '',
        expenseId,
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

    // Buscar si tiene expense_id asociado en employee_payouts
    let expenseId: string | null = null;
    let deletedFromPayouts = false;
    try {
      let query = sb().from('employee_payouts').select('expense_id').eq('id', id);
      if (businessId) query = query.eq('business_id', businessId);
      const rows = await run<any[]>(query);
      if (rows && rows.length > 0) {
        expenseId = rows[0]?.expense_id ?? null;
        let delQuery = sb().from('employee_payouts').delete().eq('id', id);
        if (businessId) delQuery = delQuery.eq('business_id', businessId);
        await run(delQuery);
        deletedFromPayouts = true;
      }
    } catch {
      // Ignorar si employee_payouts no existe
    }

    // Si no se eliminó de employee_payouts, entonces el id es directamente de expenses
    if (!deletedFromPayouts) {
      expenseId = id;
    }

    // Si tiene gasto en caja asociado o id es de expenses, eliminarlo para devolver el balance
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
