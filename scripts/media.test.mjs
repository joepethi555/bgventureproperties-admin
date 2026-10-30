import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectImage,readImageBody,MAX_IMAGE_BYTES } from '../src/media.mjs';
test('rejects fake image extensions and malformed bytes',()=>{assert.throws(()=>inspectImage(new TextEncoder().encode('<script>alert(1)</script>')));assert.throws(()=>inspectImage(new Uint8Array([255,216,255,217])))});
test('rejects oversized bodies before reading',async()=>{await assert.rejects(()=>readImageBody(new Request('https://test.invalid',{method:'POST',headers:{'content-length':String(MAX_IMAGE_BYTES+1)},body:'x'})))});
test('PNG signature and dimensions are validated',()=>{const bytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM3sAAAAASUVORK5CYII=','base64'));assert.deepEqual(inspectImage(bytes),{width:1,height:1,mime:'image/png',extension:'png'});const bad=bytes.slice();new DataView(bad.buffer).setUint32(16,50000);assert.throws(()=>inspectImage(bad))});
