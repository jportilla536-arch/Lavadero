import { Router } from 'express';
import { z } from 'zod';
import { camelize } from '../lib/case';
import { resolveRange } from '../lib/dates';
import { asyncHandler, HttpError } from '../lib/http';
import { rpc, run, sb } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { parseBody, parseQuery } from '../middleware/validate';
import {
  DAMAGE_TYPES,
  DISCOUNT_TYPES,
  EVIDENCE_STAGES,
  ORDER_STATUSES,
  PAYMENT_METHODS,
  type OrderStatus,
} from '../types';

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

// ---------------------------------------------------------------------
// Esquemas
// ---------------------------------------------------------------------

const itemInput = z.object({
  serviceId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  price: z.coerce.number().int().min(0).optional(),
  quantity: z.coerce.number().int().min(1).max(50).default(1),
  durationMin: z.coerce.number().int().min(0).max(1440).optional(),
  employeeId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(300).nullable().optional(),
});

const evidenceInput = z.object({
  url: z.string().url('URL de imagen inválida'),
  path: z.string().nullable().optional(),
  damageType: z.enum(DAMAGE_TYPES).default('NONE'),
  note: z.string().trim().max(300).nullable().optional(),
});

const createOrderInput = z.object({
  customerId: z.string().uuid('Selecciona un cliente'),
  vehicleId: z.string().uuid('Selecciona un vehículo'),
  employeeId: z.string().uuid().nullable().optional(),
  promotionId: z.string().uuid().nullable().optional(),
  discountType: z.enum(DISCOUNT_TYPES).default('AMOUNT'),
  discountValue: z.coerce.number().int().min(0).default(0),
  notes: z.string().trim().max(1000).nullable().optional(),
  items: z.array(itemInput).min(1, 'Agrega al menos un servicio'),
  evidences: z.array(evidenceInput.extend({ stage: z.enum(EVIDENCE_STAGES).default('INITIAL') })).optional(),
});

interface OrdersPage {
  data: unknown[];
  /** Cantidad de órdenes que cumplen el filtro */
  total: number;
  /** Suma en pesos de esas órdenes */
  totalAmount: number;
}

/** Nombre del usuario para la bitácora de la orden. */
const actor = (name?: string) => name ?? null;

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

/** GET /api/orders */
ordersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = parseQuery(
      z.object({
        status: z.string().optional(),
        q: z.string().trim().optional(),
        employeeId: z.string().uuid().optional(),
        preset: z.enum(['today', 'week', 'month', 'year', 'custom', 'all']).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
      req,
    );

    const statuses = (filters.status ?? '')
      .split(',')
      .map((status) => status.trim().toUpperCase())
      .filter((status): status is OrderStatus =>
        (ORDER_STATUSES as readonly string[]).includes(status),
      );

    const range = filters.preset === 'all' ? null : resolveRange(filters);

    let employeeId = filters.employeeId;
    if (req.user?.role === 'OPERATOR') {
      employeeId = req.user.employeeId ?? undefined;
    }

    const result = await rpc<OrdersPage>('search_orders', {
      p_statuses: statuses.length > 0 ? statuses : null,
      p_from: range ? range.from.toISOString() : null,
      p_to: range ? range.to.toISOString() : null,
      p_query: filters.q || null,
      p_employee: employeeId ?? null,
      p_limit: filters.pageSize,
      p_offset: (filters.page - 1) * filters.pageSize,
    });

    res.json({
      data: result.data,
      page: filters.page,
      pageSize: filters.pageSize,
      total: result.total,
      totalAmount: result.totalAmount,
    });
  }),
);

/** GET /api/orders/board · órdenes activas agrupadas por estado */
ordersRouter.get(
  '/board',
  asyncHandler(async (req, res) => {
    let employeeId: string | null = null;
    if (req.user?.role === 'OPERATOR') {
      employeeId = req.user.employeeId ?? null;
    }

    const result = await rpc<OrdersPage>('search_orders', {
      p_statuses: ['PENDING', 'IN_PROGRESS', 'READY'],
      p_employee: employeeId,
      p_limit: 200,
      p_offset: 0,
    });

    const data = result.data as { status: OrderStatus }[];

    res.json({
      PENDING: data.filter((order) => order.status === 'PENDING'),
      IN_PROGRESS: data.filter((order) => order.status === 'IN_PROGRESS'),
      READY: data.filter((order) => order.status === 'READY'),
    });
  }),
);

/** GET /api/orders/:id · acepta uuid o número de orden */
ordersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const order = await rpc<unknown>('order_detail', { p_ref: req.params.id });
    if (!order) throw HttpError.notFound('Orden no encontrada');
    res.json(order);
  }),
);

// ---------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------

/** POST /api/orders */
ordersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseBody(createOrderInput, req);

    const order = await rpc<unknown>('create_order', {
      payload: {
        customerId: body.customerId,
        vehicleId: body.vehicleId,
        employeeId: body.employeeId || null,
        promotionId: body.promotionId || null,
        discountType: body.discountType,
        discountValue: body.discountValue,
        notes: body.notes || null,
        items: body.items,
        evidences: body.evidences ?? [],
      },
      p_user: actor(req.user?.name),
    });

    res.status(201).json(order);
  }),
);

