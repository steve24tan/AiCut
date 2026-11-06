let ctx, enabled = false, assets = [], target = null, editing = null, linking = null;
import { groupAssets } from './library-groups.js';
const $ = selector => document.querySelector(selector);
const GROUPS_KEY = 'shot-workbench:library-groups';
function groupState() { try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || '{}'); } catch { return {}; } }
function saveGroupState(key, open) { try { const state = groupState(); state[key] = open; localStorage.setItem(GROUPS_KEY, JSON.stringify(state)); } catch { /* Optional persistence. */ } }
function media(asset) {
  const tag = asset.mime.startsWith('audio/') ? 'audio' : asset.mime.startsWith('video/') ? 'video' : 'img';
  const element = document.createElement(tag); element.src = `/media/${asset.media_id}`;
  if (tag === 'img') { element.alt = asset.title; element.draggable = false; }
  else { element.controls = true; element.preload = 'metadata'; }
  return element;
}
function stop(container) { for (const element of container.querySelectorAll('audio,video')) element.pause(); }
function setEnabled(value) {
  enabled = value;
  try { localStorage.setItem('shot-workbench:asset-library',String(value)); } catch { /* Keep the toggle usable in private storage mode. */ }
  $('#library-panel').hidden = !value; $('#toggle-library').setAttribute('aria-pressed',String(value));
  document.body.classList.toggle('library-open',value);
  if (!value) stop($('#library-panel'));
}
export async function setupLibrary(context) {
  ctx = context;
  try { enabled = localStorage.getItem('shot-workbench:asset-library') === 'true'; } catch { /* Optional persistence. */ }
  setEnabled(enabled);
  $('#toggle-library').addEventListener('click', () => { setEnabled(!enabled); if (enabled) refreshLibrary().catch(error=>ctx.toast(error.message,true)); });
  $('#close-library').addEventListener('click',()=>setEnabled(false));
  $('#library-import').addEventListener('click',()=>$('#library-files').click());
  $('#library-files').addEventListener('change',event=>{ const files=[...event.target.files];event.target.value='';if(files.length)importFiles(files); });
  for (const id of ['library-search','library-favorites']) $('#'+id).addEventListener('input',renderAssets);
  $('#library-panel').addEventListener('dragover',event=>{ if(event.dataTransfer.types.includes('Files'))event.preventDefault(); });
  $('#library-panel').addEventListener('drop',event=>{if(event.dataTransfer.files.length){event.preventDefault();importFiles([...event.dataTransfer.files]);}});
  $('#asset-form').addEventListener('submit',event=>{
    event.preventDefault(); ctx.action(async()=>{
      const tags=$('#asset-tags').value.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean);
      await ctx.api(`/api/library/assets/${editing.id}`,{method:'PATCH',body:JSON.stringify({revision:editing.revision,title:$('#asset-title').value,tags,source_url:$('#asset-source').value,author:$('#asset-author').value,license:$('#asset-license').value})});
      $('#asset-dialog').close(); await refreshLibrary(); if(ctx.getProject())await ctx.reload(ctx.getProject().id);
    });
  });
  $('#reference-form').addEventListener('submit',event=>{
    event.preventDefault();ctx.action(async()=>{
      const shot=ctx.getProject()?.shots.find(item=>item.id===linking.shotId);if(!shot)throw new Error('请先选择项目中的片段');
      const payload={revision:shot.revision,asset_id:linking.asset.id,offset_ms:Math.round(Number($('#reference-offset').value)*1000),note:$('#reference-note').value};
      const path=`/api/shots/${shot.id}/references`+(linking.refId?'/'+linking.refId:'');
      await ctx.api(path,{method:linking.refId?'PATCH':'POST',body:JSON.stringify(payload)});
      $('#reference-dialog').close();await ctx.reload(shot.project_id);ctx.toast('参考已关联到这一段；原视频保持不变');
    });
  });
  for(const id of ['asset-dialog','reference-dialog','viewer-dialog'])$('#'+id).addEventListener('close',()=>stop($('#'+id)));
  $('#viewer-dialog').addEventListener('click',event=>{if(event.target.id==='viewer-dialog'||event.target.id==='viewer-stage')$('#viewer-dialog').close();});
  $('#viewer-full').addEventListener('click',()=>$('#viewer-stage').firstElementChild?.requestFullscreen?.().catch(()=>{}));
  if(enabled) await refreshLibrary();
}
export async function refreshLibrary() { assets=await ctx.api('/api/library/assets');renderAssets(); }
function importFiles(files) {
  ctx.action(async()=>{
    let count=0;
    try {
      for(const file of files){
        if(file.size>1024**3)throw new Error('单个素材上限 1 GB');
        ctx.toast(`正在导入参考 ${count+1}/${files.length}：${file.name}`);
        await ctx.api(`/api/library/import?filename=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});count++;
      }
      ctx.toast(`已导入 ${count} 个素材，可以拖到片段上`);
    } finally { await refreshLibrary(); }
  });
}
function renderAssets() {
  const container=$('#library-assets');stop(container);container.replaceChildren();
  const query=$('#library-search').value.trim().toLocaleLowerCase(), favorite=$('#library-favorites').checked;
  const filtered=assets.filter(asset=>(!favorite||asset.favorite)&&[asset.title,...asset.tags].join(' ').toLocaleLowerCase().includes(query));
  if(!filtered.length){const empty=document.createElement('p');empty.className='library-empty';empty.textContent=assets.length?'没有匹配的素材。':'拖入音效、meme 图片或短视频，建立自己的感觉库。';container.append(empty);}
  const state=groupState(), groups=groupAssets(filtered);
  groups.forEach((group,index)=>{
    const details=document.createElement('details');details.className='library-group';details.dataset.group=group.key;
    // Default: newest episode and the unsorted pile open, older episodes folded. A search opens every match.
    details.open=query?true:(state[group.key]??(index===0||group.episode==null));
    details.addEventListener('toggle',()=>{if(!query)saveGroupState(group.key,details.open);});
    const summary=document.createElement('summary');summary.innerHTML='<span></span><small></small>';
    summary.querySelector('span').textContent=group.label;summary.querySelector('small').textContent=`${group.items.length} 个`;
    const list=document.createElement('div');list.className='library-group-items';
    details.append(summary,list);container.append(details);
    for(const asset of group.items)list.append(assetCard(asset));
  });
}
function assetCard(asset) {
    const item=document.createElement('article');item.className='library-asset';item.draggable=true;item.dataset.assetId=asset.id;
    item.addEventListener('dragstart',event=>{event.dataTransfer.setData('application/x-shot-asset',asset.id);event.dataTransfer.effectAllowed='copy';});
    const title=document.createElement('strong');title.textContent=asset.title;
    const tags=document.createElement('small');tags.textContent=asset.tags.join(' · ')||'添加标签，让感觉更容易找到';
    const buttons=document.createElement('div');buttons.className='library-asset-actions';
    const favoriteButton=document.createElement('button');favoriteButton.textContent=asset.favorite?'★':'☆';favoriteButton.setAttribute('aria-label','收藏 '+asset.title);
    favoriteButton.addEventListener('click',()=>ctx.action(async()=>{await ctx.api(`/api/library/assets/${asset.id}`,{method:'PATCH',body:JSON.stringify({revision:asset.revision,favorite:!asset.favorite})});await refreshLibrary();if(ctx.getProject())await ctx.reload(ctx.getProject().id);}));
    const info=document.createElement('button');info.textContent='信息 / 试听';info.addEventListener('click',()=>{
      editing=asset;$('#asset-title').value=asset.title;$('#asset-tags').value=asset.tags.join(', ');$('#asset-source').value=asset.source_url;$('#asset-author').value=asset.author;$('#asset-license').value=asset.license;$('#asset-preview').replaceChildren(media(asset));$('#asset-dialog').showModal();
    });
    const add=document.createElement('button');add.textContent='添加到当前段';add.addEventListener('click',()=>openReference(target,asset));
    const download=document.createElement('a');download.textContent='下载原素材';download.href=`/media/${asset.media_id}`;download.download=asset.filename;
    buttons.append(favoriteButton,info,add,download);
    const preview=media(asset);
    if(preview.tagName==='IMG'){preview.title='点击放大';preview.addEventListener('click',()=>openViewer(asset));}
    item.append(title,preview,tags,buttons);return item;
}
// Full-window viewer for a library image or video.
function openViewer(asset) {
  const dialog=$('#viewer-dialog');$('#viewer-title').textContent=asset.title;
  const element=media(asset);if(element.tagName==='VIDEO')element.autoplay=true;
  $('#viewer-stage').replaceChildren(element);dialog.showModal();
}
function chooseTarget(shot) { target=shot.id;$('#library-target').textContent=`当前段：${shot.title} · 也可拖到其他段`; }
function openReference(shotId,asset,ref=null) {
  const shot=ctx.getProject()?.shots.find(item=>item.id===shotId);if(!shot){ctx.toast('先点选一段，再添加参考',true);return;}
  chooseTarget(shot);linking={shotId,asset,refId:ref?.id};
  $('#reference-heading').textContent=`${shot.title} · ${asset.title}`;$('#reference-offset').value=(ref?.offset_ms??0)/1000;$('#reference-note').value=ref?.note??'';
  $('#reference-preview').replaceChildren(media(asset));$('#reference-dialog').showModal();
}
export function referencesText(shot) {
  if(!shot.references?.length)return '';
  return '\n\n【感觉参考（文件未附加给模型）】\n'+shot.references.map(ref=>`${ref.title}（${ref.filename}，${ref.mime}）· 本段第 ${(ref.offset_ms/1000).toFixed(3)} 秒\n标签：${ref.tags.join(', ')}\n使用说明：${ref.note||'未填写'}\n来源：${ref.source_url||'未记录'}；作者：${ref.author||'未记录'}；授权：${ref.license||'未记录'}`).join('\n\n');
}
export function bindLibraryCard(card,shot) {
  if(!ctx)return;
  if(!ctx.getProject()?.shots.some(item=>item.id===target))chooseTarget(shot);
  card.addEventListener('focusin',()=>chooseTarget(shot));card.addEventListener('click',()=>chooseTarget(shot));
  card.addEventListener('dragover',event=>{if(enabled&&event.dataTransfer.types.includes('application/x-shot-asset')){event.preventDefault();card.classList.add('asset-drop-target');}});
  card.addEventListener('dragleave',()=>card.classList.remove('asset-drop-target'));
  card.addEventListener('drop',event=>{card.classList.remove('asset-drop-target');if(!enabled)return;const id=event.dataTransfer.getData('application/x-shot-asset');const asset=assets.find(item=>item.id===id);if(asset){event.preventDefault();openReference(shot.id,asset);}});
  if(!shot.references?.length)return;
  const box=document.createElement('section');box.className='shot-references';const title=document.createElement('strong');title.textContent='感觉参考 · 独立试听';box.append(title);
  const take=shot.takes.find(item=>item.id===shot.active_take_id);
  for(const ref of shot.references){
    const row=document.createElement('div');row.className='shot-reference';row.dataset.referenceId=ref.id;
    const name=document.createElement('span');name.textContent=`${(ref.offset_ms/1000).toFixed(3)}s · ${ref.title}`;
    if(take?.end_ms!=null&&ref.offset_ms>=take.end_ms-take.start_ms)name.textContent+='（超出当前段，请调整）';
    const note=document.createElement('small');note.textContent=ref.note||'点击参考，说明你想要的感觉';
    const preview=document.createElement('button');preview.textContent='查看 / 调整';preview.addEventListener('click',()=>openReference(shot.id,{...ref,id:ref.asset_id},ref));
    const remove=document.createElement('button');remove.textContent='解除关联';remove.addEventListener('click',()=>ctx.action(async()=>{const current=ctx.getProject().shots.find(item=>item.id===shot.id);await ctx.api(`/api/shots/${shot.id}/references/${ref.id}`,{method:'DELETE',body:JSON.stringify({revision:current.revision})});await ctx.reload(shot.project_id);}));
    row.append(name,note,preview,remove);box.append(row);
  }
  card.append(box);
}
