import type { InvoiceService } from '../services/invoice.service.js';
import type { CreateInvoiceDto } from '../dto/create-invoice.dto.js';

export class InvoiceController {
  constructor(private readonly service: InvoiceService) {}
  create(tenantId: string, body: CreateInvoiceDto) {
    return this.service.create(tenantId, body);
  }
}
