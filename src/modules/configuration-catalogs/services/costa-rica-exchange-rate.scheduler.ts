import { consultarYGuardarTipoDeCambioCRAutomatico } from './costa-rica-exchange-rate.service.js';

const TIME_ZONE='America/Costa_Rica';const HOURS=[3,7,10];
function parts(date:Date){return Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(part=>[part.type,part.value]));}
function offset(date:Date){const p=parts(date);return Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second))-date.getTime();}
function zoned(year:number,month:number,day:number,hour:number){const guess=new Date(Date.UTC(year,month-1,day,hour));return new Date(guess.getTime()-offset(guess));}
function next(now=new Date()){const p=parts(now),year=Number(p.year),month=Number(p.month),day=Number(p.day);for(const hour of HOURS){const candidate=zoned(year,month,day,hour);if(candidate>now)return candidate;}return zoned(year,month,day+1,HOURS[0]);}
function localDate(){const p=parts(new Date());return`${p.year}-${p.month}-${p.day}`;}
let timer:NodeJS.Timeout|undefined;
async function execute(){try{const result=await consultarYGuardarTipoDeCambioCRAutomatico(localDate());console.log(`[TipoCambioCR] ${result.fechaEfectiva} USD/CRC=${result.tipoCambio} guardado desde ${result.fuente}`);}catch(cause){console.error('[TipoCambioCR] Error en ejecución automática:',cause instanceof Error?cause.message:cause);}finally{schedule();}}
function schedule(){const target=next();timer=setTimeout(()=>void execute(),Math.max(target.getTime()-Date.now(),1000));timer.unref();console.log(`[TipoCambioCR] Próxima consulta: ${target.toISOString()} (${TIME_ZONE})`);}
export function iniciarProgramacionTipoCambioCR(){if(!timer)schedule();}
