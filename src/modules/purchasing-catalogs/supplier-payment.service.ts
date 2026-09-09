import { getSupabaseConfig } from '../../core/database/supabase.client.js';

async function rpc(authorization: string, name: string, parameters: Record<string, unknown> = {}) {
  const config = getSupabaseConfig();
  if (!config) throw Error('Supabase no está configurado.');
  const response = await fetch(new URL(`/rest/v1/rpc/${name}`, config.url), {
    method: 'POST',
    headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(parameters)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw Error(data?.message || 'No fue posible procesar el pago.');
  return data;
}

export async function supplierPaymentOptions(authorization: string) {
  const [options, locks, advances] = await Promise.all([
    rpc(authorization, 'supplier_payment_options'),
    rpc(authorization, 'supplier_payment_request_locks'),
    rpc(authorization, 'supplier_available_advances')
  ]);
  return { ...options, paymentRequestLocks: locks, advances };
}

export async function supplierPaymentReport(authorization: string, filters: Record<string, unknown>) {
  const [report, summaries] = await Promise.all([
    rpc(authorization, 'supplier_payment_report', { p_filters: filters }),
    rpc(authorization, 'supplier_payment_advance_summary')
  ]);
  return {
    ...report,
    rows: (report.rows || []).map((row: Record<string, unknown>) => {
      const summary = summaries.find((item: Record<string, unknown>) => String(item.paymentId) === String(row.id));
      return { ...row, advanceTotal: summary?.advanceTotal || 0 };
    })
  };
}

export async function supplierPaymentDetail(authorization: string, id: number) {
  const [detail, advances] = await Promise.all([
    rpc(authorization, 'supplier_payment_detail', { p_payment_id: id }),
    rpc(authorization, 'supplier_payment_advance_detail', { p_payment_id: id })
  ]);
  return { ...detail, advances };
}

export const saveSupplierPayment = (authorization: string, payload: Record<string, unknown>, id?: number) =>
  rpc(authorization, 'save_supplier_payment_with_advances', { p_payload: payload, p_payment_id: id || null });
export const deleteSupplierPayment = (authorization: string, id: number) =>
  rpc(authorization, 'delete_supplier_payment', { p_payment_id: id });
