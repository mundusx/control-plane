import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {page,configFromEnv} from '../src/main.js';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const user={id:'11111111-1111-4111-8111-111111111111',email:'test@example.test',display_name:'Test'};
const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(page({...configFromEnv(),harnessUiEnabled:true}));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try {
 const tab=await browser.newPage(); tab.setDefaultTimeout(8000);
 const errors=[];tab.on('pageerror',error=>errors.push(error.message));
 let online=false, operation, task=0; const operations=[];
 await tab.route('**/assets/**',route=>route.fulfill({contentType:'application/javascript',body:''}));
 await tab.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname; let body={};
  if(path==='/api/auth/session') body={user,csrf_token:'test'};
  if(path==='/api/auth/providers') body={google:true};
  if(path==='/api/agent/status') body={online,connections:online?[{connection_id:'22222222-2222-4222-8222-222222222222',online:true,capabilities:{project_browser:true,agent_runtimes:['hermes']}}]:[]};
  if(path==='/api/agent/tasks' && route.request().method()==='POST') {operation=JSON.parse(route.request().postDataJSON().prompt.split('MUNDUSX_PROJECT_IO_V1:')[1]);operations.push(operation);body={task_id:String(++task)};}
  if(/^\/api\/agent\/tasks\/\d+$/.test(path)) body={state:'completed',result:operation.operation==='list'?{entries:[{name:'src',directory:true}]}:operation.operation==='config_read'?{content:'## Check build\nRun the build and report failures.'}:{}};
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 await tab.addInitScript(({user})=>{for(const n of ['anonymous',user.id])localStorage.setItem('mundusx.chat.localProjects.v1:'+n,JSON.stringify(['fe']));},{user});
 await tab.goto('http://127.0.0.1:'+server.address().port);
 await tab.locator('#account-widget').waitFor({state:'visible'});
 await tab.locator('#repository-open').click();
 await tab.getByRole('button',{name:'Expand fe',exact:true}).click();
 await tab.getByRole('button',{name:'Retry loading files',exact:true}).waitFor();
 async function menu(label){await tab.getByRole('button',{name:'Actions for fe',exact:true}).click();await tab.getByRole('menuitem',{name:label,exact:true}).click();}
 await menu('Project instructions');
 const dialog=tab.locator('dialog[open]');
 await dialog.getByRole('button',{name:'Retry loading',exact:true}).waitFor({state:'visible'});
 assert.ok(await dialog.getByRole('button',{name:'Save instructions',exact:true}).isDisabled());
 online=true;
 await dialog.getByRole('button',{name:'Retry loading',exact:true}).click();
 await dialog.locator('textarea:enabled').waitFor();
 await dialog.locator('textarea').fill('Use project conventions.');
 await dialog.getByRole('button',{name:'Save instructions',exact:true}).click();
 await dialog.getByText('Saved to this project.',{exact:true}).waitFor();
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await tab.getByRole('button',{name:'Retry loading files',exact:true}).click();
 await tab.getByRole('button',{name:'Actions for src',exact:true}).waitFor();
 for(const label of ['Project skills','Saved prompts']) {
  await menu(label);await dialog.locator('textarea:enabled').waitFor();
  if(label==='Saved prompts') {
   await dialog.getByRole('button',{name:'Choose a prompt',exact:true}).click();
   await tab.getByRole('button',{name:'Check build',exact:true}).click();
  } else await dialog.getByRole('button',{name:'Close',exact:true}).click();
 }
 assert.ok(operations.some(op=>op.operation==='config_write' && op.content==='Use project conventions.'));
 assert.deepEqual(errors,[]);
 console.log('PASS: offline error, directory retry, document retry and save, skills load, saved prompt selection.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
