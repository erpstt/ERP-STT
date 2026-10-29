const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const kind = params.get('kind') === 'DEBIT' ? 'DEBIT' : 'CREDIT';
const id = params.get('id');
const token = localStorage.getItem('nexo_token') || sessionStorage.getItem('nexo_token');
const device = localStorage.getItem('nexo_device_token');

async function api(path) {
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${token}`, 'X-Device-Token': device }
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error?.message || 'No fue posible consultar la nota.');
  return data;
}

const money = (value, symbol) => `${symbol} ${Number(value || 0).toLocaleString('es-CR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})}`;
const date = value => String(value || '').slice(0, 10);
const month = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''))
  ? new Intl.DateTimeFormat('es-CR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${value}-01T12:00:00Z`))
  : '—';

try {
  const paths = [
    '/api/sales/credit-notes',
    '/api/sales/debit-notes',
    '/api/sales/sales-note-lines',
    '/api/sales/invoices',
    '/api/entities/customers',
    '/api/inventory/products',
    '/api/core/currencies',
    '/api/core/countries'
  ];
  const [credits, debits, noteLines, invoices, customers, products, currencies, countries] =
    await Promise.all(paths.map(api));
  const key = kind === 'CREDIT' ? 'cn_id' : 'dn_id';
  const note = (kind === 'CREDIT' ? credits : debits)
    .find(row => String(row[key]) === String(id));
  if (!note) throw Error('No se encontró la nota.');

  const invoice = invoices.find(row => String(row.invoice_id) === String(note.invoice_id)) || {};
  const customer = customers.find(row => String(row.customer_id) === String(note.customer_id)) || {};
  const sub = invoice.subsidiary_id
    ? await api(`/api/organization/subsidiaries/${invoice.subsidiary_id}`)
    : {};
  const currency = currencies.find(row => String(row.currency_id) === String(note.currency_id)) || {};
  const symbol = currency.symbol || currency.currency_code || '';
  const lines = noteLines.filter(row => row.note_kind === kind && String(row.note_id) === String(id));

  $('companyName').textContent = sub.name;
  $('companyAddress').textContent = sub.address || '';
  $('footerCompany').textContent = sub.name;
  if (sub.logo_url) {
    $('logo').src = sub.logo_url;
    $('logo').hidden = false;
  }
  $('type').textContent = kind === 'CREDIT' ? 'NOTA DE CRÉDITO' : 'NOTA DE DÉBITO';
  $('number').textContent = note[kind === 'CREDIT' ? 'cn_number' : 'dn_number'];
  $('customer').textContent = customer.company_name;
  $('taxId').textContent = `Identificación fiscal: ${customer.tax_id || '—'}`;
  $('related').textContent = invoice.invoice_number;
  $('date').textContent = date(note.note_date);
  $('currency').textContent = `${currency.currency_code} - ${currency.name}`;
  $('memo').textContent = note.memo || '—';

  let subtotal = 0;
  let tax = 0;
  $('lines').innerHTML = lines.map(line => {
    const product = products.find(item => String(item.product_id) === String(line.product_id)) || {};
    const country = countries.find(item => String(item.country_id) === String(line.service_country_id));
    subtotal += Number(line.amount);
    tax += Number(line.tax_amount);
    return `<tr><td><strong>${product.display_name || 'Producto'}</strong>${line.note ? `<span class="product-code">${line.note}</span>` : ''}</td><td>${country?.name || '—'}</td><td>${month(line.service_month)}</td><td class="number">${line.quantity}</td><td class="number">${money(line.unit_price, symbol)}</td><td class="number">${money(line.amount, symbol)}</td><td class="number">${money(line.tax_amount, symbol)}</td><td class="number">${money(line.gross_amount, symbol)}</td></tr>`;
  }).join('');
  $('subtotal').textContent = money(subtotal, symbol);
  $('tax').textContent = money(tax, symbol);
  $('total').textContent = money(note.amount, symbol);
  $('edit').href = `/sales-note-entry.html?kind=${kind}&id=${id}`;
  $('invoice').hidden = false;
  $('print').onclick = () => print();
  $('back').onclick = () => history.back();
} catch (error) {
  $('error').textContent = error.message;
}
