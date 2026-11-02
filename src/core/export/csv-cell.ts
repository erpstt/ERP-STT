/** CSV para visualización; XLSX conserva tipos sin prefijos. Política equivalente a la del navegador. */
export function csvCell(value: unknown, { numeric = false }: { numeric?: boolean } = {}): string {
  let text = String(value ?? '');
  const number = typeof value === 'number' && Number.isFinite(value) || numeric && /^-?\d+(?:[.,]\d+)?$/.test(text);
  if (!number && (/^[\s\p{Cf}\u0000-\u001f\u007f]*[=+\-@\uff1d\uff0b\uff0d\uff20]/u.test(text) || /^[\t\r\n]/.test(text))) text = '\t' + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
