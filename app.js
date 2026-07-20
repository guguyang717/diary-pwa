/* 个人日记本 · 纯浏览器端 PWA 版（零后端、零云，数据全留本机）
 * 存储：IndexedDB（entries 存条目，media 存照片/音频/文档 Blob）
 * 录音/语音转文字：已移除，改用「输入法自带麦克风」说话转文字 + 上传音频/文档文件
 * 备份：导出为单个 JSON（含媒体 base64），导入按 id 覆盖合并
 */
'use strict';

const $ = (id) => document.getElementById(id);
const TYPE_META = {
  life:   {label:'生活', cls:'life'},
  invest: {label:'投资', cls:'invest'},
  work:   {label:'工作', cls:'work'},
  other:  {label:'其他', cls:'other'}
};
function toast(msg){
  const t=$('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),1900);
}
function today(){ return new Date().toISOString().slice(0,10); }
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp','<':'&lt','>':'&gt','"':'&quot','\'':'&#39'}[c])); }
function uid(){ return (crypto.randomUUID?crypto.randomUUID():('id-'+Date.now()+'-'+Math.random().toString(16).slice(2))); }

/* ---------------- IndexedDB ---------------- */
const DB_NAME='diary-pwa', DB_VER=1;
let _db=null;
function openDB(){
  return new Promise((res,rej)=>{
    if(_db){ res(_db); return; }
    const r=indexedDB.open(DB_NAME,DB_VER);
    r.onupgradeneeded=e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains('entries')) db.createObjectStore('entries',{keyPath:'id'});
      if(!db.objectStoreNames.contains('media'))   db.createObjectStore('media',{keyPath:'id'});
    };
    r.onsuccess=e=>{ _db=e.target.result; res(_db); };
    r.onerror=e=>{ rej(e.target.error); };
  });
}
function _store(name,mode){ return _db.transaction(name,mode).objectStore(name); }
function _req(r){ return new Promise((res,rej)=>{ r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }

async function putEntry(e){ return _req(_store('entries','readwrite').put(e)); }
async function getEntry(id){ return _req(_store('entries','readonly').get(id)); }
async function allEntries(){ return _req(_store('entries','readonly').getAll()); }
async function putMedia(m){ return _req(_store('media','readwrite').put(m)); }
async function getMedia(id){ return _req(_store('media','readonly').get(id)); }
async function delMedia(id){ return _req(_store('media','readwrite').delete(id)); }
async function deleteEntryCascade(id){
  const e=await getEntry(id);
  if(e&&e.media) for(const m of e.media){ if(m.mediaId) try{ await delMedia(m.mediaId); }catch(_){} }
  return _req(_store('entries','readwrite').delete(id));
}

/* ---------------- 状态 ---------------- */
let state = {
  type:'', tag:'', date:'', q:'',
  editingId:null, entryType:'life',
  media:[],            // {mediaId?, kind, name, blob?, url?, mime?}
  lat:null, lng:null,
  _urls:[]
};

/* ---------------- 列表 / 日历 / 标签 ---------------- */
async function loadTags(){
  const all=await allEntries();
  const set={};
  all.forEach(e=>(e.tags||[]).forEach(t=>{ if(t) set[t]=(set[t]||0)+1; }));
  const items=Object.entries(set).sort((a,b)=>b[1]-a[1]).slice(0,12);
  const box=$('tagFilter');
  let html = state.tag? '<span class="chip" data-tag="">× 清除标签</span>':'';
  html += items.map(([t,c])=>`<span class="chip ${state.tag===t?'on':''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)} (${c})</span>`).join('');
  box.innerHTML=html;
  box.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{
    if(c.textContent.startsWith('×')) state.tag='';
    else state.tag = (state.tag===c.dataset.tag)?'':c.dataset.tag;
    loadTags(); loadEntries();
  });
}
async function loadCalendar(){
  const all=await allEntries();
  const cal={};
  all.forEach(e=>{ cal[e.date]=(cal[e.date]||0)+1; });
  const y=new Date().getFullYear(), m=new Date().getMonth()+1;
  const box=$('cal'); const wd=['日','一','二','三','四','五','六'];
  let html=wd.map(d=>`<div class="wd">${d}</div>`).join('');
  const first=new Date(y,m-1,1).getDay();
  const days=new Date(y,m,0).getDate();
  for(let i=0;i<first;i++) html+=`<div class="day blank"></div>`;
  for(let d=1;d<=days;d++){
    const ds=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const cls=`day ${cal[ds]?'has':''} ${state.date===ds?'sel':''}`;
    html+=`<div class="${cls}" data-d="${ds}">${d}</div>`;
  }
  box.innerHTML=html;
  box.querySelectorAll('.day[data-d]').forEach(el=>el.onclick=()=>{
    state.date=(state.date===el.dataset.d)?'':el.dataset.d;
    loadCalendar(); loadEntries();
  });
}
async function loadEntries(){
  let all=await allEntries();
  if(state.type) all=all.filter(e=>e.type===state.type);
  if(state.tag)  all=all.filter(e=>(e.tags||[]).includes(state.tag));
  if(state.date) all=all.filter(e=>e.date===state.date);
  if(state.q){
    const q=state.q.toLowerCase();
    all=all.filter(e=>(e.title||'').toLowerCase().includes(q)||(e.body||'').toLowerCase().includes(q)||(e.location_name||'').toLowerCase().includes(q));
  }
  all.sort((a,b)=> (a.date<b.date?1:a.date>b.date?-1: (a.updated_at<b.updated_at?1:-1)) );
  const box=$('list');
  if(!all.length){ box.innerHTML='<div class="empty">还没有记录，点右上角「写今天」开始吧 ✍️</div>'; return; }
  box.innerHTML=all.map(e=>{
    const meta=TYPE_META[e.type]||TYPE_META.life;
    const tags=(e.tags||[]).map(t=>`<span class="tag">#${escapeHtml(t)}</span>`).join('');
    const loc=e.location_name?`<span class="loc">📍 ${escapeHtml(e.location_name)}</span>`:'';
    let thumbs='';
    (e.media||[]).slice(0,4).forEach(m=>{
      if(m.kind==='image') thumbs+=`<img src="media-thumb:${m.mediaId}" data-mid="${m.mediaId}"/>`;
      else if(m.kind==='audio') thumbs+=`<div class="aud">🎵</div>`;
      else if(m.kind==='file') thumbs+=`<div class="aud">📄</div>`;
      else if(m.kind==='video') thumbs+=`<div class="aud">🎬</div>`;
    });
    const bodyPrev=escapeHtml(e.body||'').replace(/\n/g,'<br>');
    return `<div class="entry" data-id="${e.id}">
      <div class="top"><span class="badge ${meta.cls}">${meta.label}</span><span class="d">${e.date}</span></div>
      <div class="ttl">${escapeHtml(e.title||'（无标题）')}</div>
      <div class="body">${bodyPrev||'<span style="color:#9aa">（无文字内容）</span>'}</div>
      <div class="meta">${tags}${loc}</div>
      ${thumbs?`<div class="thumbs">${thumbs}</div>`:''}
    </div>`;
  }).join('');
  // 给图片缩略图填真实 blob URL
  box.querySelectorAll('img[data-mid]').forEach(async img=>{
    const m=await getMedia(img.dataset.mid);
    if(m&&m.blob){ const u=URL.createObjectURL(m.blob); img.src=u; state._urls.push(u); }
  });
  box.querySelectorAll('.entry').forEach(el=>el.onclick=()=>editEntry(el.dataset.id));
}

/* ---------------- 编辑器 ---------------- */
function resetEditor(){
  state.editingId=null; state.media=[]; state.entryType='life'; state.lat=null; state.lng=null;
  revokeUrls();
  $('editId').value=''; $('editorTitle').textContent='新建记录';
  $('delBtn').style.display='none';
  $('fDate').value=today(); $('fTitle').value=''; $('fBody').value='';
  $('fTags').value=''; $('fLoc').value=''; $('locHint').textContent='';
  setType('life'); renderPreview();
}
function setType(t){
  state.entryType=TYPE_META[t]?t:'life';
  document.querySelectorAll('.type-toggle .opt').forEach(o=>o.classList.toggle('on', o.dataset.t===state.entryType));
}
function openNew(){ resetEditor(); $('editor').scrollIntoView({behavior:'smooth',block:'start'}); }
async function editEntry(id){
  const e=await getEntry(id);
  if(!e){ toast('加载失败'); return; }
  revokeUrls();
  state.editingId=id; state.entryType=e.type||'life'; state.lat=e.lat; state.lng=e.lng;
  // 载入媒体 blob
  state.media=[];
  for(const ref of (e.media||[])){
    const m=ref.mediaId? await getMedia(ref.mediaId):null;
    const blob=m?m.blob:null;
    const url=blob?URL.createObjectURL(blob):'';
    if(url) state._urls.push(url);
    state.media.push({mediaId:ref.mediaId, kind:ref.kind, name:ref.name, blob, url});
  }
  $('editId').value=id; $('editorTitle').textContent='编辑记录';
  $('delBtn').style.display='inline-block';
  $('fDate').value=e.date; $('fTitle').value=e.title||''; $('fBody').value=e.body||'';
  $('fTags').value=(e.tags||[]).join(', '); $('fLoc').value=e.location_name||'';
  $('locHint').textContent=(e.lat!=null)?`已记录坐标：${e.lat}, ${e.lng}`:'';
  setType(e.type||'life'); renderPreview();
  $('editor').scrollIntoView({behavior:'smooth',block:'start'});
}
function renderPreview(){
  const box=$('preview');
  box.innerHTML=state.media.map((m,i)=>{
    let inner;
    if(m.kind==='image') inner=`<img src="${m.url||''}"/>`;
    else if(m.kind==='audio') inner=`<audio controls src="${m.url||''}" preload="metadata"></audio>`;
    else inner=`<div class="doc"><div class="ico">📄</div><div class="nm" title="${escapeHtml(m.name||'文件')}">${escapeHtml(m.name||'文件')}</div></div>`;
    return `<div class="item">${inner}<button class="x" data-i="${i}">×</button></div>`;
  }).join('');
  box.querySelectorAll('.x').forEach(b=>b.onclick=async()=>{
    const i=+b.dataset.i, item=state.media[i];
    if(item.mediaId){ try{ await delMedia(item.mediaId); }catch(_){} }
    if(item.url) URL.revokeObjectURL(item.url);
    state.media.splice(i,1); renderPreview();
  });
}
function revokeUrls(){ state._urls.forEach(u=>{ try{URL.revokeObjectURL(u);}catch(_){} }); state._urls=[]; }

async function saveEntry(){
  const id = state.editingId || uid();
  // 落库媒体
  for(const m of state.media){
    if(!m.mediaId){
      m.mediaId=uid();
      const mime=m.blob?m.blob.type:(m.kind==='image'?'image/png':m.kind==='audio'?'audio/m4a':'application/octet-stream');
      await putMedia({id:m.mediaId, entryId:id, kind:m.kind, name:m.name||'file', mime, blob:m.blob});
    }
  }
  const entry={
    id,
    date:$('fDate').value||today(),
    type:state.entryType,
    title:$('fTitle').value.trim(),
    body:$('fBody').value,
    tags:($('fTags').value.split(',').map(s=>s.trim()).filter(Boolean)),
    location_name:$('fLoc').value.trim(),
    lat:state.lat, lng:state.lng,
    media:state.media.map(m=>({mediaId:m.mediaId, kind:m.kind, name:m.name})),
    created_at: state.editingId ? (await getEntry(id)).created_at : new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await putEntry(entry);
  toast('已保存');
  resetEditor(); refreshAll();
}

/* ---------------- 文件上传（照片 / 音频 / 文档） ---------------- */
function addFiles(files, forceKind){
  for(const f of files){
    const kind=forceKind || (f.type.startsWith('image/')?'image':f.type.startsWith('audio/')?'audio':f.type.startsWith('video/')?'video':'file');
    const url=URL.createObjectURL(f); state._urls.push(url);
    state.media.push({mediaId:null, kind, name:f.name, blob:f, url, mime:f.type});
  }
  renderPreview();
}

/* ---------------- 定位 ---------------- */
function getLocation(){
  if(!navigator.geolocation){ toast('浏览器不支持定位'); return; }
  $('locHint').textContent='定位中…';
  navigator.geolocation.getCurrentPosition(
    (pos)=>{ state.lat=pos.coords.latitude; state.lng=pos.coords.longitude;
      $('locHint').textContent=`已记录坐标：${state.lat.toFixed(4)}, ${state.lng.toFixed(4)}（地点名可手动补充）`; },
    (err)=>{ $('locHint').textContent='定位失败：'+(err.message||'请手动填写'); }
  );
}

/* ---------------- 删除 ---------------- */
async function deleteEntry(id){
  if(!confirm('确定删除这条记录？（含其照片/音频/文档）')) return;
  await deleteEntryCascade(id);
  toast('已删除'); refreshAll();
}

/* ---------------- 备份 / 恢复 ---------------- */
function blobToDataURL(blob){
  return new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=rej; fr.readAsDataURL(blob); });
}
function dataURLToBlob(durl){
  const [head,data]=durl.split(',');
  const mime=head.match(/:(.*?);/)[1];
  const bin=atob(data);
  const arr=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  return new Blob([arr],{type:mime});
}
async function exportBackup(){
  const all=await allEntries();
  const out={app:'diary-pwa', version:1, exportedAt:new Date().toISOString(), entries:[]};
  for(const e of all){
    const media=[];
    for(const ref of (e.media||[])){
      const m=ref.mediaId?await getMedia(ref.mediaId):null;
      media.push({mediaId:ref.mediaId, kind:ref.kind, name:ref.name, data:(m&&m.blob)?await blobToDataURL(m.blob):null});
    }
    out.entries.push({...e, media});
  }
  const blob=new Blob([JSON.stringify(out)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download='diary-backup-'+new Date().toISOString().slice(0,16).replace(/[:T]/g,'')+'.json';
  a.click(); setTimeout(()=>URL.revokeObjectURL(url),4000);
  toast('备份已导出（'+out.entries.length+' 条）');
}
async function importBackup(file){
  try{
    const text=await file.text();
    const data=JSON.parse(text);
    if(!data.entries||!Array.isArray(data.entries)){ toast('文件格式不对'); return; }
    for(const e of data.entries){
      for(const m of (e.media||[])){
        if(m.mediaId&&m.data){ await putMedia({id:m.mediaId, entryId:e.id, kind:m.kind, name:m.name, mime:(m.data.split(';')[0].match(/:(.*?);/)||[])[1]||'application/octet-stream', blob:dataURLToBlob(m.data)}); }
      }
      const {media, ...rest}=e;
      await putEntry({...rest, media:(e.media||[]).map(m=>({mediaId:m.mediaId,kind:m.kind,name:m.name}))});
    }
    toast('恢复完成（按 id 覆盖合并）'); refreshAll();
  }catch(err){ toast('恢复失败：'+err.message); }
}

/* ---------------- 当前筛选下的条目（供回顾/导出复用） ---------------- */
async function filteredEntries(){
  let all=await allEntries();
  if(state.type) all=all.filter(e=>e.type===state.type);
  if(state.tag)  all=all.filter(e=>(e.tags||[]).includes(state.tag));
  if(state.date) all=all.filter(e=>e.date===state.date);
  if(state.q){
    const q=state.q.toLowerCase();
    all=all.filter(e=>(e.title||'').toLowerCase().includes(q)||(e.body||'').toLowerCase().includes(q)||(e.location_name||'').toLowerCase().includes(q));
  }
  all.sort((a,b)=> (a.date<b.date?-1:a.date>b.date?1:0));  // 时间正序，便于阅读
  return all;
}
function filterLabel(){
  const parts=[];
  if(state.type) parts.push('类型：'+(TYPE_META[state.type]?.label||state.type));
  if(state.tag)  parts.push('标签：#'+state.tag);
  if(state.date) parts.push('日期：'+state.date);
  if(state.q)    parts.push('关键词：'+state.q);
  return parts.length? parts.join('　') : '全部记录';
}

/* ---------------- 导出可读 Markdown ---------------- */
async function exportMarkdown(){
  const all=await filteredEntries();
  if(!all.length){ toast('当前筛选下没有记录'); return; }
  const lines=[];
  lines.push('# 我的日记 · '+filterLabel());
  lines.push('');
  lines.push('> 导出时间：'+new Date().toLocaleString('zh-CN')+'　共 '+all.length+' 篇');
  lines.push('');
  let curMonth='';
  for(const e of all){
    const mon=e.date.slice(0,7);
    if(mon!==curMonth){ curMonth=mon; lines.push('\n## '+mon.replace('-','年')+'月\n'); }
    const meta=TYPE_META[e.type]||TYPE_META.life;
    lines.push('### '+e.date+'　['+meta.label+']　'+(e.title||'（无标题）'));
    if(e.tags&&e.tags.length) lines.push('`'+e.tags.map(t=>'#'+t).join('` `')+'`');
    if(e.location_name) lines.push('📍 '+e.location_name);
    lines.push('');
    if(e.body) lines.push(e.body);
    const imgs=(e.media||[]).filter(m=>m.kind==='image').length;
    const auds=(e.media||[]).filter(m=>m.kind==='audio').length;
    const docs=(e.media||[]).filter(m=>m.kind==='file').length;
    const mm=[]; if(imgs) mm.push('🖼 照片 ×'+imgs); if(auds) mm.push('🎵 语音 ×'+auds); if(docs) mm.push('📄 文档 ×'+docs);
    if(mm.length) lines.push('\n*（附件：'+mm.join('，')+'，见完整备份）*');
    lines.push('\n---\n');
  }
  const blob=new Blob([lines.join('\n')],{type:'text/markdown;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download='日记-'+new Date().toISOString().slice(0,10)+'.md';
  a.click(); setTimeout(()=>URL.revokeObjectURL(url),4000);
  toast('已导出可读文档（'+all.length+' 篇）');
}

/* ---------------- 导出可读 Markdown 包（ZIP，零依赖） ---------------- */
// 极简 ZIP（store 无压缩）打包，纯前端实现，不依赖任何库
const CRC_TABLE = (()=>{
  const t=new Uint32Array(256);
  for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); t[n]=c>>>0; }
  return t;
})();
function crc32(bytes){
  let c=0xFFFFFFFF;
  for(let i=0;i<bytes.length;i++) c=CRC_TABLE[(c^bytes[i])&0xFF]^(c>>>8);
  return (c^0xFFFFFFFF)>>>0;
}
function makeZip(files){ // files: [{name:string, data:Uint8Array}]
  const enc=new TextEncoder();
  const chunks=[]; const central=[]; let offset=0;
  const u16=v=>{ const a=new Uint8Array(2); new DataView(a.buffer).setUint16(0,v,true); return a; };
  const u32=v=>{ const a=new Uint8Array(4); new DataView(a.buffer).setUint32(0,v>>>0,true); return a; };
  for(const f of files){
    const nameBytes=enc.encode(f.name); const data=f.data; const crc=crc32(data);
    const lh=new Uint8Array(30+nameBytes.length); const dv=new DataView(lh.buffer);
    dv.setUint32(0,0x04034b50,true); dv.setUint16(4,20,true); dv.setUint16(6,0x0800,true); dv.setUint16(8,0,true);
    dv.setUint16(10,0,true); dv.setUint16(12,0,true); dv.setUint32(14,crc,true);
    dv.setUint32(18,data.length,true); dv.setUint32(22,data.length,true);
    dv.setUint16(26,nameBytes.length,true); dv.setUint16(28,0,true);
    lh.set(nameBytes,30); chunks.push(lh,data);
    const cd=new Uint8Array(46+nameBytes.length); const cdv=new DataView(cd.buffer);
    cdv.setUint32(0,0x02014b50,true); cdv.setUint16(4,20,true); cdv.setUint16(6,20,true); cdv.setUint16(8,0x0800,true);
    cdv.setUint16(10,0,true); cdv.setUint16(12,0,true); cdv.setUint16(14,0,true);
    cdv.setUint32(16,crc,true); cdv.setUint32(20,data.length,true); cdv.setUint32(24,data.length,true);
    cdv.setUint16(28,nameBytes.length,true); cdv.setUint16(30,0,true); cdv.setUint16(32,0,true);
    cdv.setUint16(34,0,true); cdv.setUint16(36,0,true); cdv.setUint32(38,0,true); cdv.setUint32(42,offset,true);
    cd.set(nameBytes,46); central.push(cd);
    offset += lh.length + data.length;
  }
  const cdStart=offset; let cdSize=0; central.forEach(c=>cdSize+=c.length);
  const eocd=new Uint8Array(22); const edv=new DataView(eocd.buffer);
  edv.setUint32(0,0x06054b50,true); edv.setUint16(4,0,true); edv.setUint16(6,0,true);
  edv.setUint16(8,files.length,true); edv.setUint16(10,files.length,true);
  edv.setUint32(12,cdSize,true); edv.setUint32(16,cdStart,true); edv.setUint16(20,0,true);
  return new Blob([...chunks,...central,eocd],{type:'application/zip'});
}
async function exportAllMarkdownZip(){
  const all=await allEntries();
  if(!all.length){ toast('还没有记录'); return; }
  all.sort((a,b)=> a.date<b.date?-1 : a.date>b.date?1 : 0);
  const enc=new TextEncoder();
  const files=[]; const monthMap={};
  for(const e of all){
    const meta=TYPE_META[e.type]||TYPE_META.life;
    const id8=e.id.slice(0,8);
    const fname=`${e.date}-${id8}.md`;
    const y=e.date.slice(0,4), mon=e.date.slice(0,7);
    const relPath=`日记/${y}/${mon}/${fname}`;
    const L=[];
    L.push('# '+e.date+'　'+meta.label+'　'+(e.title||'（无标题）'));
    L.push('');
    L.push('- 类型：'+meta.label);
    if(e.tags&&e.tags.length) L.push('- 标签：'+e.tags.map(t=>'#'+t).join(' '));
    if(e.location_name)   L.push('- 地点：'+e.location_name);
    if(e.lat!=null)       L.push('- 坐标：'+e.lat+', '+e.lng);
    L.push('- 创建：'+(e.created_at||''));
    L.push('- 更新：'+(e.updated_at||''));
    L.push(''); L.push('---'); L.push('');
    L.push(e.body||'（无文字内容）');
    const mediaRefs=(e.media||[]).filter(m=>m.mediaId);
    if(mediaRefs.length){
      L.push(''); L.push('## 附件');
      for(const m of mediaRefs){
        const mm=await getMedia(m.mediaId);
        if(mm&&mm.blob){
          const mname=`${e.id}-${m.name}`;
          files.push({name:`media/${mname}`, data:new Uint8Array(await mm.blob.arrayBuffer())});
          const icon=m.kind==='image'?'🖼':m.kind==='audio'?'🎵':'📄';
          L.push(`- ${icon} [${m.name}](../../media/${mname})`);
        }
      }
    }
    files.push({name:relPath, data:enc.encode(L.join('\n'))});
    (monthMap[mon]=monthMap[mon]||[]).push({date:e.date, title:e.title||'（无标题）', rel:fname});
  }
  // 每月汇总
  for(const [mon,items] of Object.entries(monthMap)){
    const [y,m]=mon.split('-');
    let s=`# ${y}年${parseInt(m)}月 日记（${items.length} 篇）\n\n`;
    for(const it of items) s+=`- ${it.date} [${it.title}](./${it.rel})\n`;
    files.push({name:`日记/${y}/${mon}.md`, data:enc.encode(s)});
  }
  // 总目录
  let idx=`# 我的日记总目录\n\n> 共 ${all.length} 篇。点链接跳到各篇；每天一篇独立 .md，可用任意笔记软件 / Obsidian / 备忘录打开整理。\n\n`;
  for(const [mon,items] of Object.entries(monthMap)){
    const [y,m]=mon.split('-');
    idx+=`## ${y}年${parseInt(m)}月（${items.length} 篇）\n\n`;
    for(const it of items) idx+=`- ${it.date} [${it.title}](日记/${y}/${mon}/${it.rel})\n`;
    idx+='\n';
  }
  files.push({name:'index.md', data:enc.encode(idx)});
  files.push({name:'README.md', data:enc.encode(
    '# 日记导出包\n\n这是从「我的日记本」导出的**可读备份**，无需原 App 即可阅读与整理。\n\n'+
    '- `index.md`：总目录，点链接跳到各篇\n'+
    '- `日记/年份/年月.md`：每月汇总\n'+
    '- `日记/年份/年月/日期-id.md`：每天一篇独立文件，可用任意文本编辑器 / Obsidian / 备忘录打开\n'+
    '- `media/`：原始照片、音频、文档\n\n'+
    '> 恢复：在原 App 里点「⬆ 恢复」导入 JSON 备份（JSON 含全部媒体，这个 Markdown 包偏重阅读整理）。\n')});
  const blob=makeZip(files);
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download='日记导出-'+new Date().toISOString().slice(0,10)+'.zip';
  a.click(); setTimeout(()=>URL.revokeObjectURL(url),5000);
  toast('已导出可读 Markdown 包（'+all.length+' 篇，含媒体）');
}

/* ---------------- 回顾面板 ---------------- */
async function openReview(){
  const all=await allEntries();
  const modal=$('reviewModal');
  if(!all.length){ toast('还没有记录可回顾'); return; }
  const byType={life:0,invest:0,work:0,other:0};
  const byMonth={}; const tagCount={}; const dates=new Set();
  all.forEach(e=>{
    byType[e.type]=(byType[e.type]||0)+1;
    const mon=e.date.slice(0,7); byMonth[mon]=(byMonth[mon]||0)+1;
    dates.add(e.date);
    (e.tags||[]).forEach(t=>{ if(t) tagCount[t]=(tagCount[t]||0)+1; });
  });
  const days=dates.size;
  const firstDate=all.reduce((a,e)=>e.date<a?e.date:a, all[0].date);
  const spanDays=Math.max(1, Math.round((Date.now()-new Date(firstDate).getTime())/86400000)+1);
  const rate=Math.round(days/spanDays*100);
  $('reviewSub').textContent='从 '+firstDate+' 开始，累计 '+all.length+' 篇 · 记录了 '+days+' 天';

  let html='<div class="stat-grid">'
    +stat(all.length,'总篇数')
    +stat(days,'记录天数')
    +stat(rate+'%','坚持率')
    +stat(Object.keys(byMonth).length,'跨月数')
    +'</div>';

  // 类型分布条形
  const maxT=Math.max(...Object.values(byType),1);
  html+='<div class="rv-sec"><h3>📊 各模块分布</h3>';
  [['life','生活'],['invest','投资'],['work','工作'],['other','其他']].forEach(([k,l])=>{
    const v=byType[k]||0;
    html+=`<div class="bar-row"><span class="name">${l}</span><div class="bar" style="width:${Math.max(4,v/maxT*100)}%"></div><span class="val">${v} 篇</span></div>`;
  });
  html+='</div>';

  // 高频标签
  const topTags=Object.entries(tagCount).sort((a,b)=>b[1]-a[1]).slice(0,10);
  if(topTags.length){
    html+='<div class="rv-sec"><h3>🏷 高频标签</h3><div class="filters">'
      +topTags.map(([t,c])=>`<span class="chip">#${escapeHtml(t)} · ${c}</span>`).join('')+'</div></div>';
  }

  // 每月记录时间线
  html+='<div class="rv-sec"><h3>🗓 每月记录</h3>';
  Object.entries(byMonth).sort((a,b)=>a[0]<b[0]?1:-1).forEach(([m,c])=>{
    html+=`<div class="mon-item"><div class="mh">${m.replace('-','年')}月 · ${c} 篇</div></div>`;
  });
  html+='</div>';

  html+='<div class="rv-sec"><button class="btn primary" id="reviewExport" style="width:100%">📄 把全部日记导出成一篇可读文档</button></div>';

  $('reviewBody').innerHTML=html;
  $('reviewExport').onclick=async()=>{ const t=state.type,tag=state.tag,d=state.date,q=state.q; state.type=state.tag=state.date=state.q=''; await exportMarkdown(); state.type=t;state.tag=tag;state.date=d;state.q=q; };
  modal.classList.add('show');
}
function stat(n,l){ return `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`; }

/* ---------------- 绑定 ---------------- */
function bind(){
  $('reviewBtn').onclick=openReview;
  $('reviewClose').onclick=()=>$('reviewModal').classList.remove('show');
  $('reviewModal').onclick=(e)=>{ if(e.target.id==='reviewModal') $('reviewModal').classList.remove('show'); };
  $('mdBtn').onclick=exportAllMarkdownZip;
  $('newBtn').onclick=openNew;
  $('cancelBtn').onclick=resetEditor;
  $('saveBtn').onclick=saveEntry;
  $('delBtn').onclick=()=>{ if(state.editingId) deleteEntry(state.editingId); };
  $('tLife').onclick=()=>setType('life');
  $('tInvest').onclick=()=>setType('invest');
  $('tWork').onclick=()=>setType('work');
  $('tOther').onclick=()=>setType('other');
  $('locBtn').onclick=getLocation;
  $('filePhoto').onchange=(e)=>addFiles(e.target.files,'image');
  $('fileAudio').onchange=(e)=>addFiles(e.target.files,'audio');
  $('fileDocs').onchange=(e)=>addFiles(e.target.files,'file');
  document.querySelectorAll('.chip[data-type]').forEach(c=>c.onclick=()=>{
    document.querySelectorAll('.chip[data-type]').forEach(x=>x.classList.remove('on'));
    c.classList.add('on'); state.type=c.dataset.type; loadEntries();
  });
  $('search').oninput=(e)=>{ state.q=e.target.value.trim(); clearTimeout(state._st); state._st=setTimeout(loadEntries,300); };
  $('exportBtn').onclick=exportBackup;
  $('importBtn').onclick=()=>$('importFile').click();
  $('importFile').onchange=(e)=>{ if(e.target.files[0]) importBackup(e.target.files[0]); e.target.value=''; };
  $('list').addEventListener('dblclick',(e)=>{ const el=e.target.closest('.entry'); if(el) deleteEntry(el.dataset.id); });
}
function refreshAll(){ loadEntries(); loadCalendar(); loadTags(); }

/* ---------------- 启动 ---------------- */
window.addEventListener('DOMContentLoaded', async ()=>{
  $('todayLabel').textContent=new Date().toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'});
  bind();
  try{
    await openDB();
    // 首次启动放一条欢迎示例
    const all=await allEntries();
    if(!all.length){
      const id=uid();
      await putEntry({id, date:today(), type:'life', title:'👋 示例：双击这条可删除',
        body:'这是一条示例记录，方便你第一次打开就能看到效果（生活/投资/工作/其他切换、标签、照片缩略图、日历高亮）。\n\n点右上角「写今天」开始；想删掉示例，在这条上双击即可。\n\n【怎么记】\n· 语音：点「内容」输入框，用手机键盘自带的 🎤 麦克风说话即可转成文字（系统输入法自带，任何手机都支持）。\n· 录音文件：点「选音频」上传你用其他录音 App 录好的 m4a/mp3。\n· 文档：点「选文档」上传任何文件（pdf、txt、表格等）。\n\n数据全部存在你这台设备本地（IndexedDB），不上任何服务器。\n\n· 想脱离 App 阅读/整理：点「📦 导出可读」会得到一个 ZIP 包（每天一篇 .md、按年月归档、含照片/音频文件、带总目录），用任意笔记软件都能打开。\n· 想整包备份/换设备：点「⬇ 备份」导出 JSON，新设备点「⬆ 恢复」即可。',
        tags:['示例','欢迎'], location_name:'', lat:null, lng:null, media:[],
        created_at:new Date().toISOString(), updated_at:new Date().toISOString()});
    }
    resetEditor(); refreshAll();
  }catch(err){
    toast('无法打开本地数据库：'+err.message);
    console.error(err);
  }
  // 注册 Service Worker（仅 https 或 localhost 生效）
  if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost')){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
});
