alter table public.payment_methods
  add column if not exists method_code text,
  add column if not exists category text,
  add column if not exists requires_bank_account boolean not null default false,
  add column if not exists description text;

update public.payment_methods
set method_code = coalesce(method_code, 'LEGACY_' || payment_method_id::text),
    category = coalesce(category, 'Otro'),
    description = coalesce(description, 'Método de pago existente')
where method_code is null or category is null or description is null;

insert into public.payment_methods(method_code, method_name, category, requires_bank_account, description) values
('EFE','Efectivo','Contado',false,'Pago físico en caja'),
('TRF_SINPE','Transferencia SINPE (Interbancaria)','Bancario',true,'Transferencias estándar entre cuentas CR (Cuenta IBAN)'),
('SINPE_MOVIL','SINPE Móvil','Bancario Móvil',true,'Pago ágil mediante número de teléfono afiliado a BCCR'),
('TRF_INTL','Transferencia Internacional (Wire)','Bancario',true,'Transferencias Swift internacionales'),
('TC_VISA','Tarjeta de Crédito - Visa','Tarjeta',true,'Pago con TC Visa mediante datáfono o pasarela'),
('TC_MC','Tarjeta de Crédito - MasterCard','Tarjeta',true,'Pago con TC MasterCard'),
('TC_AMEX','Tarjeta de Crédito - Amex','Tarjeta',true,'Pago con American Express'),
('TD_BAN','Tarjeta de Débito','Tarjeta',true,'Pagos con tarjeta de débito local/internacional'),
('CHQ','Cheque','Bancario',true,'Cheques emitidos o recibidos en ventanilla'),
('W_PAY','Billetera Digital (Apple/Paypal)','Digital',true,'Wallets y procesadores de pago')
on conflict (method_name) do update set
  method_code = excluded.method_code,
  category = excluded.category,
  requires_bank_account = excluded.requires_bank_account,
  description = excluded.description;

alter table public.payment_methods
  alter column method_code set not null,
  alter column category set not null,
  alter column description set not null;

create unique index if not exists payment_methods_method_code_key on public.payment_methods(method_code);

alter table public.payment_methods
  drop column if exists is_credit_card,
  drop column if exists is_bank_transfer;
