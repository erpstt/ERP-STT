export class InvoiceController {
    service;
    constructor(service) {
        this.service = service;
    }
    create(tenantId, body) {
        return this.service.create(tenantId, body);
    }
}
