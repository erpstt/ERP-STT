import {requireReportAccess} from './report-access.service.js';
import {collectGeneralLedgerExportData} from './general-ledger-export-data.service.js';
import {renderGeneralLedgerExport} from './general-ledger-export-renderer.js';

type Format='pdf'|'xlsx'|'csv';
type View='ACCOUNT'|'ENTITY'|'COST';
const mediaTypes:Record<Format,string>={pdf:'application/pdf',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',csv:'text/csv; charset=utf-8'};
const invalid=()=>Object.assign(new Error('Seleccione un formato y una vista válidos para exportar el Libro Mayor.'),{status:400});
export async function exportGeneralLedger(authorization:string,input:unknown){
 await requireReportAccess(authorization);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['format','filters','view'].includes(key)))throw invalid();
 const request=input as Record<string,unknown>;
 if(typeof request.format!=='string'||!Object.hasOwn(mediaTypes,request.format)||typeof request.view!=='string'||!['ACCOUNT','ENTITY','COST'].includes(request.view))throw invalid();
 const format=request.format as Format,view=request.view as View;
 const snapshot=await collectGeneralLedgerExportData(authorization,request.filters);
 const file=await renderGeneralLedgerExport(snapshot,format,view);
 if(file.mimeType!==mediaTypes[format]||!Buffer.isBuffer(file.buffer)||file.buffer.length===0)throw Object.assign(new Error('No fue posible completar el archivo del Libro Mayor.'),{status:502});
 const fileName=String(file.fileName).replace(/[\\/\u0000-\u001f\u007f]/g,'-').slice(0,180);
 if(!fileName.toLowerCase().endsWith('.'+format))throw Object.assign(new Error('No fue posible completar el archivo del Libro Mayor.'),{status:502});
 return{...file,fileName,totalRows:snapshot.total,snapshotFingerprint:snapshot.snapshotFingerprint};
}
