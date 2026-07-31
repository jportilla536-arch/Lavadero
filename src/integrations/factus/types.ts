export type FactusJson = Record<string, unknown>;

export interface FactusPayload {
  reference_code: string;
  document: string;
  numbering_range_id: number;
  operation_type: string;
  send_email: boolean;
  observation: string;
  payment_details: Array<{
    payment_form: number;
    payment_method_code: string;
    reference_code: string;
    amount: string;
    due_date: string;
  }>;
  customer: {
    identification_document_code: string;
    identification: string;
    names: string;
    address: string;
    email: string;
    phone: string;
    legal_organization_code: string;
    tribute_code: string;
    municipality_code: string;
  };
  items: Array<{
    scheme_id: string;
    code_reference: string;
    name: string;
    quantity: string;
    discount_rate: string;
    price: string;
    unit_measure_code: string;
    standard_code: string;
    taxes: Array<{ tax_id: string; tax_rate: string } | { is_excluded: true }>;
  }>;
}
