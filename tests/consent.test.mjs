import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../docs/consent.js',import.meta.url),'utf8');
const callback='https://claude.ai/api/mcp/auth_callback';
async function fixture({search='?authorization_id=synthetic-request',details,hash='',framed=false}={}){
 const elements=new Map(),requests=[],storage=new Map(),redirects=[];let replaced;
 function element(id){if(!elements.has(id))elements.set(id,{hidden:['login','consent'].includes(id),value:id==='email'?'test@example.invalid':'synthetic-password',handlers:{},addEventListener(event,fn){this.handlers[event]=fn;},reportValidity:()=>true});return elements.get(id);}
 const context={URL,URLSearchParams,console:{log(){throw Error('Do not log credentials');}},document:{getElementById:element,querySelectorAll:()=>[]},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},history:{replaceState:(_,__,value)=>replaced=value},window:{location:{hash,pathname:'/streamline-mcp/consent.html',search,href:'https://rostehea.github.io/streamline-mcp/consent.html'+search,assign:url=>redirects.push(url)}},fetch:async(url,options={})=>{
  requests.push({url,options});let result={};
  if(url==='consent-config.json')result={projectURL:'https://project.invalid',publishableKey:'public-test',clientID:'approved-client'};
  else if(url.includes('/token?'))result={access_token:'synthetic-access-token'};
  else if(url.endsWith('/user'))result={id:'synthetic-user'};
  else if(url.endsWith('/consent'))result={redirect_url:callback+'?code=synthetic-code'};
  else if(url.includes('/oauth/authorizations/'))result=details??{client:{id:'approved-client'},redirect_uri:callback};
  return {ok:true,status:200,json:async()=>result};
 }};
 if(framed){context.window.top={};context.window.self={};}
 await vm.runInNewContext(`(async()=>{${source}\n})()`,context);
 async function event(id,name='click'){element(id).handlers[name]({preventDefault(){}});await new Promise(r=>setImmediate(r));}
 return {element,requests,storage,redirects,event,replaced};
}
test('consent page requires an authorization request and never stores credentials',async()=>{
 const f=await fixture({search:''});assert.equal(f.element('login').hidden,true);assert.match(f.element('status').textContent,/Start by adding/);assert.equal(f.storage.size,0);
});
test('consent page refuses to run in an iframe',async()=>{await assert.rejects(fixture({framed:true}),/own tab/);});
test('password login uses Supabase directly and waits for explicit approval',async()=>{
 const f=await fixture();await f.event('login','submit');
 assert.equal(f.element('consent').hidden,false);assert.equal(f.redirects.length,0);assert.equal(f.element('password').value,'');assert.equal(f.storage.size,0);
 const request=f.requests.find(r=>r.url.includes('/token?'));assert.equal(request.url,'https://project.invalid/auth/v1/token?grant_type=password');assert.equal(request.options.credentials,'omit');
 await f.event('approve');assert.equal(f.redirects[0],callback+'?code=synthetic-code');
});
test('unapproved clients and unexpected redirect destinations are rejected',async()=>{
 for(const details of [{client:{id:'other-client'},redirect_uri:callback},{redirect_url:'https://evil.invalid/?code=x'}]){
  const f=await fixture({details});await f.event('login','submit');assert.equal(f.element('consent').hidden,true);assert.equal(f.redirects.length,0);
 }
});
test('magic link is requested only by a user action and cannot create accounts',async()=>{
 const f=await fixture();assert.ok(!f.requests.some(r=>r.url.includes('/otp')));await f.event('magic');
 const request=f.requests.find(r=>r.url.includes('/otp'));assert.equal(JSON.parse(request.options.body).create_user,false);assert.equal(f.storage.size,1);assert.equal(f.storage.get('streamline-authorization-id'),'synthetic-request');
});
test('email-link token is removed from URL history and never persisted',async()=>{
 const f=await fixture({hash:'#access_token=synthetic-access-token&refresh_token=synthetic-refresh-token'});
 assert.ok(!f.replaced.includes('token'));assert.equal(f.element('consent').hidden,false);assert.equal(f.storage.size,0);
 assert.ok(f.requests.some(r=>r.url.endsWith('/user')&&r.options.headers.Authorization==='Bearer synthetic-access-token'));
});

test('consent CSP permits its configuration fetch and only the authentication origin',async()=>{
 const html=await readFile(new URL('../docs/consent.html',import.meta.url),'utf8');
 const config=JSON.parse(await readFile(new URL('../docs/consent-config.json',import.meta.url),'utf8'));
 const policy=html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
 const directives=new Map(policy.split(';').map(part=>{const [name,...sources]=part.trim().split(/\s+/);return [name,sources];}));
 assert.deepEqual(directives.get('connect-src'),["'self'",new URL(config.projectURL).origin]);
 assert.deepEqual(directives.get('default-src'),["'none'"]);
 assert.deepEqual(directives.get('script-src'),["'self'"]);
});
