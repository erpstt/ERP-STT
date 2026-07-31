import type { CreateInvoiceDto } from '../dto/create-invoice.dto.js';
import type { InvoiceRepository } from '../repositories/invoice.repository.js';

export class InvoiceService {
  constructor(private readonly repository: InvoiceRepository) {}

  async create(tenantId: string, input: CreateInvoiceDto) {
    if (!input.items.length) throw new Error('Una factura debe contener al menos una línea.');
    return this.repository.create(tenantId, input);
  }
}
