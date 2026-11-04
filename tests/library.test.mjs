import { test,beforeEach,afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readdir,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { backupData } from '../scripts/backup.mjs';
let app,dir,base;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'shot-library-'));app=await createApp({dataDir:join(dir,'data')});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;});
afterEach(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
async function call(path,method='GET',body){const response=await fetch(base+path,{method,headers:{'X-Workbench':'1','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,data:await response.json()};}
async function fixture(){const project=(await call('/api/projects','POST',{title:'Reference project'})).data;const shot=(await call(`/api/projects/${project.id}/shots`,'POST',{title:'First'})).data;return{project,shot};}
async function asset(name='impact.wav') {const response=await fetch(base+'/api/library/import?filename='+encodeURIComponent(name),{method:'POST',headers:{'X-Workbench':'1'},body:Buffer.from('synthetic asset bytes')});return {status:response.status,data:await response.json()};}

test('optional extension imports assets, persists tags/provenance and serves preview bytes',async()=>{
  const manifest=(await call('/api/extensions')).data[0];assert.equal(manifest.id,'asset-library');assert.equal(manifest.rendered_mix,false);
  const imported=await asset();assert.equal(imported.status,201);
  const updated=await call(`/api/library/assets/${imported.data.id}`,'PATCH',{revision:0,title:'Awkward impact',tags:['awkward','comedy'],favorite:true,source_url:'https://example.com/sound',author:'Synthetic author',license:'Synthetic test fixture'});
  assert.equal(updated.status,200);assert.equal(updated.data.favorite,true);
  assert.deepEqual((await call('/api/library/assets')).data[0].tags,['awkward','comedy']);
  const response=await fetch(`${base}/media/${imported.data.media_id}`,{headers:{Range:'bytes=0-8'}});assert.equal(response.status,206);assert.equal(await response.text(),'synthetic');
  assert.equal((await asset('script.html')).status,415);
  assert.equal((await call(`/api/library/assets/${imported.data.id}`,'PATCH',{revision:1,source_url:'javascript:alert(1)'})).status,400);
});

test('references reach job snapshots and metadata changes protect pending job adoption',async()=>{
  const {project,shot}=await fixture();const imported=(await asset()).data;
  const attached=await call(`/api/shots/${shot.id}/references`,'POST',{revision:0,asset_id:imported.id,offset_ms:800,note:'Use this awkward pause feeling'});assert.equal(attached.status,201);
  const current=attached.data.shots[0];assert.equal(current.active_take_id,null);
  const queued=(await call(`/api/shots/${shot.id}/jobs`,'POST',{revision:current.revision,provider:'manual'})).data;
  assert.equal(queued.snapshot.references[0].note,'Use this awkward pause feeling');
  await call(`/api/jobs/${queued.id}/claim`,'POST',{});await call(`/api/jobs/${queued.id}/complete`,'POST',{revised_prompt:'new',summary:'done'});
  await call(`/api/library/assets/${imported.id}`,'PATCH',{revision:0,title:'Changed reference'});
  const revision=app.store.shot(shot.id).revision;
  assert.equal((await call(`/api/jobs/${queued.id}/apply`,'POST',{revision})).status,409);
  assert.equal(app.jobs.get(queued.id).snapshot.references[0].title,'impact.wav');
  const ref=app.store.detail(project.id).shots[0].references[0];
  assert.equal((await call(`/api/shots/${shot.id}/references/${ref.id}`,'DELETE',{revision})).status,200);
  assert.equal(app.store.references(shot.id).length,0);assert.equal(app.library.list().length,1);assert.equal((await readdir(join(dir,'data','media'))).length,1);
});

test('segment-relative reference follows recursive splitting and reordering',async()=>{
  const {project,shot}=await fixture();const imported=(await asset()).data;
  const response=await fetch(`${base}/api/shots/${shot.id}/takes?filename=source.mp4`,{method:'POST',headers:{'X-Workbench':'1','X-Shot-Revision':'0'},body:'synthetic video'});const take=await response.json();
  const linked=(await call(`/api/shots/${shot.id}/references`,'POST',{revision:take.shot.revision,asset_id:imported.id,offset_ms:8000,note:'impact here'})).data.shots[0];
  const split=(await call(`/api/shots/${shot.id}/split`,'POST',{revision:linked.revision,duration_ms:30000,cuts_ms:[6000,12000,18000,24000]})).data;
  assert.equal(split.shots[0].references.length,0);assert.equal(split.shots[1].references[0].offset_ms,2000);
  const second=split.shots[1];const ref=second.references[0];
  assert.equal((await call(`/api/shots/${second.id}/references/${ref.id}`,'PATCH',{revision:second.revision,offset_ms:9000,note:'bad'})).status,400);
  const ids=split.shots.map(row=>row.id).reverse();await call(`/api/projects/${project.id}/order`,'PUT',{ids});
  assert.equal(app.store.references(second.id)[0].offset_ms,2000);
});

test('backup and schema upgrade preserve asset references and originals',async()=>{
  const {shot,project}=await fixture();const imported=(await asset('meme.gif')).data;
  await call(`/api/shots/${shot.id}/references`,'POST',{revision:0,asset_id:imported.id,note:'visual reference'});
  await backupData(join(dir,'data'),join(dir,'backup'));
  const restored=await createApp({dataDir:join(dir,'backup')});
  try{const ref=restored.store.detail(project.id).shots[0].references[0];const media=restored.store.media(ref.media_id);assert.equal((await readFile(join(dir,'backup','media',media.stored_name))).toString(),'synthetic asset bytes');}finally{await restored.runner.close();restored.store.close();}
  await app.close();const legacy=new DatabaseSync(join(dir,'data','workbench.sqlite'));legacy.exec('DROP TABLE shot_refs; DROP TABLE library_assets; PRAGMA user_version=3;');legacy.close();
  app=await createApp({dataDir:join(dir,'data')});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;
  assert.equal(app.store.db.prepare('PRAGMA user_version').get().user_version,7);assert.equal(app.store.detail(project.id).shots.length,1);
  const snapshot=new DatabaseSync(join(dir,'data','schema-v3-before-v4.sqlite'),{readOnly:true});try{assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,3);}finally{snapshot.close();}
});

test('favoriting does not invalidate a job and reference editing checks the shot revision',async()=>{
  const {shot}=await fixture();const imported=(await asset()).data;
  const current=(await call(`/api/shots/${shot.id}/references`,'POST',{revision:0,asset_id:imported.id,note:'old'})).data.shots[0];
  await call(`/api/library/assets/${imported.id}`,'PATCH',{revision:0,favorite:true});
  assert.equal(app.store.shot(shot.id).revision,current.revision);
  const ref=current.references[0];
  const update=await call(`/api/shots/${shot.id}/references/${ref.id}`,'PATCH',{revision:current.revision,offset_ms:900,note:'new feel'});
  assert.equal(update.status,200);assert.equal(update.data.shots[0].references[0].note,'new feel');
  assert.equal((await call(`/api/shots/${shot.id}/references/${ref.id}`,'DELETE',{revision:current.revision})).status,409);
});
