let mediaProperty=null,mediaImages=[],dragImage=null;
const mediaNotice=text=>{document.querySelector('#mediaStatus').textContent=text};
function mediaButton(text,action){const b=document.createElement('button');b.type='button';b.className='btn-sm ghost';b.textContent=text;b.onclick=()=>Promise.resolve(action()).catch(e=>mediaNotice(e.message));return b}
window.openMedia=async id=>{
 mediaProperty=id;document.querySelectorAll('.view').forEach(v=>v.classList.remove('on'));document.querySelector('#v-media').classList.add('on');document.querySelector('#vtitle').textContent='Manage property images';document.querySelector('#uploadQueue').replaceChildren();mediaNotice('Loading images…');
 try{await loadMedia()}catch(e){mediaNotice(e.message)}
};
async function loadMedia(){const id=mediaProperty;const data=await api('/admin/properties/'+id+'/media');if(id!==mediaProperty)return;mediaImages=data.images;const gallery=document.querySelector('#mediaGallery');gallery.replaceChildren();
 for(const [index,image] of mediaImages.entries()){
  const card=document.createElement('article');card.className='card';card.draggable=true;
  card.ondragstart=()=>{dragImage=image.id};card.ondragover=e=>e.preventDefault();card.ondrop=e=>{e.preventDefault();const from=mediaImages.findIndex(i=>i.id===dragImage);if(from>=0)moveMedia(from,index).catch(e=>mediaNotice(e.message))};
  const preview=document.createElement('a');preview.href='/api/admin/properties/'+id+'/media/'+image.id;preview.target='_blank';preview.rel='noopener';preview.setAttribute('aria-label','Open full photograph');
  const img=document.createElement('img');img.src=preview.href;img.alt=image.alt_text||'Property photograph preview';img.style.cssText='width:100%;height:180px;object-fit:cover;border-radius:8px';preview.append(img);card.append(preview);
  const title=document.createElement('p');title.textContent=(image.is_main?'Cover · ':'')+(image.original_filename||'Photograph');card.append(title);
  const info=document.createElement('small');info.textContent=image.width+' × '+image.height+' · '+Math.round(image.file_size/1024)+' KB · '+image.created_at;card.append(info);
  const controls={};for(const [key,label] of [['alt_text','Alternative text'],['caption','Caption'],['image_category','Image category']]){const l=document.createElement('label');l.textContent=label;const input=document.createElement('input');input.value=image[key]||'';input.maxLength=500;l.append(input);controls[key]=input;card.append(l)}
  card.append(mediaButton('Save description',async()=>{await api('/admin/properties/'+id+'/media/'+image.id,'PATCH',Object.fromEntries(Object.entries(controls).map(([k,input])=>[k,input.value])));mediaNotice('Image description saved')}));
  card.append(mediaButton('Set cover',async()=>{await api('/admin/properties/'+id+'/media/'+image.id,'PATCH',{is_main:true});await loadMedia()}));
  card.append(mediaButton('Move up',()=>moveMedia(index,index-1)),mediaButton('Move down',()=>moveMedia(index,index+1)));
  if(['super_admin','property_manager'].includes(ME.role)){
   card.append(mediaButton(image.approved?'Unapprove':'Approve for publication',async()=>{await api('/admin/properties/'+id+'/media/'+image.id,'PATCH',{approved:!image.approved,alt_text:controls.alt_text.value});await loadMedia()}));
   card.append(mediaButton('Remove image',async()=>{if(!confirm('Remove this image from the listing? The stored original is retained privately for recovery.'))return;await api('/admin/properties/'+id+'/media/'+image.id,'DELETE');await loadMedia()}));
  }
  gallery.append(card);
 }
 mediaNotice(mediaImages.length?mediaImages.length+' image(s). Drag to reorder or use Move up/down.':'No images yet. Select multiple photographs to upload.');
}
async function moveMedia(from,to){if(to<0||to>=mediaImages.length||from===to)return;const ids=mediaImages.map(i=>i.id);ids.splice(to,0,ids.splice(from,1)[0]);await api('/admin/properties/'+mediaProperty+'/media','PATCH',{order:ids});await loadMedia()}
function queueFiles(files){
 for(const file of files){
  const propertyId=mediaProperty;if(!propertyId)return;
  const row=document.createElement('div');row.className='card';const status=document.createElement('p');status.textContent=file.name;
  const progress=document.createElement('progress');progress.max=100;progress.value=0;progress.setAttribute('aria-label','Upload progress');const retry=mediaButton('Retry',()=>start());const cancel=mediaButton('Cancel',()=>xhr?.abort());row.append(status,progress,cancel,retry);document.querySelector('#uploadQueue').append(row);let xhr;
  function start(){
   if(file.size>10*1024*1024||!['image/jpeg','image/png'].includes(file.type)){status.textContent=file.name+' — choose a JPEG or PNG under 10 MB';return}
   retry.hidden=true;cancel.hidden=false;xhr=new XMLHttpRequest();xhr.open('POST','/api/admin/properties/'+propertyId+'/media');xhr.setRequestHeader('content-type',file.type);xhr.setRequestHeader('x-filename',file.name.replace(/[^a-zA-Z0-9_. -]/g,'_'));xhr.upload.onprogress=e=>{if(e.lengthComputable)progress.value=e.loaded/e.total*100};
   xhr.onload=()=>{cancel.hidden=true;let data;try{data=JSON.parse(xhr.responseText)}catch{data={error:'Upload failed'}}if(xhr.status>=200&&xhr.status<300){progress.value=100;status.textContent=file.name+(data.duplicate?' — already uploaded':' — uploaded privately');if(mediaProperty===propertyId)loadMedia().catch(e=>mediaNotice(e.message))}else{status.textContent=file.name+' — '+(data.error||'Upload failed');retry.hidden=false}};
   xhr.onerror=()=>{status.textContent=file.name+' — network error';retry.hidden=false;cancel.hidden=true};xhr.onabort=()=>{status.textContent=file.name+' — cancelled; refresh the gallery to check whether the upload completed';retry.hidden=false;cancel.hidden=true};xhr.send(file);
  }
  start();
 }
}
document.querySelector('#mediaFiles').onchange=e=>{queueFiles(e.target.files);e.target.value=''};
const drop=document.querySelector('#mediaDrop');drop.ondragover=e=>e.preventDefault();drop.ondrop=e=>{e.preventDefault();queueFiles(e.dataTransfer.files)};
