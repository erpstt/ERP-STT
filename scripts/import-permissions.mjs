import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import pg from 'pg';

function unzip(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if (flags & 0x08) throw new Error('El XLSX usa un formato ZIP no soportado por este importador.');
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    offset = start + compressedSize;
  }
  return files;
}

function decodeXml(value) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function cellValue(cell, sharedStrings) {
  const type = cell.match(/<c\b[^>]*\bt="([^"]+)"/)?.[1];
  const raw = cell.match(/<v>([\s\S]*?)<\/v>/)?.[1]
    ?? [...cell.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => match[1]).join('');
  if (raw === undefined) return '';
  return type === 's' ? sharedStrings[Number(raw)] ?? '' : decodeXml(raw);
}

const workbook = unzip(await readFile(process.argv[2]));
const sharedXml = workbook.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
const sharedStrings = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((item) =>
  decodeXml([...item[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => match[1]).join('')),
);
const sheet = workbook.get('xl/worksheets/sheet1.xml')?.toString('utf8');
if (!sheet) throw new Error('No se encontró la primera hoja del archivo.');
const rows = [...sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].slice(1).map((row) => {
  const values = {};
  for (const cell of row[1].matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*>[\s\S]*?<\/c>/g)) values[cell[1]] = cellValue(cell[0], sharedStrings);
  return { code: values.A?.trim(), module: values.B?.trim(), description: values.C?.trim() || null };
}).filter((row) => row.code && row.module);

if (rows.length !== 107) throw new Error(`Se esperaban 107 permisos y se encontraron ${rows.length}.`);
if (new Set(rows.map((row) => row.code)).size !== rows.length) throw new Error('El archivo contiene códigos de permiso duplicados.');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('begin');
  for (const row of rows) {
    await client.query(
      'insert into public.permissions (code, module, description) values ($1, $2, $3) on conflict (code) do update set module = excluded.module, description = excluded.description',
      [row.code, row.module, row.description],
    );
  }
  const result = await client.query('select count(*)::integer as count from public.permissions where code = any($1::text[])', [rows.map((row) => row.code)]);
  if (result.rows[0].count !== rows.length) throw new Error('La validación posterior no encontró todos los permisos importados.');
  await client.query('commit');
  console.log(`Permisos importados y verificados: ${result.rows[0].count}`);
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  await client.end();
}