/** PATCH /api/orders/:id · empleado, notas, descuento, promoción */
ordersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        employeeId: z.string().uuid().nullable().optional(),
        promotionId: z.string().uuid().nullable().optional(),
        discountType: z.enum(DISCOUNT_TYPES).optional(),
        discountValue: z.coerce.number().int().min(0).optional(),
        notes: z.string().trim().max(1000).nullable().optional(),
      }),
      req,
    );

    // Solo se envían las claves presentes: la función SQL respeta el resto.
    const payload: Record<string, unknown> = {};
    for (const key of ['employeeId', 'promotionId', 'discountType', 'discountValue', 'notes'] as const) {
      if (key in req.body) payload[key] = body[key] ?? null;
    }

    const order = await rpc<unknown>('update_order', {
      p_order_id: req.params.id,
      payload,
      p_user: actor(req.user?.name),
    });

    res.json(order);
  }),
);

/** POST /api/orders/:id/items · agregar servicios sin crear otra orden */
ordersRouter.post(
  '/:id/items',
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ items: z.array(itemInput).min(1) }), req);

    const order = await rpc<unknown>('add_order_items', {
      p_order_id: req.params.id,
      p_items: body.items,
      p_user: actor(req.user?.name),
    });

    res.status(201).json(order);
  }),
);

/** DELETE /api/orders/:id/items/:itemId */
ordersRouter.delete(
  '/:id/items/:itemId',
  asyncHandler(async (req, res) => {
    const order = await rpc<unknown>('remove_order_item', {
      p_order_id: req.params.id,
      p_item_id: req.params.itemId,
      p_user: actor(req.user?.name),
    });
    res.json(order);
  }),
);

/** PATCH /api/orders/:id/status */
ordersRouter.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        status: z.enum(ORDER_STATUSES),
        reason: z.string().trim().max(300).optional(),
      }),
      req,
    );

    const order = await rpc<unknown>('set_order_status', {
      p_order_id: req.params.id,
      p_status: body.status,
      p_reason: body.reason ?? null,
      p_user: actor(req.user?.name),
    });

    res.json(order);
  }),
);

/** POST /api/orders/:id/evidences · registra fotos ya subidas a Storage */
ordersRouter.post(
  '/:id/evidences',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        stage: z.enum(EVIDENCE_STAGES).default('INITIAL'),
        items: z.array(evidenceInput).min(1, 'Agrega al menos una imagen'),
      }),
      req,
    );

    const order = await rpc<unknown>('add_order_evidences', {
      p_order_id: req.params.id,
      p_stage: body.stage,
      p_items: body.items,
      p_user: actor(req.user?.name),
    });

    res.status(201).json(order);
  }),
);

/** DELETE /api/orders/:id/evidences/:evidenceId */
ordersRouter.delete(
  '/:id/evidences/:evidenceId',
  asyncHandler(async (req, res) => {
    const deleted = await run<unknown[]>(
      sb()
        .from('order_evidences')
        .delete()
        .eq('id', req.params.evidenceId)
        .eq('order_id', req.params.id)
        .select('id'),
    );
    if (!deleted[0]) throw HttpError.notFound('Evidencia no encontrada');
    res.status(204).send();
  }),
);

/** POST /api/orders/:id/checkout · pagos, propina y finalización */
ordersRouter.post(
  '/:id/checkout',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        tip: z.coerce.number().int().min(0).default(0),
        discountType: z.enum(DISCOUNT_TYPES).optional(),
        discountValue: z.coerce.number().int().min(0).optional(),
        promotionId: z.string().uuid().nullable().optional(),
        requiresInvoice: z.boolean().default(false),
        payments: z
          .array(
            z.object({
              method: z.enum(PAYMENT_METHODS),
              amount: z.coerce.number().int().min(0),
              reference: z.string().trim().max(120).nullable().optional(),
            }),
          )
          .min(1, 'Selecciona al menos un método de pago'),
        finalEvidences: z
          .array(
            z.object({
              url: z.string().url(),
              path: z.string().nullable().optional(),
              note: z.string().trim().max(300).nullable().optional(),
            }),
          )
          .optional(),
      }),
      req,
    );

    const payload: Record<string, unknown> = {
      tip: body.tip,
      requiresInvoice: body.requiresInvoice,
      payments: body.payments,
      finalEvidences: body.finalEvidences ?? [],
    };
    if (body.discountType !== undefined) payload.discountType = body.discountType;
    if (body.discountValue !== undefined) payload.discountValue = body.discountValue;
    if ('promotionId' in req.body) payload.promotionId = body.promotionId ?? null;

    const order = await rpc<unknown>('checkout_order', {
      p_order_id: req.params.id,
      payload,
      p_user: actor(req.user?.name),
    });

    res.json(order);
  }),
);

/** POST /api/orders/:id/cancel */
ordersRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ reason: z.string().trim().min(3, 'Indica el motivo').max(300) }),
      req,
    );

    const order = await rpc<unknown>('cancel_order', {
      p_order_id: req.params.id,
      p_reason: body.reason,
      p_user: actor(req.user?.name),
    });

    res.json(order);
  }),
);
