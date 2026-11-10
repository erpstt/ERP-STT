import assert from 'node:assert/strict';

export function catalogPageResponse(rows){
  assert.ok(Array.isArray(rows));
  return Response.json(rows,{headers:{'Content-Range':rows.length?`0-${rows.length-1}/${rows.length}`:'*/0'}});
}

// A real one-row GET collection keeps existing permission and IO-count tests
// focused on their contracts while representing count-aware catalog reads.
export function sendCatalogPageFixture(request,response){
  const url=new URL(request.url,'http://127.0.0.1');
  if(request.method!=='GET'||request.headers.prefer!=='count=exact'||!url.searchParams.has('offset'))return false;
  assert.equal(url.searchParams.get('limit'),'500');
  const key=url.searchParams.get('order')?.split('.')[0];assert.ok(key);
  const rows=Number(url.searchParams.get('offset'))===0?[{[key]:1,synthetic:true}]:[];
  response.setHeader('Content-Range',rows.length?'0-0/1':'*/1');response.end(JSON.stringify(rows));return true;
}
