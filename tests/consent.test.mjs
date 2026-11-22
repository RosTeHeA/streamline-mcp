import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto,createHash} from 'node:crypto';
import vm from 'node:vm';
const source=await readFile(new URL('../consent/consent.js',import.meta.url),'utf8');
const callback='https://claude.ai/api/mcp/auth_callback';
const origin='https://signin.example.invalid';
const flowKey='streamline-signin-pkce';
async function fixture({search='?authorization_id=synthetic-request',details,hash='',framed=false,storage=new Map(),pageOrigin=origin,failPath}={}){
 const elements=new Map(),requests=[],redirects=[];let replaced;
 function element(id){if(!elements.has(id))elements.set(id,{hidden:['login','consent'].includes(id),value:id==='email'?'test@example.invalid':'synthetic-password',handlers:{},addEventListener(event,fn){this.handlers[event]=fn;},reportValidity:()=>true});return elements.get(id);}
 const context={URL,URLSearchParams,TextEncoder,Uint8Array,crypto:webcrypto,btoa,console:{log(){throw Error('Do not log credentials');}},document:{getElementById:element,querySelectorAll:()=>[]},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},history:{replaceState:(_,__,value)=>replaced=value},window:{location:{hash,origin:pageOrigin,pathname:'/consent.html',search,href:pageOrigin+'/consent.html'+search,assign:url=>redirects.push(url)}},fetch:async(url,options={})=>{
  requests.push({url,options});let result={};
  if(url==='consent-config.json')result={projectURL:'https://project.invalid',publishableKey:'public-test',clientID:'approved-client',consentOrigin:origin};
  else if(url.includes('/token?'))result={access_token:'synthetic-access-token',refresh_token:'synthetic-refresh-token'};
  else if(url.endsWith('/user'))result={id:'synthetic-user'};
  else if(url.endsWith('/consent'))result={redirect_url:callback+'?code=synthetic-code'};
  else if(url.includes('/oauth/authorizations/'))result=details??{client:{id:'approved-client'},redirect_uri:callback};
  return {ok:!failPath||!url.includes(failPath),status:200,json:async()=>result};
 }};
 if(framed){context.window.top={};context.window.self={};}
 await vm.runInNewContext(`(async()=>{${source}\n})()`,context);
 async function event(id,name='click'){await element(id).handlers[name]({preventDefault(){}});}
 return {element,requests,storage,redirects,event,replaced};
}
test('consent requires a valid request on its production origin before login',async()=>{
 for(const opts of [{search:''},{pageOrigin:'https://preview.example.invalid'}]){
  const f=await fixture(opts);assert.equal(f.element('login').hidden,true);await f.event('login','submit');assert.equal(f.requests.length,1);assert.equal(f.storage.size,0);
 }
});
test('consent page refuses to run in an iframe',async()=>{await assert.rejects(fixture({framed:true}),/own tab/);});
test('password login uses Supabase directly and waits for explicit approval',async()=>{
 const f=await fixture();await f.event('login','submit');
 assert.equal(f.element('consent').hidden,false);assert.equal(f.redirects.length,0);assert.equal(f.element('password').value,'');assert.equal(f.storage.size,0);
 const request=f.requests.find(r=>r.url.includes('/token?'));assert.equal(request.url,'https://project.invalid/auth/v1/token?grant_type=password');assert.equal(request.options.credentials,'omit');
 await f.event('approve');assert.equal(f.redirects[0],callback+'?code=synthetic-code');
});
test('failed sign-in clears password and does not permit consent',async()=>{
 const f=await fixture({failPath:'/token?'});await f.event('login','submit');await f.event('approve');
 assert.equal(f.element('password').value,'');assert.equal(f.element('consent').hidden,true);assert.ok(!f.requests.some(r=>r.url.endsWith('/consent')));
});
test('unapproved clients and unexpected redirect destinations are rejected',async()=>{
 for(const details of [{client:{id:'other-client'},redirect_uri:callback},{redirect_url:'https://evil.invalid/?code=x'},{redirect_url:'https://user:password@claude.ai/api/mcp/auth_callback'}]){
  const f=await fixture({details});await f.event('login','submit');assert.equal(f.element('consent').hidden,true);assert.equal(f.redirects.length,0);
 }
});
test('magic link requires user action and uses a random S256 PKCE challenge without signup',async()=>{
 const f=await fixture();assert.ok(!f.requests.some(r=>r.url.includes('/otp')));await f.event('magic');
 const request=f.requests.find(r=>r.url.includes('/otp')),body=JSON.parse(request.options.body),flow=JSON.parse(f.storage.get(flowKey));
 assert.equal(body.create_user,false);assert.equal(body.code_challenge_method,'s256');assert.match(flow.verifier,/^[A-Za-z0-9_-]{43}$/);
 assert.equal(body.code_challenge,createHash('sha256').update(flow.verifier).digest('base64url'));
 assert.equal(flow.authorizationID,'synthetic-request');assert.ok(flow.expires>Date.now()&&flow.expires<=Date.now()+600000);
 assert.equal(new URL(request.url).searchParams.get('redirect_to'),origin+'/consent.html?authorization_id=synthetic-request');
 assert.equal(f.storage.size,1);assert.ok(!JSON.stringify([...f.storage]).includes('password'));
 const first=flow.verifier;await f.event('magic');assert.notEqual(JSON.parse(f.storage.get(flowKey)).verifier,first);
});
test('PKCE code exchanges only with matching browser proof and then clears it',async()=>{
 const initial=await fixture();await initial.event('magic');const flow=JSON.parse(initial.storage.get(flowKey));
 const f=await fixture({search:'?authorization_id=synthetic-request&code=synthetic-auth-code',storage:initial.storage});
 const request=f.requests.find(r=>r.url.endsWith('/token?grant_type=pkce'));
 assert.deepEqual(JSON.parse(request.options.body),{auth_code:'synthetic-auth-code',code_verifier:flow.verifier});
 assert.ok(!f.replaced.includes('code='));assert.equal(f.storage.size,0);assert.equal(f.element('consent').hidden,false);assert.equal(f.redirects.length,0);
});
test('missing, expired, foreign and malformed PKCE proofs fail before token exchange',async()=>{
 for(const flow of [null,{verifier:'A'.repeat(43),expires:Date.now()-1,authorizationID:'synthetic-request'},{verifier:'A'.repeat(43),expires:Date.now()+60000,authorizationID:'other-request'},{verifier:'short',expires:Date.now()+60000,authorizationID:'synthetic-request'}]){
  const f=await fixture({search:'?authorization_id=synthetic-request&code=synthetic-auth-code',storage:new Map(flow?[[flowKey,JSON.stringify(flow)]]:[])});
  assert.ok(!f.requests.some(r=>r.url.includes('/token?')));assert.equal(f.element('consent').hidden,true);assert.ok(!f.replaced.includes('code='));
 }
});
test('implicit token links are erased and rejected rather than accepting an injected session',async()=>{
 const f=await fixture({hash:'#access_token=synthetic-access-token&refresh_token=synthetic-refresh-token'});
 assert.ok(!f.replaced.includes('token'));assert.equal(f.element('consent').hidden,true);assert.equal(f.requests.length,1);assert.equal(f.storage.size,0);
});
test('failed email requests remove temporary proof',async()=>{
 const f=await fixture({failPath:'/otp?'});await f.event('magic');assert.equal(f.storage.size,0);
});
test('deployed header policy blocks framing and restricts executable and network sources',async()=>{
 const headers=await readFile(new URL('../consent/_headers',import.meta.url),'utf8');
 const config=JSON.parse(await readFile(new URL('../consent/consent-config.json',import.meta.url),'utf8'));
 const policy=headers.match(/Content-Security-Policy: (.+)/)[1];
 const directives=new Map(policy.split(';').map(part=>{const [name,...sources]=part.trim().split(/\s+/);return [name,sources];}));
 assert.deepEqual(directives.get('connect-src'),["'self'",new URL(config.projectURL).origin]);
 for(const directive of ['default-src','frame-ancestors','base-uri','form-action','object-src'])assert.deepEqual(directives.get(directive),["'none'"]);
 assert.deepEqual(directives.get('script-src'),["'self'"]);
 for(const header of ['X-Frame-Options: DENY','Referrer-Policy: no-referrer','X-Content-Type-Options: nosniff','Cache-Control: no-store','Cross-Origin-Opener-Policy: same-origin'])assert.ok(headers.includes(header));
});
