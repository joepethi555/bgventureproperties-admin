export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export function inspectImage(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height, mime, extension;
  if (bytes.length >= 33 && [137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n) && v.getUint32(8)===13 && String.fromCharCode(...bytes.slice(12,16))==='IHDR') {
    width=v.getUint32(16);height=v.getUint32(20);mime='image/png';extension='png';
    if (String.fromCharCode(...bytes.slice(-8,-4))!=='IEND') throw new Error('Incomplete PNG');
  } else if (bytes.length>=4 && bytes[0]===255 && bytes[1]===216) {
    // Require the EOI marker, but tolerate app-level trailers appended after it
    // (some export tools write metadata past FF D9).
    let eoi=false;for(let i=bytes.length-2;i>=Math.max(0,bytes.length-65536);i--){if(bytes[i]===255&&bytes[i+1]===217){eoi=true;break}}
    if(!eoi)throw new Error('Incomplete JPEG');
    let offset=2;
    while(offset+4<=bytes.length){
      if(bytes[offset++]!==255)throw new Error('Invalid JPEG marker');
      while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];
      if(marker===0xda||marker===0xd9)break;
      const size=v.getUint16(offset);
      if(size<2||offset+size>bytes.length)throw new Error('Invalid JPEG segment');
      if([0xc0,0xc1,0xc2].includes(marker)&&size>=8){height=v.getUint16(offset+3);width=v.getUint16(offset+5);mime='image/jpeg';extension='jpg';break}
      offset+=size;
    }
  }
  if(!mime||!width||!height||width>12000||height>12000||width*height>40000000)throw new Error('Upload a JPEG or PNG image, up to 12,000px per side and 40 megapixels');
  return {width,height,mime,extension};
}
export async function readImageBody(request) {
  if(Number(request.headers.get('content-length'))>MAX_IMAGE_BYTES)throw new Error('Maximum image size is 16 MB');
  if(!request.body)throw new Error('Image required');
  const reader=request.body.getReader();const chunks=[];let size=0;
  while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>MAX_IMAGE_BYTES){await reader.cancel();throw new Error('Maximum image size is 16 MB')}chunks.push(r.value)}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}return bytes;
}
export async function handleMedia(req,env,session,propertyId,imageId,json) {
  if(!session)return json({error:'Authentication required'},401);
  const role=String(session.user.role), userId=Number(session.user.id);
  if(!['super_admin','property_manager','listing_editor','agent'].includes(role))return json({error:'Forbidden'},403);
  const property=await env.DB.prepare('SELECT id,agent_id FROM properties WHERE id=?').bind(propertyId).first();
  if(!property)return json({error:'Not found'},404);
  if(role==='agent'&&Number(property.agent_id)!==userId)return json({error:'Forbidden'},403);
  const base='/api/admin/properties/'+propertyId+'/media';
  if(req.method==='GET'&&!imageId){const rows=await env.DB.prepare('SELECT id,caption,alt_text,is_main,position,original_filename,mime_type,file_size,width,height,image_category,approved,created_at,sha256 FROM property_images WHERE property_id=? AND deleted_at IS NULL ORDER BY position,id').bind(propertyId).all();return json({images:rows.results})}
  if(req.method==='PATCH'&&!imageId){
    const b=await req.json().catch(()=>null);const ids=b?.order;
    if(!Array.isArray(ids)||ids.length>500||ids.some(id=>!Number.isSafeInteger(id))||new Set(ids).size!==ids.length)return json({error:'Invalid image order'},400);
    const rows=await env.DB.prepare('SELECT id FROM property_images WHERE property_id=? AND deleted_at IS NULL').bind(propertyId).all();
    if(rows.results.length!==ids.length||rows.results.some(r=>!ids.includes(r.id)))return json({error:'Order must contain every active image for this property'},400);
    await env.DB.batch([...ids.map((id,index)=>env.DB.prepare('UPDATE property_images SET position=? WHERE property_id=? AND id=?').bind(index,propertyId,id)),mediaAudit(env,userId,'media.reorder',propertyId)]);return json({ok:true});
  }
  if(imageId){
    const image=await env.DB.prepare('SELECT * FROM property_images WHERE property_id=? AND id=? AND deleted_at IS NULL').bind(propertyId,imageId).first();
    if(!image)return json({error:'Not found'},404);
    if(req.method==='GET')return imageResponse(env,image);
    if(req.method==='PATCH'){
      const b=await req.json().catch(()=>null);if(!b||typeof b!=='object')return json({error:'Invalid metadata'},400);
      if('approved' in b&&!['super_admin','property_manager'].includes(role))return json({error:'Only publishers may approve images'},403);
      for(const k of ['caption','alt_text','image_category'])if(k in b&&(typeof b[k]!=='string'||b[k].length>500))return json({error:'Invalid '+k},400);
      if(b.approved===true&&!String(b.alt_text??image.alt_text??'').trim())return json({error:'Add alternative text before approval'},400);
      const updates=[],args=[];
      for(const k of ['caption','alt_text','image_category'])if(k in b){updates.push(k+'=?');args.push(b[k])}
      if('approved' in b){updates.push('approved=?');args.push(b.approved===true?1:0)}
      const statements=[];
      if(b.is_main===true){statements.push(env.DB.prepare('UPDATE property_images SET is_main=0 WHERE property_id=?').bind(propertyId));updates.push('is_main=1')}
      if(!updates.length)return json({error:'No metadata to update'},400);
      statements.push(env.DB.prepare('UPDATE property_images SET '+updates.join(',')+' WHERE property_id=? AND id=?').bind(...args,propertyId,imageId));
      statements.push(mediaAudit(env,userId,'media.update',imageId));await env.DB.batch(statements);return json({ok:true});
    }
    if(req.method==='DELETE'){
      if(!['super_admin','property_manager'].includes(role))return json({error:'Forbidden'},403);
      await env.DB.batch([env.DB.prepare("UPDATE property_images SET deleted_at=datetime('now'),is_main=0,approved=0 WHERE property_id=? AND id=?").bind(propertyId,imageId),mediaAudit(env,userId,'media.soft_delete',imageId)]);
      return json({ok:true});
    }
  }
  if(req.method==='POST'&&!imageId){
    if(!env.MEDIA)return json({error:'Media storage is not configured'},503);
    let bytes,info;try{bytes=await readImageBody(req);info=inspectImage(bytes)}catch(e){return json({error:e.message},400)}
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
    const existing=await env.DB.prepare('SELECT id FROM property_images WHERE property_id=? AND sha256=? AND deleted_at IS NULL').bind(propertyId,hash).first();
    if(existing)return json({id:existing.id,duplicate:true});
    const key='properties/'+propertyId+'/'+crypto.randomUUID()+'.'+info.extension;
    const filename=(req.headers.get('x-filename')||'image').replace(/[^a-zA-Z0-9_. -]/g,'_').slice(0,150);
    await env.MEDIA.put(key,bytes,{httpMetadata:{contentType:info.mime}});
    const r=await env.DB.prepare('INSERT INTO property_images(property_id,r2_key,original_filename,mime_type,file_size,width,height,sha256,position,uploaded_by) VALUES(?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM property_images WHERE property_id=?),?)').bind(propertyId,key,filename,info.mime,bytes.length,info.width,info.height,hash,propertyId,userId).run();
    await mediaAudit(env,userId,'media.upload',r.meta.last_row_id).run();
    return json({id:r.meta.last_row_id,url:base+'/'+r.meta.last_row_id},201);
  }
  return json({error:'Unsupported media action'},405);
}
function mediaAudit(env,userId,action,id){return env.DB.prepare('INSERT INTO audit_logs(user_id,action,entity,entity_id) VALUES(?,?,?,?)').bind(userId,action,'property_image',String(id))}
export async function imageResponse(env,image) {
  if(!env.MEDIA)return new Response('Storage not configured',{status:503});
  const object=await env.MEDIA.get(image.r2_key);if(!object)return new Response('Image not found',{status:404});
  return new Response(object.body,{headers:{'content-type':image.mime_type||'application/octet-stream','x-content-type-options':'nosniff','content-disposition':'inline','cache-control':'private, no-store','content-security-policy':"default-src 'none'; sandbox"}});
}
