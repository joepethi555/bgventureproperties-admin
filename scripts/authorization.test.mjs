import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.ts';
function env(role='agent',assigned=2){return {DB:{prepare(sql){return {bind(){return this},async first(){if(sql.includes('FROM sessions'))return {sid:'test',expires_at:'2099-01-01 00:00:00',id:1,email:'test@example.invalid',name:'Test',role};if(sql.includes('FROM properties WHERE'))return {id:1,agent_id:assigned};return {assigned_agent:assigned}}}}}}}
function req(path,method='GET',headers={}){return new Request('https://test.invalid'+path,{method,headers:{cookie:'bgv_session=test',...headers}})}
test('unauthenticated protected endpoints reject requests',async()=>assert.equal((await worker.fetch(new Request('https://test.invalid/api/admin/properties'),env())).status,401));
test('agents cannot read another agent property',async()=>assert.equal((await worker.fetch(req('/api/admin/properties/1'),env())).status,403));
test('agents cannot duplicate properties',async()=>assert.equal((await worker.fetch(req('/api/admin/properties/1/duplicate','POST'),env('agent',1))).status,403));
test('analytics viewers cannot access inquiry PII',async()=>assert.equal((await worker.fetch(req('/api/admin/inquiries'),env('analytics_viewer'))).status,403));
test('agents cannot modify another agent inquiry',async()=>assert.equal((await worker.fetch(req('/api/admin/inquiries/1','PATCH'),env())).status,403));
test('cross-origin writes are rejected before database access',async()=>assert.equal((await worker.fetch(req('/api/auth/logout','POST',{origin:'https://other.invalid'}),{})).status,403));
