import { HttpError } from '../../lib/http';
import type { PaymentMethod } from '../../types';
import type { FactusPayload } from './types';

export interface InvoiceSource {
  order: {
    number: string;
    subtotal: number;
    discountTotal: number;
    promotionTotal: number;
    tip: number;
    total: number;
    notes: string | null;
  };
  customer: {
    firstName: string;
    lastName: string;
    phone: string | null;
    email: string | null;
    identificationDocumentCode: string | null;
    identification: string | null;
    address: string | null;
    municipalityCode: string | null;
    legalOrganizationCode: string | null;
    tributeCode: string | null;
  };
  business: {
    numberingRangeId: number;
    document: string;
    operationType: string;
    sendEmail: boolean;
    taxId: string | null;
    taxRate: number;
  };
  items: Array<{ id: string; name: string; price: number; quantity: number }>;
  payments: Array<{ method: PaymentMethod; amount: number; reference: string | null }>;
}

const PAYMENT_METHOD_CODES: Record<PaymentMethod, string> = {
  CASH: '10',
  CARD: '48',
  TRANSFER: '47',
  YAPE: '47',
  PLIN: '47',
};
function required(value: string | null, label: string): string {
  if (!value?.trim()) throw new HttpError(422, `Falta ${label} para emitir la factura electrónica`);
  return value.trim();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildFactusPayload(source: InvoiceSource): FactusPayload {
  const { order, customer, business } = source;
  if (!business.numberingRangeId) {
    throw new HttpError(422, 'Configura el rango de numeración de Factus');
  }
  if (source.items.length === 0) throw new HttpError(422, 'La orden no tiene servicios facturables');
  if (order.subtotal <= 0 || order.total <= 0) {
    throw new HttpError(422, 'La orden debe tener un total positivo');
  }

  const discount = order.discountTotal + order.promotionTotal;
  if (discount < 0 || discount > order.subtotal) {
    throw new HttpError(422, 'Los descuentos de la orden no son válidos');
  }
  const discountRate = ((discount / order.subtotal) * 100).toFixed(4);
  const taxes = business.taxId
    ? [{ tax_id: business.taxId, tax_rate: business.taxRate.toFixed(2) }]
    : [{ is_excluded: true as const }];

  const items: FactusPayload['items'] = source.items.map((item) => ({
    scheme_id: '0',
    code_reference: item.id,
    name: item.name,
    quantity: item.quantity.toFixed(2),
    discount_rate: discountRate,
    price: item.price.toFixed(2),
    unit_measure_code: '94',
    standard_code: '999',
    taxes,
  }));
  if (order.tip > 0) {
    items.push({
      scheme_id: '0',
      code_reference: `TIP-${order.number}`,
      name: 'Propina voluntaria',
      quantity: '1.00',
      discount_rate: '0.00',
      price: order.tip.toFixed(2),
      unit_measure_code: '94',
      standard_code: '999',
      taxes: [{ is_excluded: true }],
    });
  }

  let remaining = order.total;
  const paymentDetails: FactusPayload['payment_details'] = [];
  for (const [index, payment] of source.payments.entries()) {
    const amount = Math.min(Math.max(payment.amount, 0), remaining);
    if (amount <= 0) continue;
    paymentDetails.push({
      payment_form: 1,
      payment_method_code: PAYMENT_METHOD_CODES[payment.method],
      reference_code: payment.reference || `${order.number}-${index + 1}`,
      amount: amount.toFixed(2),
      due_date: today(),
    });
    remaining -= amount;
  }
  if (remaining !== 0 || paymentDetails.length === 0) {
    throw new HttpError(422, 'Los pagos de la orden no cubren exactamente el valor facturable');
  }

  return {
    reference_code: order.number,
    document: business.document,
    numbering_range_id: business.numberingRangeId,
    operation_type: business.operationType,
    send_email: business.sendEmail,
    observation: order.notes ?? '',
    payment_details: paymentDetails,
    customer: {
      identification_document_code: required(customer.identificationDocumentCode, 'el tipo de documento del cliente'),
      identification: required(customer.identification, 'el documento del cliente'),
      names: `${customer.firstName} ${customer.lastName}`.trim(),
      address: required(customer.address, 'la dirección del cliente'),
      email: required(customer.email, 'el correo del cliente'),
      phone: required(customer.phone, 'el teléfono del cliente'),
      legal_organization_code: required(customer.legalOrganizationCode, 'la organización legal del cliente'),
      tribute_code: required(customer.tributeCode, 'el tributo del cliente'),
      municipality_code: required(customer.municipalityCode, 'el municipio DANE del cliente'),
    },
    items,
  };
}