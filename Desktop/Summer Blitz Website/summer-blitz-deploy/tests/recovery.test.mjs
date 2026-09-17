import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery, readRecoveryLink, REDIRECT_URL } from '../reset-password/recovery.mjs';
const good = 'https://stkpoolleague.com/reset-password/#type=recovery&access_token=abc&refresh_token=def&expires_at=9999999999';
function setup(overrides={}) {
 const calls=[];
 const auth={setSession:async x=>(calls.push(['session',x]),{data:{session:{user:{id:'u'}}},error:null}),getUser:async()=>({data:{user:{id:'u'}},error:null}),updateUser:async x=>(calls.push(['update',x]),{data:{user:{id:'u'}},error:null}),signOut:async x=>(calls.push(['out',x]),{error:null}),resetPasswordForEmail:async(...x)=>(calls.push(['reset',...x]),{error:null}),...overrides};
 const controller=createRecovery(auth);return {controller,calls};
}
test('only complete recovery fragments accepted; code/ordinary/errors/expired rejected',()=>{
 assert.equal(readRecoveryLink(good).kind,'recovery');
 for(const suffix of ['','?code=abc','#type=signup&access_token=a&refresh_token=b','#type=recovery&access_token=a','#error=access_denied&error_description=secret','#type=recovery&access_token=a&refresh_token=b&expires_at=1']) assert.notEqual(readRecoveryLink('https://example.com/'+suffix).kind,'recovery');
});
test('ordinary session never enables update',async()=>{const {controller,calls}=setup();await controller.start(readRecoveryLink('https://x/'));await controller.update('password123','password123');assert.equal(calls.length,0);assert.equal(controller.state.phase,'request');});
test('valid recovery verifies server user before ready',async()=>{const {controller,calls}=setup();await controller.start(readRecoveryLink(good));assert.equal(controller.state.phase,'ready');await controller.update('password123','different');assert.equal(calls.filter(x=>x[0]==='update').length,0);await controller.update('short','short');assert.equal(calls.filter(x=>x[0]==='update').length,0);await controller.update('password123','password123');assert.equal(controller.state.phase,'success');assert.deepEqual(calls.at(-1),['out',{scope:'local'}]);});
test('invalid server identity fails closed',async()=>{const {controller}=setup({getUser:async()=>({data:{user:null},error:{message:'SECRET'}})});await controller.start(readRecoveryLink(good));assert.equal(controller.state.phase,'invalid');assert.ok(!controller.state.message.includes('SECRET'));});
test('session rejection and getUser rejection fail closed',async()=>{for(const method of ['setSession','getUser']){const {controller}=setup({[method]:async()=>{throw Error('SECRET')}});await controller.start(readRecoveryLink(good));assert.equal(controller.state.phase,'invalid');assert.ok(!controller.state.message.includes('SECRET'));}});
test('request specifies exact destination and hides account existence',async()=>{const {controller,calls}=setup();await controller.request(' test@example.com ');assert.deepEqual(calls[0],['reset','test@example.com',{redirectTo:REDIRECT_URL}]);assert.equal(controller.state.phase,'sent');});
test('request rejection gives safe retry',async()=>{const {controller}=setup({resetPasswordForEmail:async()=>{throw Error('SECRET')}});await controller.request('test@example.com');assert.equal(controller.state.phase,'request');assert.ok(!controller.state.message.includes('SECRET'));});
test('update rejection permits retry without success',async()=>{const {controller}=setup({updateUser:async()=>{throw Error('SECRET')}});await controller.start(readRecoveryLink(good));await controller.update('password123','password123');assert.equal(controller.state.phase,'ready');assert.ok(!controller.state.message.includes('SECRET'));});
test('double submit makes exactly one password update',async()=>{let release;let count=0;const {controller}=setup({updateUser:()=>{count++;return new Promise(r=>release=r)}});await controller.start(readRecoveryLink(good));const first=controller.update('password123','password123');await controller.update('password123','password123');assert.equal(count,1);release({data:{user:{id:'u'}},error:null});await first;assert.equal(controller.state.phase,'success');});
test('signout rejection after update retains success',async()=>{const {controller}=setup({signOut:async()=>{throw Error('SECRET')}});await controller.start(readRecoveryLink(good));await controller.update('password123','password123');assert.equal(controller.state.phase,'success');});
