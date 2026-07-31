export class InvoiceService {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async create(tenantId, input) {
        if (!input.items.length)
            throw new Error('Una factura debe contener al menos una línea.');
        return this.repository.create(tenantId, input);
    }
}
