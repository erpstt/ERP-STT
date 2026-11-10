// A window over an already filtered and ordered collection. Source rows and
// export/selection data remain complete when the visible page changes.
export const pageSizes=Object.freeze([10,25,50,100]);
export function paginationWindow(totalValue,pageValue=1,sizeValue=10){
  const count=Number(totalValue),total=Number.isSafeInteger(count)&&count>=0?count:0;
  const requestedSize=Number(sizeValue),pageSize=pageSizes.includes(requestedSize)?requestedSize:10;
  const pageCount=Math.max(1,Math.ceil(total/pageSize)),requestedPage=Number(pageValue);
  const page=Math.min(pageCount,Math.max(1,Number.isSafeInteger(requestedPage)?requestedPage:1));
  const start=(page-1)*pageSize,end=Math.min(total,start+pageSize);
  return{total,page,pageSize,pageCount,start,end,from:total?start+1:0,to:end};
}
