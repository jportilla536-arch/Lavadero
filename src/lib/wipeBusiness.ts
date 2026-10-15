import { run, sb } from './supabase';
import { HttpError } from './http';

export interface WipeBusinessOptions {
  wipeCatalog?: boolean;
  wipeEmployees?: boolean;
}

export interface WipeResult {
  deletedOrders: number;
  deletedCustomers: number;
  wipeCatalog: boolean;
  wipeEmployees: boolean;
}

/**
 * Vacía de forma segura y en orden de restricciones de integridad
 * todos los datos operativos de una empresa específica sin afectar a otras.
 */
export async function wipeBusinessData(
  businessId: string,
  options: WipeBusinessOptions = {},
): Promise<WipeResult> {
  // 1. Verificar existencia de la empresa
  const [business] = await run<{ id: string; name: string }[]>(
    sb().from('businesses').select('id, name').eq('id', businessId).limit(1),
  );
  if (!business) {
    throw HttpError.notFound('Establecimiento no encontrado');
  }

  // 2. Obtener órdenes asociadas al negocio
  const orders = await run<{ id: string }[]>(
    sb().from('orders').select('id').eq('business_id', businessId),
  );
  const orderIds = orders.map((o) => o.id);

  // 3. Eliminar facturas electrónicas (tienen FK restrict hacia orders)
  await run(sb().from('electronic_invoices').delete().eq('business_id', businessId));
  if (orderIds.length > 0) {
    for (let i = 0; i < orderIds.length; i += 100) {
      const chunk = orderIds.slice(i, i + 100);
      await run(sb().from('electronic_invoices').delete().in('order_id', chunk));
    }
  }

  // 4. Eliminar dependencias directas de las órdenes (items, evidencias, eventos, pagos)
  if (orderIds.length > 0) {
    for (let i = 0; i < orderIds.length; i += 100) {
      const chunk = orderIds.slice(i, i + 100);
      await run(sb().from('order_items').delete().in('order_id', chunk));
      await run(sb().from('order_evidences').delete().in('order_id', chunk));
      await run(sb().from('order_events').delete().in('order_id', chunk));
      await run(sb().from('payments').delete().in('order_id', chunk));
    }
  }

  // 5. Eliminar las órdenes
  await run(sb().from('orders').delete().eq('business_id', businessId));

  // 6. Eliminar liquidaciones de empleados y gastos del negocio
  await run(sb().from('employee_payouts').delete().eq('business_id', businessId));
  await run(sb().from('expenses').delete().eq('business_id', businessId));

  // 7. Eliminar clientes y sus vehículos asociados
  const customers = await run<{ id: string }[]>(
    sb().from('customers').select('id').eq('business_id', businessId),
  );
  const customerIds = customers.map((c) => c.id);
  if (customerIds.length > 0) {
    for (let i = 0; i < customerIds.length; i += 100) {
      const chunk = customerIds.slice(i, i + 100);
      await run(sb().from('vehicles').delete().in('customer_id', chunk));
    }
  }
  await run(sb().from('customers').delete().eq('business_id', businessId));

  // 8. Opcional: Catálogo de servicios y promociones
  if (options.wipeCatalog) {
    await run(sb().from('services').delete().eq('business_id', businessId));
    await run(sb().from('promotions').delete().eq('business_id', businessId));
  }

  // 9. Opcional: Empleados operativos (no elimina cuentas de usuario de acceso/login)
  if (options.wipeEmployees) {
    await run(sb().from('employees').delete().eq('business_id', businessId));
  }

  return {
    deletedOrders: orderIds.length,
    deletedCustomers: customerIds.length,
    wipeCatalog: Boolean(options.wipeCatalog),
    wipeEmployees: Boolean(options.wipeEmployees),
  };
}
