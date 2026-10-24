import type ExcelJS from 'exceljs';

type ExcelRuntime = { Workbook: new () => ExcelJS.Workbook };
let runtimePromise: Promise<ExcelRuntime> | null = null;

async function loadExcelRuntime(): Promise<ExcelRuntime> {
  runtimePromise ??= import('exceljs').then(module => (module.default ?? module) as unknown as ExcelRuntime);
  return runtimePromise;
}

/** ExcelJS es pesado; se carga una sola vez y únicamente cuando se solicita un XLSX. */
export async function createExcelWorkbook(): Promise<ExcelJS.Workbook> {
  const runtime = await loadExcelRuntime();
  return new runtime.Workbook();
}
