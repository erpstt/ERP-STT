export type BankStatementLine = {
  date: string;
  valueDate: string;
  reference: string;
  description: string;
  beneficiary: string;
  amount: number;
};

export type ParsedBankStatement = {
  lines: BankStatementLine[];
  openingBalance: number | null;
  closingBalance: number | null;
  balanceSource: string | null;
  balanceDate?: string;
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const OPENING_HEADERS = ['saldo_inicial', 'opening_balance', 'initial_balance'];
const CLOSING_HEADERS = ['saldo_final', 'closing_balance', 'end_balance'];
const RUNNING_HEADERS = ['saldo', 'balance', 'saldo_acumulado', 'running_balance'];
const DATE_HEADERS = ['fecha', 'date', 'fecha_movimiento', 'fecha_de_movimiento'];
const AMOUNT_HEADERS = ['monto', 'amount', 'importe'];

function invalid(message: string): never {
  throw Object.assign(new Error(message), {status: 400});
}

function header(value: unknown) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase().replace(/[ _-]+/g, '_');
}

function amount(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  let text = raw.replace(/[^0-9,.-]/g, '');
  if (!/[0-9]/.test(text)) return null;
  if (text.includes(',') && text.includes('.')) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replaceAll('.', '').replace(',', '.') : text.replaceAll(',', '');
  } else if (text.includes(',')) text = text.replace(',', '.');
  const number = Number(text) * (/^\(.*\)$/.test(raw) ? -1 : 1);
  return Number.isFinite(number) ? number : null;
}

