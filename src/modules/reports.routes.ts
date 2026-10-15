import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { camelize } from '../lib/case';
import { rpc, run, sb } from '../lib/supabase';
import { getTenantId, requireAuth } from '../middleware/auth';
import { parseQuery } from '../middleware/validate';
import { resolveRange } from '../lib/dates';

export const reportsRouter = Router();

reportsRouter.use(requireAuth);

const rangeSchema = z.object({
  preset: z.enum(['today', 'week', 'month', 'year', 'custom']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

/** Rango resuelto + argumentos listos para las funciones SQL. */
function rangeOf(req: Request) {
  const range = resolveRange(parseQuery(rangeSchema, req));
  const businessId = getTenantId(req);
  return {
    info: { from: range.from, to: range.to, preset: range.preset },
    businessId,
    args: {
      p_from: range.from.toISOString(),
      p_to: range.to.toISOString(),
    },
  };
}

/**
 * Cada endpoint delega la agregación a una función SQL que ya devuelve
 * las claves en camelCase.
 */
const rangeReport = (path: string, fn: string, wrap?: (data: unknown) => object) =>
  reportsRouter.get(
    path,
    asyncHandler(async (req, res) => {
      const { info, args } = rangeOf(req);
      const data = await rpc<unknown>(fn, args);
      res.json({
        range: info,
        ...(wrap ? wrap(data) : (data as object)),
      });
    }),
  );

/** GET /api/reports/dashboard */
reportsRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const businessId = getTenantId(req);
    // Si el usuario es empleado (OPERATOR), SIEMPRE debe cargar exclusivamente su información
    if (req.user?.role === 'OPERATOR') {
      let empId = req.user.employeeId;
      if (!empId) {
        const { sb, run } = await import('../lib/supabase');
        const empRows = await run<any[]>(
          sb().from('employees').select('id').eq('user_id', req.user.id).limit(1),
        );
        empId = empRows[0]?.id ?? null;
      }
      if (empId) {
        const employeeData = await rpc<any>('report_dashboard_employee', { p_employee_id: empId });
        res.json(typeof employeeData === 'object' && employeeData !== null ? employeeData : {});
        return;
      }
      // Si no tiene empleado asignado, retornar estructura vacía segura sin revelar datos administrativos
      res.json({
        kpis: {
          waiting: 0,
          inProgress: 0,
          ready: 0,
          finishedToday: 0,
          servicesToday: 0,
          earningsToday: 0,
          earningsMonth: 0,
          tipsToday: 0,
        },
        activeVehicles: [],
        latestOrders: [],
      });
      return;
    }

    const adminDashboard = await rpc<any>('report_dashboard', { p_business_id: businessId ?? null });
    res.json(typeof adminDashboard === 'object' && adminDashboard !== null ? adminDashboard : {});
  }),
);

/** GET /api/reports/employee-earnings · ganancias y comisiones (50%) de un empleado */
reportsRouter.get(
  '/employee-earnings',
  asyncHandler(async (req, res) => {
    const { info, args } = rangeOf(req);
    let employeeId =
      req.user?.role === 'OPERATOR'
        ? req.user.employeeId
        : (req.query.employeeId as string | undefined);

    if (req.user?.role === 'OPERATOR' && !employeeId) {
      const { sb, run } = await import('../lib/supabase');
      const empRows = await run<any[]>(
        sb().from('employees').select('id').eq('user_id', req.user.id).limit(1),
      );
      employeeId = empRows[0]?.id ?? undefined;
    }

    if (!employeeId) {
      res.json({
        range: info,
        summary: {
          ordersCount: 0,
          servicesCount: 0,
          servicesTotal: 0,
          commissionTotal: 0,
          companyTotal: 0,
          tipsTotal: 0,
          payoutTotal: 0,
        },
        items: [],
      });
      return;
    }

    const data = await rpc<Record<string, unknown>>('report_employee_earnings', {
      p_employee_id: employeeId,
      p_from: args.p_from,
      p_to: args.p_to,
    });

    res.json({ range: info, ...data });
  }),
);

function extractMetaFromNotes(notes: string | null) {
  if (!notes) return { supplier: null, quantity: null, cleanNotes: null };
  let supplier: string | null = null;
  let quantity: string | null = null;
  const match = notes.match(/^\[(.*?)\]\s*(.*)$/);
  if (match) {
    const metaStr = match[1];
    const clean = match[2] || null;
    const qMatch = metaStr.match(/Cant:\s*([^|]+)/);
    if (qMatch) quantity = qMatch[1].trim();
    const pMatch = metaStr.match(/Prov:\s*([^|]+)/);
    if (pMatch) supplier = pMatch[1].trim();
    return { supplier, quantity, cleanNotes: clean };
  }
  return { supplier: null, quantity: null, cleanNotes: notes };
}

