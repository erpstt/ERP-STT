process.loadEnvFile?.('.env');
const {obtenerTipoDeCambioCR,consultarYGuardarTipoDeCambioCRAutomatico}=await import('../dist/modules/configuration-catalogs/services/costa-rica-exchange-rate.service.js');
const date=process.argv.find(value=>/^\d{4}-\d{2}-\d{2}$/.test(value));
const result=process.argv.includes('--save')?await consultarYGuardarTipoDeCambioCRAutomatico(date):await obtenerTipoDeCambioCR('USD','CRC',date);
console.log(JSON.stringify({fecha:result.fechaEfectiva,compra:result.tasaCompra,venta:result.tasaVenta,tipoCambio:result.tipoCambio,fuente:result.fuente,guardado:result.guardado??false}));
