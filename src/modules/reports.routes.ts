import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { rpc } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
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
  return {
    info: { from: range.from, to: range.to, preset: range.preset },
    args: { p_from: range.from.toISOString(), p_to: range.to.toISOString() },
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
      res.json({ range: info, ...(wrap ? wrap(data) : (data as object)) });
    }),
  );

/** GET /api/reports/dashboard */
reportsRouter.get(
  '/dashboard',
  asyncHandler(async (_req, res) => {
    res.json(await rpc('report_dashboard'));
  }),
);

rangeReport('/sales', 'report_sales');
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
      ...args,
      p_employee_id: req.params.employeeId,
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
      ...args,
      p_customer_id: req.params.customerId,
    });
    res.json({ range: info, data });
  }),
);

