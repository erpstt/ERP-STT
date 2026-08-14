import { consultarYGuardarTipoDeCambioRDAutomatico } from './dominican-republic-exchange-rate.service.js';

const TIME_ZONE='America/Santo_Domingo';
const EXECUTION_HOURS=[3,7,10];
const MAX_TIMER_DELAY=2_147_000_000;

function zonedParts(date:Date){const parts=new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);return Object.fromEntries(parts.map(part=>[part.type,part.value]));}
function offsetAt(date:Date){const p=zonedParts(date);const represented=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));return represented-date.getTime();}
function zonedDate(year:number,month:number,day:number,hour:number){const guess=new Date(Date.UTC(year,month-1,day,hour));return new Date(guess.getTime()-offsetAt(guess));}
function nextExecution(now=new Date()){const p=zonedParts(now);const year=Number(p.year),month=Number(p.month),day=Number(p.day);for(const hour of EXECUTION_HOURS){const candidate=zonedDate(year,month,day,hour);if(candidate.getTime()>now.getTime())return candidate;}return zonedDate(year,month,day+1,EXECUTION_HOURS[0]);}
function effectiveDateRD(date=new Date()){const p=zonedParts(date);return`${p.year}-${p.month}-${p.day}`;}

let timer:NodeJS.Timeout|undefined;
async function execute(){try{const result=await consultarYGuardarTipoDeCambioRDAutomatico(effectiveDateRD());console.log(`[TipoCambioRD] ${result.fechaEfectiva} USD/DOP=${result.tipoCambio} guardado desde ${result.fuente}`);}catch(cause){console.error('[TipoCambioRD] Error en ejecución automática:',cause instanceof Error?cause.message:cause);}finally{schedule();}}
function schedule(){const next=nextExecution();const delay=Math.min(next.getTime()-Date.now(),MAX_TIMER_DELAY);timer=setTimeout(()=>{if(Date.now()+1000<next.getTime())schedule();else void execute();},Math.max(delay,1000));timer.unref();console.log(`[TipoCambioRD] Próxima consulta: ${next.toISOString()} (${TIME_ZONE})`);}

export function iniciarProgramacionTipoCambioRD(){if(timer)return;schedule();}
export const configuracionProgramacionTipoCambioRD={zonaHoraria:TIME_ZONE,horas:[...EXECUTION_HOURS]};
