import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHandler, type Config } from "./handler.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const client = "test-client";
const claims = { sub: owner, client_id: client, role: "authenticated" };
const cfg: Config = { projectURL: "https://example.invalid", resourceURL: "https://example.invalid/functions/v1/streamline-mcp", publishableKey: "sb_publishable_test", ownerID: owner, clientID: client, writesEnabled: false };
function request(body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }, token = "test", headers: Record<string,string> = {}) {
  return new Request(cfg.resourceURL, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
}
const authResult = { authorized: true, writes_enabled: true };
Deno.test("every request checks identity and rejects foreign origins, absent/invalid auth", async () => {
  let calls=0;
  for(const payload of [{...claims,sub:"other"},{...claims,client_id:"other"},{...claims,role:"service_role"}]){
    const handler=createHandler(cfg,{verify:async()=>payload,rpc:async()=>{calls++;return authResult;}});
    assertEquals((await handler(request())).status,403);
  }
  const handler=createHandler(cfg,{verify:async()=>{throw Error("private verifier detail");},rpc:async()=>{calls++;return authResult;}});
  const r=await handler(request());assertEquals(r.status,401);assert(r.headers.get("WWW-Authenticate")?.includes("resource_metadata="));
  assertEquals((await handler(new Request(cfg.resourceURL))).status,401);
  assertEquals((await handler(request(undefined,"test",{Origin:"https://evil.invalid"}))).status,403);
  assertEquals(calls,0);
});
Deno.test("discovery has a fixed resource and no token requirement", async()=>{
  const handler=createHandler(cfg);
  const r=await handler(new Request("https://untrusted-host.invalid/functions/v1/streamline-mcp/.well-known/oauth-protected-resource"));
  assertEquals(r.status,200);assertEquals((await r.json()).resource,cfg.resourceURL);
});
Deno.test("stateless HTTP initializes and lists only read tools when either write gate is off",async()=>{
  for(const [edge,db] of [[false,true],[true,false]]){
    const handler=createHandler({...cfg,writesEnabled:edge},{verify:async()=>claims,rpc:async()=>({...authResult,writes_enabled:db}),audit:()=>{}});
    const init=await handler(request({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"test",version:"1"}}}));assertEquals(init.status,200);await init.arrayBuffer();
    const r=await handler(request());assertEquals(r.status,200);const tools=(await r.json()).result.tools;
    assertEquals(tools.length,7);assert(tools.every((t:{annotations:{readOnlyHint:boolean}})=>t.annotations.readOnlyHint));
    const denied=await handler(request({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"create_note",arguments:{uuid:owner,request_id:owner,content:"no"}}}));const result=await denied.json();assert(result.error||result.result?.isError);
  }
});
Deno.test("tool runtime validation, sanitization and metadata-only audit",async()=>{
  const seen:string[]=[];const logs:unknown[]=[];
  const handler=createHandler({...cfg,writesEnabled:true},{verify:async()=>claims,rpc:async(_,tool)=>{seen.push(tool);if(tool==="__authorize")return authResult;throw Error("secret task content");},audit:r=>logs.push(r)});
  const invalid=await handler(request({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"search_notes",arguments:{limit:10000}}}));assert((await invalid.json()).result.isError);assert(!seen.includes("search_notes"));
  const r=await handler(request({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"read_note",arguments:{uuid:owner}}}));const text=await r.text();assert(!text.includes("secret task content"));assert(logs.length===1);assertEquals(Object.keys(logs[0] as object).sort(),["duration_ms","event","ok","tool"]);
});
Deno.test("size, content type, batches, revocation and malformed requests fail closed",async()=>{
  const handler=createHandler(cfg,{verify:async()=>claims,rpc:async()=>authResult});
  assertEquals((await handler(request("x".repeat(100000)))).status,413);
  assertEquals((await handler(request([]))).status,400);
  assertEquals((await handler(request({},"test",{"Content-Type":"text/plain"}))).status,415);
  const revoked=createHandler(cfg,{verify:async()=>claims,rpc:async()=>{throw Error("revoked");}});assertEquals((await revoked(request())).status,403);
  const limited=createHandler(cfg,{verify:async()=>claims,rpc:async()=>({error:"Rate limit"})});assertEquals((await limited(request())).status,429);
});
Deno.test("real JWT verification rejects expiry, wrong audience/issuer and bad signatures",async()=>{
  const keys=await generateKeyPair("ES256");const jwk=await exportJWK(keys.publicKey);jwk.kid="test";
  const controller=new AbortController();const server=Deno.serve({hostname:"127.0.0.1",port:0,signal:controller.signal,onListen:()=>{}},()=>Response.json({keys:[jwk]}));
  try{
    const projectURL=`http://127.0.0.1:${server.addr.port}`;
    const handler=createHandler({...cfg,projectURL},{rpc:async()=>authResult,audit:()=>{}});
    async function token(extra:{aud?:string;iss?:string;exp?:number}={},key=keys.privateKey){return await new SignJWT(claims).setProtectedHeader({alg:"ES256",kid:"test"}).setIssuer(extra.iss??`${projectURL}/auth/v1`).setAudience(extra.aud??"authenticated").setExpirationTime(extra.exp??Math.floor(Date.now()/1000)+60).sign(key);}
    const valid=await handler(request(undefined,await token()));assertEquals(valid.status,200);await valid.arrayBuffer();
    for(const jwt of [await token({exp:1}),await token({aud:"other"}),await token({iss:"https://wrong.invalid"}),await token({},(await generateKeyPair("ES256")).privateKey)])assertEquals((await handler(request(undefined,jwt))).status,401);
  }finally{controller.abort();await server.finished;}
});
