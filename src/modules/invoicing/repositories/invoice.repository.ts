import type { CreateInvoiceDto } from '../dto/create-invoice.dto.js';

export interface InvoiceRepository {
  create(tenantId: string, invoice: CreateInvoiceDto): Promise<{ id: string }>;
}
