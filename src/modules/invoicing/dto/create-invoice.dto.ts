export interface CreateInvoiceDto {
  customerId: string;
  currency: string;
  items: Array<{ description: string; quantity: number; unitPrice: number }>;
}