function date(value: unknown) {
  let text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').trim();
  const local = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (local) text = `${local[3]}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}`;
  else text = text.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const parsed = new Date(`${text}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : '';
}

function rounded(value: number) {
  if (!Number.isFinite(value)) invalid('Los saldos del extracto deben ser numéricos y finitos.');
  return Number(value.toFixed(6));
}

function agree(left: number, right: number) {
  return Math.abs(left - right) < .005;
}

function movementNet(lines: BankStatementLine[]) {
  return rounded(lines.reduce((sum, line) => sum + line.amount, 0));
}

function finishBalances(parsed: ParsedBankStatement): ParsedBankStatement {
  const net = movementNet(parsed.lines);
  let {openingBalance: opening, closingBalance: closing} = parsed;
  if (opening !== null) opening = rounded(opening);
  if (closing !== null) closing = rounded(closing);
  if (opening !== null && closing !== null && !agree(opening + net, closing)) {
    invalid('Los saldos del archivo no coinciden con la suma de sus movimientos. Revise el extracto.');
  }
  if (opening !== null && closing === null) closing = rounded(opening + net);
  if (closing !== null && opening === null) opening = rounded(closing - net);
  return {...parsed, openingBalance: opening, closingBalance: closing};
}

export function resolveBankStatementBalances(parsed: ParsedBankStatement, previousClosing?: number | null): ParsedBankStatement {
  if (parsed.openingBalance !== null || parsed.closingBalance !== null) return finishBalances(parsed);
  if (previousClosing !== null && previousClosing !== undefined && Number.isFinite(previousClosing)) {
    return finishBalances({...parsed, openingBalance: previousClosing, balanceSource: 'PREVIOUS_RECONCILIATION'});
  }
  return invalid('El archivo no incluye saldos y no existe un cierre conciliado del período anterior. Cargue un extracto con saldo inicial, saldo final o saldo acumulado.');
}

function delimitedRows(text: string, separator: string) {
  const rows: string[][] = [];
  let cells: string[] = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { value += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === separator && !quoted) { cells.push(value.trim()); value = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      cells.push(value.trim());
      if (cells.some(cell => cell !== '')) rows.push(cells);
      cells = []; value = '';
    } else value += char;
  }
  if (quoted) invalid('El CSV contiene un campo entre comillas sin cerrar.');
  cells.push(value.trim());
  if (cells.some(cell => cell !== '')) rows.push(cells);
  return rows;
}

function headerRow(rows: unknown[][]) {
  return rows.findIndex(row => row.some(cell => DATE_HEADERS.includes(header(cell))) && row.some(cell => AMOUNT_HEADERS.includes(header(cell))));
}

function csvRows(text: string) {
  for (const separator of [',', ';', '\t']) {
    const rows = delimitedRows(text.replace(/^\uFEFF/, ''), separator);
    if (headerRow(rows) >= 0) return rows;
  }
  return invalid('La plantilla debe contener las columnas fecha y monto.');
}

function uniqueBalance(current: number | null, value: unknown, label: string) {
  if (value === null || value === undefined || String(value).trim() === '') return current;
  const number = amount(value);
  if (number === null) invalid(`El ${label} del archivo no es un valor numérico válido.`);
  if (current !== null && !agree(current, number)) invalid(`El archivo contiene valores distintos para el ${label}.`);
  return number;
}

function runningBalances(lines: BankStatementLine[], balances: Array<number | null>) {
  if (!balances.some(value => value !== null)) return null;
  const indices = lines.map((_, index) => index);
  for (const order of [indices, [...indices].reverse()]) {
    if (order.some((index, position) => position > 0 && lines[index].date < lines[order[position - 1]].date)) continue;
    let total = 0, opening: number | null = null, valid = true;
    for (const index of order) {
      total += lines[index].amount;
      if (balances[index] !== null) {
        const candidate = rounded(balances[index]! - total);
        if (opening !== null && !agree(opening, candidate)) { valid = false; break; }
        opening = candidate;
      }
    }
    if (valid && opening !== null) return {opening, closing: rounded(opening + movementNet(lines))};
  }
  return invalid('Los saldos acumulados no coinciden con el orden y los importes de los movimientos del extracto.');
}

function parseMatrix(rows: unknown[][]): ParsedBankStatement {
  const first = headerRow(rows);
  if (first < 0) invalid('La plantilla debe contener las columnas fecha y monto.');
  const columns = rows[first].map(header);
  const index = (names: string[]) => columns.findIndex(value => names.includes(value));
  const dateIndex = index(DATE_HEADERS), amountIndex = index(AMOUNT_HEADERS);
  const valueIndex = index(['fecha_valor', 'fecha_de_valor', 'value_date']);
  const referenceIndex = index(['referencia', 'reference', 'cheque']);
  const descriptionIndex = index(['nota', 'descripcion', 'description', 'concepto', 'memo']);
  const beneficiaryIndex = index(['beneficiario', 'nombre', 'name']);
  const openingIndex = index(OPENING_HEADERS), closingIndex = index(CLOSING_HEADERS), runningIndex = index(RUNNING_HEADERS);
  const lines: BankStatementLine[] = [], balances: Array<number | null> = [];
  let opening: number | null = null, closing: number | null = null;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    if (rowIndex === first) continue;
    const row = rows[rowIndex], key = header(row[0]);
    if (OPENING_HEADERS.includes(key)) { opening = uniqueBalance(opening, row[1], 'saldo inicial'); continue; }
    if (CLOSING_HEADERS.includes(key)) { closing = uniqueBalance(closing, row[1], 'saldo final'); continue; }
    if (rowIndex < first || row.every(value => value === null || value === undefined || String(value).trim() === '')) continue;
    if (openingIndex >= 0) opening = uniqueBalance(opening, row[openingIndex], 'saldo inicial');
    if (closingIndex >= 0) closing = uniqueBalance(closing, row[closingIndex], 'saldo final');
    if (!String(row[dateIndex] ?? '').trim() && !String(row[amountIndex] ?? '').trim()
      && (openingIndex >= 0 || closingIndex >= 0)) continue;
    const movementDate = date(row[dateIndex]), movementAmount = amount(row[amountIndex]);
    if (!movementDate) invalid(`Fila ${rowIndex + 1}: la fecha debe usar AAAA-MM-DD o DD/MM/AAAA y ser válida.`);
    if (movementAmount === null || movementAmount === 0) invalid(`Fila ${rowIndex + 1}: el monto debe ser numérico y diferente de cero.`);
    const valueDate = valueIndex >= 0 && String(row[valueIndex] ?? '').trim() ? date(row[valueIndex]) : '';
    if (valueIndex >= 0 && String(row[valueIndex] ?? '').trim() && !valueDate) invalid(`Fila ${rowIndex + 1}: la fecha de valor no es válida.`);
    const text = (column: number) => column >= 0 ? String(row[column] ?? '') : '';
    lines.push({date: movementDate, valueDate, reference: text(referenceIndex), description: text(descriptionIndex), beneficiary: text(beneficiaryIndex), amount: movementAmount});
    const running = runningIndex >= 0 ? row[runningIndex] : null;
    if (running !== null && running !== undefined && String(running).trim() !== '' && amount(running) === null) invalid(`Fila ${rowIndex + 1}: el saldo acumulado no es válido.`);
    balances.push(amount(running));
  }
  if (!lines.length) invalid('El archivo no contiene movimientos reconocibles.');
  const running = runningBalances(lines, balances);
  if (running) {
    if (opening !== null && !agree(opening, running.opening) || closing !== null && !agree(closing, running.closing)) {
      invalid('Los saldos inicial y final no coinciden con los saldos acumulados del archivo.');
    }
    const explicit = opening !== null || closing !== null;
    return finishBalances({lines, openingBalance: opening ?? running.opening, closingBalance: closing ?? running.closing, balanceSource: explicit ? 'FILE_BALANCES' : 'RUNNING_BALANCES'});
  }
  return finishBalances({lines, openingBalance: opening, closingBalance: closing, balanceSource: opening !== null || closing !== null ? 'FILE_BALANCES' : null});
}

function ofxValue(text: string, tag: string) {
  return text.match(new RegExp(`<${tag}>([^<\\r\\n]+)`, 'i'))?.[1]?.trim() ?? '';
}

function ofxDate(value: string) {
  return date(value.replace(/^(\d{4})(\d{2})(\d{2}).*$/, '$1-$2-$3'));
}

function parseOfx(text: string): ParsedBankStatement {
  if ((text.match(/<BANKTRANLIST>/gi) ?? []).length > 1 || (text.match(/<LEDGERBAL>/gi) ?? []).length > 1) {
    invalid('El archivo contiene varios extractos. Cargue únicamente el extracto de la cuenta seleccionada.');
  }
  const transactions = [...text.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi)];
  if (transactions.length !== (text.match(/<STMTTRN>/gi) ?? []).length) invalid('El archivo OFX contiene movimientos incompletos.');
  const lines = transactions.map(([, item], index) => {
    const movementDate = ofxDate(ofxValue(item, 'DTPOSTED')), movementAmount = amount(ofxValue(item, 'TRNAMT'));
    if (!movementDate || movementAmount === null || movementAmount === 0) invalid(`Movimiento ${index + 1}: fecha o monto del extracto OFX no válido.`);
    return {date: movementDate, valueDate: '', reference: ofxValue(item, 'FITID') || ofxValue(item, 'CHECKNUM'), description: ofxValue(item, 'MEMO'), beneficiary: ofxValue(item, 'NAME'), amount: movementAmount};
  });
  if (!lines.length) invalid('El archivo no contiene movimientos reconocibles.');
  const ledger = text.match(/<LEDGERBAL>([\s\S]*?)<\/LEDGERBAL>/i)?.[1];
  const closing = ledger === undefined ? null : amount(ofxValue(ledger, 'BALAMT'));
  if (ledger !== undefined && closing === null) invalid('El saldo contable del extracto OFX no es válido.');
  const balanceDate = ledger === undefined ? '' : ofxDate(ofxValue(ledger, 'DTASOF'));
  if (ledger !== undefined && ofxValue(ledger, 'DTASOF') && !balanceDate) invalid('La fecha del saldo contable del extracto OFX no es válida.');
  if (balanceDate && lines.some(line => line.date > balanceDate)) invalid('El extracto OFX incluye movimientos posteriores a la fecha de su saldo contable.');
  return finishBalances({lines, openingBalance: null, closingBalance: closing, balanceSource: closing === null ? null : 'OFX_LEDGER_BALANCE', ...(balanceDate ? {balanceDate} : {})});
}

export async function parseBankStatementFile(input: {fileName: string; text?: string; base64?: string}): Promise<ParsedBankStatement> {
  const extension = String(input.fileName ?? '').trim().match(/\.(csv|xlsx|ofx|qfx)$/i)?.[1]?.toLowerCase();
  if (!extension) invalid('Seleccione un archivo CSV, Excel (.xlsx), OFX o QFX.');
  let buffer: Buffer;
  if (typeof input.base64 === 'string') {
    const encoded = input.base64.replace(/\s/g, '');
    if (encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) invalid('El archivo supera el límite de 5 MB.');
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid('El archivo no tiene una codificación válida.');
    buffer = Buffer.from(encoded, 'base64');
    if (buffer.toString('base64') !== encoded) invalid('El archivo no tiene una codificación válida.');
  } else if (typeof input.text === 'string' && extension !== 'xlsx') buffer = Buffer.from(input.text, 'utf8');
  else return invalid('No se recibió el contenido del archivo del extracto.');
  if (buffer.length > MAX_FILE_BYTES) invalid('El archivo supera el límite de 5 MB.');
  if (!buffer.length) invalid('El archivo del extracto está vacío.');
  if (extension === 'xlsx') {
    const {readSheet} = await import('read-excel-file/node');
    let matrix: unknown[][];
    try { matrix = await readSheet(buffer); }
    catch { return invalid('El archivo Excel no se pudo leer. Verifique que sea un archivo .xlsx válido.'); }
    return parseMatrix(matrix);
  }
  const text = buffer.toString('utf8');
  return extension === 'ofx' || extension === 'qfx' ? parseOfx(text) : parseMatrix(csvRows(text));
}
