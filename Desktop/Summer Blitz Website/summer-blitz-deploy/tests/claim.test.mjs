import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=(await readFile(new URL('../social/stk-data.js',import.meta.url),'utf8')).replace(/^import .*\n/,'').replaceAll('export ','');
const input={token:'a'.repeat(64),playerNumber:'26091301',email:'test@example.com',password:'password123',fullName:'Test Person',phone:'5551234567'};
function setup(overrides={},options={}){const calls=[];const sb={auth:{getSession:async()=>({data:{session:null}}),signUp:async x=>(calls.push(['signup',x]),{data:{session:{user:{email:input.email}}},error:null}),signInWithPassword:async x=>(calls.push(['signin',x]),{data:{session:{user:{email:input.email}}},error:null}),...overrides},rpc:options.rpc||(async(...args)=>(calls.push(['rpc',...args]),{data:'player-uuid',error:null}))};const context={window:{},createClient:()=>sb,fetch:options.fetch,AbortController,URLSearchParams,Intl,Date,console,setTimeout,clearTimeout};vm.runInNewContext(source,context);return {auth:context.window.STKData.auth,calls};}
test('invalid numbers and missing token rejected before auth side effects',async()=>{for(const claim of [{...input,token:''},...['', '1.2','-1','9223372036854775808'].map(playerNumber=>({...input,playerNumber}))]){const {auth,calls}=setup();assert.ok((await auth.claim(claim)).error);assert.equal(calls.length,0);}});
test('number travels as exact bigint string and RPC never accepts client email',async()=>{const {auth,calls}=setup();const result=await auth.claim({...input,playerNumber:'9007199254740993'});assert.equal(result.player_id,'player-uuid');assert.equal(calls[1][1],'claim_player_invite');assert.equal(calls[1][2].p_player_number,'9007199254740993');assert.equal('p_email' in calls[1][2],false);});
test('confirmation-required signup never claims without session',async()=>{const {auth,calls}=setup({signUp:async()=>({data:{session:null},error:null})});assert.ok((await auth.claim(input)).error);assert.equal(calls.length,0);});
test('different existing login cannot silently claim',async()=>{const {auth,calls}=setup({getSession:async()=>({data:{session:{user:{email:'other@example.com'}}}})});assert.ok((await auth.claim(input)).error);assert.equal(calls.length,0);});
test('rejected network promise gives safe recoverable error',async()=>{const {auth}=setup({getSession:async()=>{throw Error('SECRET')}});const result=await auth.claim(input);assert.ok(result.error);assert.ok(!result.error.includes('SECRET'));});
test('invite preview does not wait for a blocked authenticated client RPC',async()=>{const requests=[];const {auth}=setup({}, {
  rpc:()=>new Promise(()=>{}),
  fetch:async(url,init)=>{requests.push([url,init]);return {ok:true,json:async()=>[{state:'live'}]};},
});const result=await Promise.race([auth.previewInvite(input.token),new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),25))]);assert.equal(result.state,'live');assert.equal(result.timeout,undefined);assert.equal(requests.length,1);assert.match(requests[0][0],/\/rest\/v1\/rpc\/player_invite_preview$/);});
