import {test, expect} from '@playwright/test';

test('compiled Node server serves the real production build and a synthetic snapshot search on one origin', async ({page}) => {
  const external: string[]=[];
  await page.route('**/*', route => {
    const url=new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4174') { external.push(url.origin); return route.abort(); }
    return route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Dove vuoi andare?'})).toBeVisible();
  expect(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
  await page.getByRole('radio',{name:'Bus',exact:true}).check();
  await page.locator('#origin').fill('Roma'); await page.locator('#origin').press('Escape');
  await page.locator('#destination').fill('Cosenza'); await page.locator('#destination').press('Escape');
  const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+86400000));
  await page.locator('#date').fill(date);
  await page.getByRole('button',{name:'Cerca',exact:true}).click();
  await expect(page.locator('#search-status')).toContainText('Ricerca completata');
  await expect(page.locator('#trip-list article')).toHaveCount(1);
  await expect(page.locator('#trip-list')).toContainText('Rende Cosenza Nord');
  await expect(page.locator('#trip-list')).toContainText('25,00 EUR');
  expect(external).toEqual([]);
});

test('same server preserves legacy API, browser aliases, liveness and MCP initialization', async ({request}) => {
  const legacy=await request.get('/providers'), alias=await request.get('/api/providers');
  expect(await alias.json()).toEqual(await legacy.json());
  expect((await request.get('/health')).ok()).toBe(true);
  expect((await request.get('/api/mcp')).status()).toBe(404);
  const mcp=await request.post('/mcp',{
    headers:{accept:'application/json, text/event-stream'},
    data:{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'synthetic-browser',version:'1.0'}}},
  });
  expect(mcp.status()).toBe(200);
  expect(await mcp.text()).toContain('serverInfo');
});
