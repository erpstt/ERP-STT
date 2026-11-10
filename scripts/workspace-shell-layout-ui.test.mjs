import assert from 'node:assert/strict';
import {test} from 'node:test';
import {expect} from '@playwright/test';
import {workspaceShellLayoutFixture} from './lib/workspace-shell-layout-fixture.mjs';

const toggle=page=>page.locator('#sidebarToggle');
async function sidebarState(page,expanded){
  await expect(toggle(page)).toHaveAttribute('aria-expanded',String(expanded));
}
async function assertShellFits(page){
  const geometry=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,
    bodyWidth:document.body.scrollWidth,bodyHeight:document.body.scrollHeight}));
  assert.ok(geometry.scrollWidth<=geometry.width+1&&geometry.bodyWidth<=geometry.width+1,`The shell must not overflow horizontally: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.scrollHeight<=geometry.height+1&&geometry.bodyHeight<=geometry.height+1,`The shell must not add a second vertical scrollbar: ${JSON.stringify(geometry)}`);
}
async function assertFrameFits(page){
  await assertShellFits(page);
  const geometry=await page.locator('.embedded-workspace iframe').evaluate(element=>{
    const frame=element.getBoundingClientRect(),header=document.querySelector('.dashboard-header').getBoundingClientRect(),toolbar=document.querySelector('.embedded-toolbar').getBoundingClientRect();
    return{height:innerHeight,frameTop:frame.top,frameBottom:frame.bottom,frameHeight:frame.height,headerBottom:header.bottom,toolbarHeight:toolbar.height};
  });
  assert.ok(geometry.frameHeight>150,`The document must retain usable height: ${JSON.stringify(geometry)}`);
  assert.ok(Math.abs(geometry.frameTop-geometry.headerBottom-geometry.toolbarHeight)<=2,`The frame must begin after the actual header and toolbar: ${JSON.stringify(geometry)}`);
  assert.ok(Math.abs(geometry.height-geometry.frameBottom)<=2,`The frame must fill the remaining viewport: ${JSON.stringify(geometry)}`);
}

test('el menú se puede ocultar y mostrar con control accesible y el catálogo usa el ancho disponible',{timeout:60000},async t=>{
  const {page,openInvoices}=await workspaceShellLayoutFixture(t);
  await expect(toggle(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-controls','moduleSidebar');
  await sidebarState(page,true);
  assert.match(await toggle(page).getAttribute('aria-label'),/ocultar.*men[uú]/i);
  await openInvoices();
  await sidebarState(page,true); // Navigation must preserve the desktop choice.
  const initial=await page.locator('.table-card').boundingBox(),sidebar=await page.locator('#moduleSidebar').boundingBox();
  await toggle(page).click();await sidebarState(page,false);
  await expect(page.locator('.workspace')).toHaveClass(/sidebar-collapsed/);
  assert.equal(await page.locator('#moduleSidebar').evaluate(element=>element.inert),true,'Hidden navigation must not receive keyboard focus');
  assert.match(await toggle(page).getAttribute('aria-label'),/mostrar.*men[uú]/i);
  await expect.poll(async()=>{const rect=await page.locator('.table-card').boundingBox();return rect.width-initial.width;}).toBeGreaterThanOrEqual(sidebar.width-4);
  const expanded=await page.locator('.table-card').boundingBox();
  assert.ok(expanded.width-initial.width>=sidebar.width-4,'Hiding the menu must give its width to the catalog');
  assert.ok(1440-expanded.x-expanded.width<=64,'The invoice list must use the right side of the workspace');
  await assertShellFits(page);
  await toggle(page).click();await sidebarState(page,true);
  await expect(page.locator('.workspace')).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('#moduleSidebar .nav-link').first()).toBeVisible();
  await assertShellFits(page);
});

test('la preferencia persiste al navegar y recargar y queda separada por usuario',{timeout:60000},async t=>{
  const {page,ready,reloadAs,openWorkflow}=await workspaceShellLayoutFixture(t);
  await toggle(page).click();await sidebarState(page,false);
  await openWorkflow();await sidebarState(page,false);
  await page.getByRole('button',{name:'‹ Volver al módulo'}).click();await sidebarState(page,false);
  await page.reload();await ready();await sidebarState(page,false);
  await reloadAs(2);await sidebarState(page,true);
  await reloadAs(1);await sidebarState(page,false);
  await toggle(page).click();await sidebarState(page,true);
  await page.reload();await ready();await sidebarState(page,true);
});

test('en móvil el menú superpuesto cierra con Escape, fondo y navegación sin cambiar la preferencia de escritorio',{timeout:60000},async t=>{
  const {page}=await workspaceShellLayoutFixture(t);
  await sidebarState(page,true);
  await page.setViewportSize({width:390,height:740});
  await sidebarState(page,false);
  await expect(page.locator('.sidebar-backdrop')).toBeHidden();
  await expect(page.locator('.nexo-approval-bell')).toBeVisible();
  await toggle(page).click();await sidebarState(page,true);
  await expect(page.locator('.sidebar-backdrop')).toBeVisible();
  assert.equal(await page.locator('.nexo-approval-bell').evaluate(element=>{
    const rect=element.getBoundingClientRect();return Boolean(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest('.sidebar-backdrop'));
  }),true,'The mobile backdrop must cover the floating notification bell');
  await expect(page.locator('#moduleSidebar .sidebar-close')).toBeFocused();
  assert.equal(await page.locator('.dashboard').evaluate(element=>element.inert),true,'The document behind the mobile menu must not receive keyboard focus');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#moduleSidebar .sidebar-bottom button').last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#moduleSidebar .sidebar-close')).toBeFocused();
  await page.keyboard.press('Escape');await sidebarState(page,false);
  await expect(toggle(page)).toBeFocused();
  await toggle(page).click();await sidebarState(page,true);
  await page.locator('.sidebar-backdrop').click({position:{x:380,y:400}});await sidebarState(page,false);
  await toggle(page).click();await sidebarState(page,true);
  await page.locator('#moduleSidebar .nav-link').filter({hasText:'Ventas'}).click();await sidebarState(page,false);
  await assertShellFits(page);
  await page.setViewportSize({width:1440,height:900});await sidebarState(page,true);
  await toggle(page).click();await sidebarState(page,false);
  await page.setViewportSize({width:390,height:740});await sidebarState(page,false);
  await expect(page.locator('#moduleSidebar')).toHaveCSS('visibility','hidden');
  await page.screenshot({animations:'disabled'}); // Exercise a settled hidden menu before opening it.
  await toggle(page).click();await sidebarState(page,true);
  await expect(page.locator('#moduleSidebar .sidebar-close')).toBeFocused();
  await page.keyboard.press('Escape');await sidebarState(page,false);
  await page.setViewportSize({width:1440,height:900});await sidebarState(page,false);
});

test('el iframe ocupa la altura restante y conserva accesible el contenido largo en escritorio y móvil',{timeout:60000},async t=>{
  const {page,calls,openWorkflow}=await workspaceShellLayoutFixture(t,{viewport:{width:1366,height:768}});
  const frame=await openWorkflow();
  const workflowReads=()=>calls.filter(call=>['/api/approval-engine/options','/api/approval-engine/workflows'].includes(call.path)).length,initialReads=workflowReads();
  await frame.locator('#name').evaluate(element=>{element.value='Borrador sintético';});
  await toggle(page).click();await sidebarState(page,false);
  assert.equal(await frame.locator('#name').inputValue(),'Borrador sintético','Hiding the menu must preserve the current document draft');
  await toggle(page).click();await sidebarState(page,true);
  assert.equal(await frame.locator('#name').inputValue(),'Borrador sintético','Showing the menu must preserve the current document draft');
  assert.equal(workflowReads(),initialReads,'Toggling the menu must not reload document options or workflows');
  for(const viewport of [{width:1366,height:768},{width:1058,height:540},{width:390,height:740}]){
    await page.setViewportSize(viewport);
    await assertFrameFits(page);
    assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'The document must fit its iframe horizontally');
    await frame.locator('#configuredTitle').scrollIntoViewIfNeeded();
    const visible=await frame.locator('#configuredTitle').evaluate(element=>{const rect=element.getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight+1;});
    assert.equal(visible,true,'Lower sections must remain reachable through the document scroll');
    await assertFrameFits(page);
  }
});

test('el selector de idioma móvil queda debajo del encabezado y dentro de pantallas altas y bajas sin cambiar preferencias',{timeout:60000},async t=>{
  const {page,calls,openWorkflow}=await workspaceShellLayoutFixture(t);
  await toggle(page).click();await sidebarState(page,false);
  await openWorkflow(); // Its long breadcrumb makes the mobile header grow.
  await expect(page.locator('.nexo-approval-bell')).toBeVisible();
  const storedBefore=await page.evaluate(()=>Object.keys(localStorage).sort().map(key=>[key,localStorage.getItem(key)])),requestCount=calls.length;
  for(const viewport of [{width:390,height:740},{width:390,height:540}]){
    await page.setViewportSize(viewport);
    const summary=page.locator('.language-selector summary'),menu=page.locator('.language-selector .role-menu');
    await expect.poll(()=>summary.evaluate(element=>Math.abs(element.getBoundingClientRect().width-40))).toBeLessThan(0.5);
    await summary.click();await expect(menu).toBeVisible();
    await menu.evaluate(element=>Promise.all(element.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))));
    const geometry=await menu.evaluate(element=>({menu:element.getBoundingClientRect().toJSON(),header:document.querySelector('.dashboard-header').getBoundingClientRect().toJSON(),
      summary:document.querySelector('.language-selector summary').getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight}));
    assert.ok(geometry.menu.left>=0&&geometry.menu.right<=geometry.width+1,`The dropdown must fit horizontally: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.header.height>64,'The scenario must exercise a wrapped mobile header');
    assert.ok(geometry.menu.top>=geometry.header.bottom&&geometry.menu.top>=geometry.summary.bottom,`The dropdown must begin below the whole wrapped header: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.menu.bottom<=geometry.height+1,`The dropdown must fit vertically: ${JSON.stringify(geometry)}`);
    await assertShellFits(page);
    await summary.click();await expect(menu).toBeHidden();
  }
  assert.deepEqual(calls.slice(requestCount),[],'Opening and closing the selector must not request APIs');
  assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage).sort().map(key=>[key,localStorage.getItem(key)])),storedBefore,'Opening and closing the selector must preserve stored preferences');
  await page.setViewportSize({width:1440,height:900});await sidebarState(page,false);
});

test('los selectores de empresa, rol e idioma caben bajo el header en tabletas y permiten recorrer listas largas',{timeout:60000},async t=>{
  const {page,calls,openWorkflow}=await workspaceShellLayoutFixture(t,{viewport:{width:801,height:540},headerChoices:12});
  await openWorkflow();
  await expect(page.locator('.nexo-approval-bell')).toBeVisible();
  const storedBefore=await page.evaluate(()=>Object.keys(localStorage).sort().map(key=>[key,localStorage.getItem(key)])),requestCount=calls.length;
  const selectors=[{details:'.company-selector',menu:'.company-menu',choices:12},
    {details:'.role-selector:not(.language-selector)',menu:'.role-menu',choices:12},
    {details:'.language-selector',menu:'.role-menu',choices:1}];
  for(const width of [801,825,850,1000]){
    await page.setViewportSize({width,height:540});
    for(const selector of selectors){
      const details=page.locator('.header-identity '+selector.details),summary=details.locator('summary'),menu=details.locator(selector.menu);
      await summary.click();await expect(menu).toBeVisible();
      await menu.evaluate(element=>Promise.all(element.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))));
      const geometry=await menu.evaluate(element=>({menu:element.getBoundingClientRect().toJSON(),header:document.querySelector('.dashboard-header').getBoundingClientRect().toJSON(),
        dashboard:document.querySelector('.dashboard').getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,overflowY:getComputedStyle(element).overflowY}));
      assert.ok(geometry.menu.left>=geometry.dashboard.left&&geometry.menu.right<=geometry.dashboard.right+1&&geometry.menu.right<=geometry.width+1,`The selector must remain within the dashboard at ${width}px: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.menu.top>=geometry.header.bottom,`The selector must begin below the actual wrapped header at ${width}px: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.menu.bottom<=geometry.height+1,`The selector must remain inside the viewport at ${width}px: ${JSON.stringify(geometry)}`);
      await expect(menu.locator(':scope > button')).toHaveCount(selector.choices);
      if(selector.choices===12){
        assert.ok(geometry.scrollHeight>geometry.clientHeight,'Long selector lists must have internal scrolling');
        assert.match(geometry.overflowY,/auto|scroll/);
        await menu.evaluate(element=>{element.scrollTop=element.scrollHeight;});
        const lastVisible=await menu.locator(':scope > button').last().evaluate(element=>{const item=element.getBoundingClientRect(),menu=element.parentElement.getBoundingClientRect();return item.top>=menu.top&&item.bottom<=menu.bottom;});
        assert.equal(lastVisible,true,'The last company or role must remain reachable inside the dropdown');
      }
      await assertShellFits(page);
      await summary.click();await expect(menu).toBeHidden();
    }
  }
  assert.deepEqual(calls.slice(requestCount),[],'Inspecting company, role and language options must not request APIs');
  assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage).sort().map(key=>[key,localStorage.getItem(key)])),storedBefore,'Inspecting selector options must preserve stored preferences');
  await sidebarState(page,true);
});
