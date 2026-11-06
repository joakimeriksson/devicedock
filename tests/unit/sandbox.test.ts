import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sandboxExists,container} from '../../apps/server/sandbox.ts';

test('first startup detects an absent container without parsing Docker error text',async()=>{
 assert.equal(await sandboxExists(async args=>{assert.deepEqual(args,['container','ls','--all','--filter',`name=^/${container}$`,'--format','{{.Names}}']);return '';}),false);
});
test('startup detects an existing stopped or running container by exact name',async()=>{
 assert.equal(await sandboxExists(async()=>container+'\n'),true);
 assert.equal(await sandboxExists(async()=>container+'-other'),false);
});
test('Docker access failures propagate instead of being treated as missing container',async()=>{
 await assert.rejects(sandboxExists(async()=>{throw Error('permission denied');}),/permission denied/);
});