/** GET /api/reports/sales · Ventas, comisiones 50/50 y deducción de gastos/compras a la empresa */
reportsRouter.get(
  '/sales',
  asyncHandler(async (req, res) => {
    const { info, args, businessId } = rangeOf(req);
    const data = await rpc<any>('report_sales', args);

    // Consultar gastos y compras del mismo período usando select('*') para máxima compatibilidad
    let expQuery = sb()
      .from('expenses')
      .select('*')
      .gte('spent_at', args.p_from)
      .lte('spent_at', args.p_to)
      .order('spent_at', { ascending: false });

    if (businessId && req.user?.role !== 'SUPER_ADMIN') {
      expQuery = expQuery.eq('business_id', businessId);
    }

    const expRows = (await run<any[]>(expQuery)) || [];

    const mappedExpenses = expRows.map((row) => {
      const meta = extractMetaFromNotes(row.notes);
      return {
        ...row,
        supplier: row.supplier || meta.supplier,
        quantity: row.quantity || meta.quantity,
        notes: meta.cleanNotes ?? row.notes,
      };
    });

    const totalExpenses = mappedExpenses.reduce((acc, row) => acc + Number(row.amount || 0), 0);
    const suppliesExpenses = mappedExpenses
      .filter((row) => row.category === 'SUPPLIES')
      .reduce((acc, row) => acc + Number(row.amount || 0), 0);
    const otherExpenses = totalExpenses - suppliesExpenses;

    const summary = data?.summary || {};
    const totalSales = Number(summary.total || 0);
    const tips = Number(summary.tips || 0);
    const netSales = Math.max(0, totalSales - tips);

    // 50% empresa y 50% empleados (sobre ingresos de servicios)
    const companyGross = Math.round(netSales * 0.5);
    const employeeCommission = Math.round(netSales * 0.5);

    // Las compras y gastos de la empresa se descuentan ÚNICAMENTE de los ingresos de la empresa
    const companyNet = companyGross - totalExpenses;

    // Asegurar que byDay y byVehicleType tengan company/employee totals garantizados
    const byDay = (data?.byDay || []).map((d: any) => ({
      ...d,
      companySales: d.companySales ?? Math.round(Number(d.sales || 0) * 0.5),
      employeeCommission: d.employeeCommission ?? Math.round(Number(d.sales || 0) * 0.5),
    }));

    const byVehicleType = (data?.byVehicleType || []).map((v: any) => ({
      ...v,
      companyTotal: v.companyTotal ?? Math.round(Number(v.total || 0) * 0.5),
      commissionTotal: v.commissionTotal ?? Math.round(Number(v.total || 0) * 0.5),
    }));

    res.json({
      range: info,
      ...data,
      byDay,
      byVehicleType,
      summary: {
        ...summary,
        total: totalSales,
        companyGross,
        employeeCommission,
        companyTotal: companyGross,
        commissionTotal: employeeCommission,
        totalExpenses,
        suppliesExpenses,
        otherExpenses,
        companyNet,
      },
      expenses: {
        total: totalExpenses,
        supplies: suppliesExpenses,
        other: otherExpenses,
        count: mappedExpenses.length,
        items: camelize(mappedExpenses),
      },
    });
  }),
);
rangeReport('/services', 'report_services');
rangeReport('/tips', 'report_tips');
rangeReport('/payment-methods', 'report_payment_methods');
rangeReport('/cash', 'report_cash');

// Estos dos devuelven un array: se envuelve en { data }
rangeReport('/customers', 'report_customers', (data) => ({ data }));
rangeReport('/employees', 'report_employees', (data) => ({ data }));

/** GET /api/reports/employee/:employeeId/orders · órdenes de un empleado. */
reportsRouter.get(
  '/employee/:employeeId/orders',
  asyncHandler(async (req, res) => {
    const { info, args } = rangeOf(req);
    const data = await rpc<unknown>('report_employee_orders', {
      p_employee_id: req.params.employeeId,
      p_from: args.p_from,
      p_to: args.p_to,
    });
    res.json({ range: info, data });
  }),
);

/** GET /api/reports/customer/:customerId/orders · órdenes de un cliente. */
reportsRouter.get(
  '/customer/:customerId/orders',
  asyncHandler(async (req, res) => {
    const { info, args } = rangeOf(req);
    const data = await rpc<unknown>('report_customer_orders', {
      p_customer_id: req.params.customerId,
      p_from: args.p_from,
      p_to: args.p_to,
    });
    res.json({ range: info, data });
  }),
);
