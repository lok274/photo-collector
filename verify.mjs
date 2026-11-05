import assert from 'node:assert/strict';
import {createHash, createHmac, randomUUID, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('Code.gs', import.meta.url), 'utf8');
const html = await readFile(new URL('index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('appsscript.json', import.meta.url), 'utf8'));
const client = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(source, {filename:'Code.gs'});
new vm.Script(client, {filename:'index.html'});
const NOW = Date.parse('2026-11-05T04:00:00Z');
const DEADLINE = Date.parse('2026-11-09T23:59:00+08:00');
const MiB = 1024 * 1024;
const CHUNK = 4 * MiB;
const MAX = 2 * 1024 * MiB;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYtQAAAAASUVORK5CYII=', 'base64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const key = () => randomUUID().replaceAll('-', '');
const bmff = (brand, compatible='isom') => { const bytes=Buffer.alloc(20); bytes.writeUInt32BE(20); bytes.write('ftyp',4); bytes.write(brand,8); bytes.write(compatible,16); return bytes; };
const large = size => { const bytes=Buffer.alloc(size); png.copy(bytes); return bytes; };
let passed = 0;
async function test(name, body) { await body(); passed++; console.log('PASS ' + name); }
const response = (status, headers={}) => ({getResponseCode:() => status,getAllHeaders:() => headers});

function server(now=NOW) {
  const properties = new Map();
  const files = new Map();
  const sessions = new Map();
  const calls = {generate:0,get:0,list:0,folder:0,fetch:0,quotaRead:0,quotaWrite:0};
  const requests = [];
  const state = {initMode:'normal',chunkMode:'normal',partial:null,override:null,lockAvailable:true,getFail:false};
  let sequence=0, locked=false, clock=now;
  class Clock extends Date { constructor(...args) { super(...(args.length?args:[clock])); } static now() { return clock; } }
  const setProperty = (name,value) => { if(name==='DAILY_USAGE') { calls.quotaWrite++; assert.ok(locked,'reserve holds ScriptLock'); } properties.set(name,value); };
  const context = vm.createContext({
    Date:Clock, console:{log:() => {}},
    PropertiesService:{getScriptProperties:() => ({
      getProperty:name => { if(name==='DAILY_USAGE') calls.quotaRead++; return properties.get(name)??null; },
      setProperty, setProperties:values => Object.entries(values).forEach(([name,value]) => setProperty(name,value)),
      getProperties:() => Object.fromEntries(properties),deleteProperty:name => properties.delete(name)
    })},
    LockService:{getScriptLock:() => ({waitLock:() => { assert.equal(locked,false); locked=true; },tryLock:() => { if(!state.lockAvailable)return false; assert.equal(locked,false); locked=true; return true; },releaseLock:() => { assert.ok(locked); locked=false; }})},
    HtmlService:{XFrameOptionsMode:{ALLOWALL:'ALLOWALL'},createHtmlOutput:content => ({content,setXFrameOptionsMode(mode){this.mode=mode;return this;}})},
    Utilities:{getUuid:randomUUID,base64Encode:bytes => Buffer.from(bytes).toString('base64'),base64Decode:value => [...Buffer.from(value,'base64')],base64EncodeWebSafe:bytes => Buffer.from(bytes).toString('base64url'),
      computeHmacSha256Signature:(value,secret) => [...createHmac('sha256',secret).update(value).digest()],DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_algorithm,bytes) => [...createHash('sha256').update(Buffer.from(bytes)).digest()],
      formatDate:date => new Date(date.getTime()+8*3600000).toISOString().slice(0,10)},
    ScriptApp:{getOAuthToken:() => 'OWNER_TOKEN_NEVER_RETURN'},
    Drive:{Files:{
      generateIds:() => { calls.generate++; return {ids:['generated_file_'+(++sequence)]}; },
      create:metadata => { assert.ok(locked); assert.equal(metadata.mimeType,'application/vnd.google-apps.folder'); calls.folder++; return {id:'private_folder_123456'}; },
      get:id => { calls.get++; if(state.getFail||!files.has(id))throw new Error('not found'); return clone(files.get(id)); },
      list:options => { calls.list++; const uploadKey=options.q.match(/value='([a-f0-9]{32})'/)[1]; return {files:[...files.values()].filter(file=>file.appProperties.uploadKey===uploadKey&&!file.trashed).map(clone)}; }
    }},
    UrlFetchApp:{fetch:(url,options) => {
      calls.fetch++; requests.push({url,options});
      assert.equal(options.headers.Authorization,'Bearer OWNER_TOKEN_NEVER_RETURN');
      assert.equal(options.followRedirects,false);
      assert.equal(options.muteHttpExceptions,true);
      if(options.method==='post') {
        assert.ok(locked,'initialization is serialized');
        const metadata=JSON.parse(options.payload);
        assert.equal(metadata.parents[0],'private_folder_123456');
        assert.ok(properties.has('UPLOAD_'+metadata.appProperties.uploadKey),'record precedes network');
        assert.ok(JSON.parse(properties.get('DAILY_USAGE')).bytes>=Number(options.headers['X-Upload-Content-Length']));
        const uri='https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session_'+(++sequence);
        sessions.set(uri,{metadata,size:Number(options.headers['X-Upload-Content-Length']),offset:0});
        if(state.initMode==='throwOnce') { state.initMode='normal'; throw new Error(uri+' OWNER_TOKEN_NEVER_RETURN'); }
        if(state.initMode==='badLocation')return response(200,{Location:'https://evil.example/upload_id=bad'});
        if(state.initMode==='httpFail')return response(500);
        return response(200,{location:uri});
      }
      assert.equal(locked,false,'media and status do not hold global lock');
      const session=sessions.get(url);
      if(!session)return response(404);
      if(state.override) { const custom=state.override;state.override=null;return custom; }
      const range=options.headers['Content-Range'];
      if(range.startsWith('bytes */'))return response(308,session.offset?{Range:'bytes=0-'+(session.offset-1)}:{});
      const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      assert.ok(match);
      const offset=Number(match[1]), end=Number(match[2]);
      assert.equal(Number(match[3]),session.size);
      assert.equal(end-offset+1,options.payload.length);
      assert.ok(options.payload.length<=CHUNK);
      if(offset!==session.offset)return response(308,session.offset?{Range:'bytes=0-'+(session.offset-1)}:{});
      session.offset=state.partial===null?end+1:Math.min(end+1,offset+state.partial);
      state.partial=null;
      if(session.offset===session.size) {
        if(!files.has(session.metadata.id))files.set(session.metadata.id,{...session.metadata,size:String(session.size),trashed:false});
        if(state.chunkMode==='savedThenThrow') {state.chunkMode='normal';throw new Error(url+' OWNER_TOKEN_NEVER_RETURN');}
        return response(200);
      }
      if(state.chunkMode==='acceptedThenThrow') {state.chunkMode='normal';throw new Error(url+' OWNER_TOKEN_NEVER_RETURN');}
      return response(308,session.offset?{range:'bytes=0-'+(session.offset-1)}:{});
    }}
  });
  vm.runInContext(source,context);
  context.setup_();
  const config=() => JSON.parse(properties.get('COLLECTOR_CONFIG'));
  const metadata=(bytes=png,overrides={}) => ({name:'手機相片.png',mime:'image/png',size:bytes.length,uploadKey:key(),prefixSha256:hash(bytes.subarray(0,65536)),...overrides});
  const prepare=(bytes=png,overrides={}) => context.prepareUpload_(config().uploadCode,metadata(bytes,overrides),bytes.subarray(0,65536).toString('base64'));
  const upload=(ticket,bytes=png,offset=0,code=config().uploadCode) => context.uploadChunk_(code,ticket,offset,bytes.toString('base64'));
  const status=(ticket,code=config().uploadCode) => context.getUploadStatus_(code,ticket);
  return {context,properties,files,sessions,calls,requests,state,config,metadata,prepare,upload,status,locked:()=>locked,setTime:value=>{clock=value;}};
}

function post(s,request) {
  const output=s.context.doPost({parameter:{payload:typeof request==='string'?request:JSON.stringify(request)}});
  assert.equal(output.mode,'ALLOWALL');
  let reply;
  vm.runInNewContext(output.content.match(/<script>([\s\S]*?)<\/script>/)[1],{window:{top:{postMessage:(data,origin)=>{assert.equal(origin,'https://lok274.github.io');reply=clone(data);}}}});
  return {reply,html:output.content};
}

await test('syntax, private entry points, exact scopes and unchanged setup',()=>{
  assert.deepEqual([...source.matchAll(/^function (\w+)\(/gm)].map(m=>m[1]).filter(n=>!n.endsWith('_')).sort(),['doGet','doPost']);
  assert.deepEqual(manifest.oauthScopes,['https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/script.external_request']);
  assert.deepEqual(manifest.dependencies.enabledAdvancedServices,[{userSymbol:'Drive',version:'v3',serviceId:'drive'}]);
  assert.deepEqual(manifest.webapp,{executeAs:'USER_DEPLOYING',access:'ANYONE_ANONYMOUS'});
  assert.doesNotMatch(html,/hmacSecret|COLLECTOR_CONFIG|google\.script\.run|fetch\(/);
  assert.doesNotMatch(html,/<script[^>]*\bsrc\s*=|<link[^>]*\bhref\s*=/i);
  const s=server(),config=s.properties.get('COLLECTOR_CONFIG');
  s.properties.set('DAILY_USAGE','{"day":"2026-11-05","bytes":123}');s.context.setup_();
  assert.equal(s.properties.get('COLLECTOR_CONFIG'),config);assert.equal(s.calls.folder,1);assert.equal(JSON.parse(s.properties.get('DAILY_USAGE')).bytes,123);
  const before={...s.calls};assert.match(s.context.doGet().content,/target="_top"/);assert.deepEqual(s.calls,before);
});

await test('POST whitelist, bounded requests, fixed reply origin and HTML escaping',()=>{
  const s=server(),id='a'.repeat(32),meta=s.metadata(png,{name:'<script>alert(1).png'});
  const prepared=post(s,{id,method:'prepareUpload',args:[s.config().uploadCode,meta,png.toString('base64')]});
  assert.equal(prepared.reply.ok,true);assert.match(prepared.html,/\\u003cscript>/);assert.equal((prepared.html.match(/<script>/g)||[]).length,1);
  const ticket=prepared.reply.result;
  assert.equal(post(s,{id,method:'getUploadStatus',args:[s.config().uploadCode,ticket]}).reply.result.offset,0);
  assert.equal(post(s,{id,method:'uploadChunk',args:[s.config().uploadCode,ticket,0,png.toString('base64')]}).reply.result.status,'saved');
  for(const request of [{id,method:'setup_',args:[]},{id,method:'constructor',args:[]},{id,method:'uploadPhoto',args:[]},{id,method:'prepareUpload',args:[]},{id:'bad',method:'getUploadStatus',args:[]},null,[], '{bad', ' '.repeat(6*MiB+1)])assert.equal(post(s,request).reply.ok,false);
  assert.doesNotMatch(JSON.stringify(prepared.reply),/upload_id|OWNER_TOKEN|session/);
});

await test('code, ticket and deadline checks precede Drive, quota and network access',()=>{
  for(const now of [NOW,DEADLINE,DEADLINE+1]) {
    const s=server(DEADLINE-1),ticket=s.prepare(),before={...s.calls};s.setTime(now);
    for(const code of now===NOW?['wrong',null,'','x'.repeat(129)]:[s.config().uploadCode]) {
      assert.throws(()=>s.context.prepareUpload_(code,s.metadata(),png.toString('base64')),/上傳碼|截止/);
      assert.throws(()=>s.upload(ticket,png,0,code),/上傳碼|截止/);
      assert.throws(()=>s.status(ticket,code),/上傳碼|截止/);
    }
    assert.deepEqual(s.calls,before);
  }
  const s=server(DEADLINE-1),ticket=s.prepare();assert.equal(ticket.expiresAt,DEADLINE);assert.equal(s.upload(ticket).status,'saved');
  s.setTime(DEADLINE);assert.throws(()=>s.status(ticket),/截止/);assert.equal(s.files.size,1);
});

await test('all listed photo and phone video headers are accepted without codec decoding',()=>{
  const formats=[['image/jpeg',Buffer.from([255,216,255])],['image/png',png],['image/gif',Buffer.from('GIF89a')],['image/webp',Buffer.from('RIFF0000WEBP')],['image/heic',bmff('heic','mif1')],['image/heif',bmff('mif1')],['image/avif',bmff('avif')],['image/tiff',Buffer.from('II\x2a\x00','binary')],['image/x-adobe-dng',Buffer.from('MM\x00\x2a','binary')],['video/mp4',bmff('mp42')],['video/quicktime',bmff('qt  ')],['video/3gpp',bmff('3gp6')],['video/webm',Buffer.from([26,69,223,163,66,130,132,119,101,98,109])]];
  for(const [mime,bytes]of formats){const s=server(),ticket=s.prepare(bytes,{mime});assert.equal(ticket.mime,mime);assert.equal(s.upload(ticket,bytes).status,'saved');}
  for(const atom of ['moov','mdat','wide']){const bytes=Buffer.alloc(12);bytes.writeUInt32BE(12);bytes.write(atom,4);const s=server();assert.equal(s.prepare(bytes,{mime:'video/quicktime'}).mime,'video/quicktime');}
  const s=server();for(const bytes of [Buffer.from('not a photo'),Buffer.from([26,69,223,163]),bmff('bad!'),Buffer.from([0,0,0,3,109,100,97,116])])assert.throws(()=>s.prepare(bytes),/標頭|格式/);
  assert.equal(s.calls.fetch,0);
});

await test('2 GiB bound is inclusive and bad metadata or prefix cannot initialize',()=>{
  const prefix=large(65536),s=server();assert.equal(s.prepare(prefix,{size:MAX}).size,MAX);
  const before={...s.calls};
  for(const overrides of [{size:MAX+1},{size:0},{size:1.5},{name:'../bad'},{name:'x'.repeat(201)},{mime:'text/html'},{uploadKey:'bad'},{prefixSha256:'0'.repeat(64)}])assert.throws(()=>s.prepare(prefix,overrides));
  assert.deepEqual(s.calls,before);
  assert.throws(()=>s.context.prepareUpload_(s.config().uploadCode,s.metadata(prefix,{size:MAX}),png.toString('base64')),/資料/);
});

await test('tickets bind every metadata field, folder and expiry before network access',()=>{
  const s=server(),ticket=s.prepare(),before={...s.calls};
  for(const overrides of [{fileId:'other_file_1234'},{name:'other.png'},{mime:'image/jpeg'},{size:1},{prefixSha256:'0'.repeat(64)},{uploadKey:'b'.repeat(32)},{expiresAt:NOW+1000},{signature:'fake'}]){assert.throws(()=>s.status({...ticket,...overrides}));assert.throws(()=>s.upload({...ticket,...overrides}));}
  s.setTime(ticket.expiresAt);assert.throws(()=>s.status(ticket),/過期/);assert.deepEqual(s.calls,before);
});

await test('chunk bounds, canonical base64 and first-prefix binding fail before network',()=>{
  const s=server(),bytes=large(CHUNK+9),ticket=s.prepare(bytes),before={...s.calls};
  for(const [offset,data]of [[-1,'AA=='],[1.2,'AA=='],[ticket.size,'AA=='],[0,''],[0,'AB=='],[0,'AA='],[0,'A A='],[0,'A'.repeat(4*Math.ceil((CHUNK+1)/3))],[0,png.toString('base64')],[CHUNK,Buffer.alloc(10).toString('base64')],[0,Buffer.alloc(CHUNK).toString('base64')]])assert.throws(()=>s.context.uploadChunk_(s.config().uploadCode,ticket,offset,data));
  assert.deepEqual(s.calls,before);
  assert.throws(()=>s.context.prepareUpload_(s.config().uploadCode,s.metadata(png),png.toString('base64')+'\n'),/資料/);
});

await test('uncertain initialization retries same ID and reserves quota only once',()=>{
  const s=server(),metadata=s.metadata(),args=[s.config().uploadCode,metadata,png.toString('base64')];s.state.initMode='throwOnce';
  const failure=post(s,{id:key(),method:'prepareUpload',args});assert.equal(failure.reply.ok,false);assert.doesNotMatch(JSON.stringify(failure.reply),/upload_id|OWNER_TOKEN|googleapis/);
  const record=JSON.parse(s.properties.get('UPLOAD_'+metadata.uploadKey));
  const ticket=s.context.prepareUpload_(...args);assert.equal(ticket.fileId,record.ticket.fileId);assert.equal(s.calls.generate,1);assert.equal(s.calls.quotaWrite,1);
  assert.equal(s.context.prepareUpload_(...args).fileId,ticket.fileId);assert.equal(s.calls.fetch,2);
  assert.throws(()=>s.context.prepareUpload_(args[0],{...metadata,name:'different.png'},args[2]),/編號與檔案不符/);
  assert.equal(s.upload(ticket).status,'saved');
});

await test('server refuses redirected or hostile session URLs without exposing credentials',()=>{
  for(const url of ['https://evil.example/upload_id=1','http://www.googleapis.com/upload/drive/v3/files?upload_id=1','https://www.googleapis.com.attacker/upload/drive/v3/files?upload_id=1','https://www.googleapis.com/upload/drive/v3/files?upload_id=1#evil']){const s=server();assert.equal(s.context.validSession_(url),false);}
  const s=server();s.state.initMode='badLocation';assert.throws(()=>s.prepare(),/安全上傳/);assert.equal(s.calls.quotaWrite,1);
});

await test('308 progress uses actual partial range and missing Range means zero',()=>{
  const s=server(),bytes=large(CHUNK+333),ticket=s.prepare(bytes);s.state.partial=123456;
  assert.equal(s.upload(ticket,bytes.subarray(0,CHUNK)).offset,123456);
  assert.equal(s.status(ticket).offset,123456);
  assert.equal(s.upload(ticket,bytes.subarray(123456),123456).status,'saved');
  const t=s.prepare(bytes);s.state.override=response(308);assert.equal(s.upload(t,bytes.subarray(0,CHUNK)).offset,0);
  for(const range of ['bytes=7-9','bad','bytes=0-'+t.size,'bytes=0-99999999999999999999']){s.state.override=response(308,{Range:range});assert.throws(()=>s.status(t),/核對/);}
});

await test('response lost after save is recovered by metadata with transient records removed',()=>{
  const s=server(),metadata=s.metadata(),ticket=s.context.prepareUpload_(s.config().uploadCode,metadata,png.toString('base64'));
  s.state.chunkMode='savedThenThrow';assert.throws(()=>s.upload(ticket),/連線中斷/);assert.equal(s.files.size,1);
  assert.equal(s.status(ticket).status,'saved');assert.equal(s.properties.has('UPLOAD_'+ticket.uploadKey),false);
  const before=s.calls.fetch;assert.equal(s.status(ticket).status,'saved');assert.equal(s.calls.fetch,before);
  const recovered=s.context.prepareUpload_(s.config().uploadCode,metadata,png.toString('base64'));assert.equal(recovered.fileId,ticket.fileId);assert.equal(s.calls.generate,1);assert.equal(s.calls.quotaWrite,1);
});

await test('final confirmation checks ID, size, parent, name, MIME and appProperties',()=>{
  const s=server(),ticket=s.prepare();s.upload(ticket);const stored=clone(s.files.get(ticket.fileId));
  for(const changes of [{id:'wrong'},{size:'1'},{name:'wrong'},{mimeType:'image/jpeg'},{parents:['other']},{parents:[s.config().folderId,'other']},{trashed:true},{appProperties:{uploadKey:ticket.uploadKey,prefixSha256:'0'.repeat(64)}},{appProperties:{...stored.appProperties,expiresAt:'0'}}]){s.files.set(ticket.fileId,{...stored,...changes});assert.throws(()=>s.status(ticket),/已儲存檔案不符/);}
  s.files.set(ticket.fileId,stored);assert.equal(s.status(ticket).status,'saved');
});

await test('missing sessions are explicit and cannot silently restart an upload',()=>{
  const s=server(),ticket=s.prepare(),record=JSON.parse(s.properties.get('UPLOAD_'+ticket.uploadKey));s.sessions.delete(record.session);
  assert.throws(()=>s.status(ticket),/過期或遺失/);const before=s.calls.generate;assert.throws(()=>s.upload(ticket),/過期或遺失/);assert.equal(s.calls.generate,before);
  s.properties.delete('UPLOAD_'+ticket.uploadKey);assert.throws(()=>s.status(ticket),/過期或遺失/);
});

await test('daily 20 GiB cap, reservations, Hong Kong rollover and corrupt quota fail closed',()=>{
  const s=server();s.properties.set('DAILY_USAGE',JSON.stringify({day:'2026-11-05',bytes:20*1024*MiB-png.length}));const ticket=s.prepare();assert.equal(s.upload(ticket).status,'saved');
  assert.equal(JSON.parse(s.properties.get('DAILY_USAGE')).bytes,20*1024*MiB);assert.throws(()=>s.prepare(),/今日收檔容量已用完/);assert.equal(s.status(ticket).status,'saved');
  s.setTime(Date.parse('2026-11-05T16:00:00Z'));s.prepare();assert.deepEqual(JSON.parse(s.properties.get('DAILY_USAGE')),{day:'2026-11-06',bytes:png.length});
  for(const quota of ['{bad','{"day":"2026-11-06","bytes":-1}','{"day":0,"bytes":1}']){s.properties.set('DAILY_USAGE',quota);assert.throws(()=>s.prepare(),/用量紀錄/);}
  s.state.lockAvailable=false;const before=s.calls.fetch;assert.throws(()=>s.prepare(),/正在準備/);assert.equal(s.calls.fetch,before);assert.equal(s.locked(),false);
});

await test('expired session cleanup removes only transient records and bounds property storage',()=>{
  const s=server(),ticket=s.prepare();s.setTime(ticket.expiresAt+1);s.prepare();assert.equal(s.properties.has('UPLOAD_'+ticket.uploadKey),false);assert.ok(s.properties.has('COLLECTOR_CONFIG'));assert.equal(s.files.size,0);
  const record=[...s.properties].find(([k])=>k.startsWith('UPLOAD_'))[1];
  for(let index=0;index<64;index++)s.properties.set('UPLOAD_'+index.toString(16).padStart(32,'0'),record);
  assert.throws(()=>s.prepare(),/太多未完成/);
});

class Element {
  constructor(tagName){this.tagName=tagName;this.value='';this.hidden=false;this.disabled=false;this.textContent='';this.children=[];this.dataset={};this.listeners={};this.selectors=new Map();}
  set innerHTML(_value){for(const selector of ['.thumbnail','.preview-fallback','.file-name','.file-meta','.state','.row-error','.row-actions'])this.selectors.set(selector,new Element());}
  querySelector(selector){return this.selectors.get(selector);}
  addEventListener(name,listener){this.listeners[name]=listener;}
  setAttribute(name,value){this[name]=value;}
  replaceChildren(...children){this.children=[];this.append(...children);}
  append(...children){for(const child of children){this.children.push(child);child.parent=this;}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
  focus(){this.focused=true;}
}

function frontend(connected=true,now=NOW,origin='https://lok274.github.io') {
  const s=server(now),elements=new Map(),listeners=new Map(),timers=new Map(),requests=[],reads=[];
  const body=new Element('body');let timerSequence=0,clock=now;
  const state={autoReply:true,losePrepare:false,loseChunk:false,nextResult:null};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
  const dispatch=(data,origin='https://script.googleusercontent.com')=>{for(const listener of [...(listeners.get('message')||[])])listener({data,origin});};
  const submit=form=>{
    const request=JSON.parse(form.children.find(child=>child.name==='payload').value);requests.push(request);
    assert.equal(form.action,'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec');assert.equal(form.method,'POST');assert.ok(body.children.some(child=>child.tagName==='iframe'&&child.name===form.target));
    if(!state.autoReply)return;
    let reply;
    if(state.nextResult){reply={id:request.id,method:request.method,ok:true,result:state.nextResult};state.nextResult=null;}
    else reply=post(s,request).reply;
    if((request.method==='prepareUpload'&&state.losePrepare)||(request.method==='uploadChunk'&&state.loseChunk)){state.losePrepare=false;state.loseChunk=false;reply={id:request.id,method:request.method,ok:false,error:'測試模擬連線中斷，請保留此頁並重試。'};}
    queueMicrotask(()=>dispatch(reply));
  };
  const context=vm.createContext({Date:Clock,crypto:webcrypto,location:{origin},
    document:{body,getElementById:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement:tag=>{const element=new Element(tag);if(tag==='form')element.submit=()=>submit(element);return element;}},
    URL:{createObjectURL:()=>'blob:local',revokeObjectURL:()=>{}},window:{addEventListener(name,listener){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(listener);},removeEventListener(name,listener){listeners.get(name)?.delete(listener);}},
    setTimeout:(callback,delay)=>{const id=++timerSequence;timers.set(id,{delay,callback:()=>{timers.delete(id);callback();}});return id;},clearTimeout:id=>timers.delete(id),
    FileReader:class{readAsDataURL(blob){assert.ok(blob.size<=CHUNK,'FileReader reads bounded chunks');reads.push({kind:'base64',size:blob.size,start:blob.start});this.result='data:;base64,'+blob.bytes.toString('base64');queueMicrotask(()=>this.onload());}}
  });
  vm.runInContext(client.replace(/const BACKEND_URL = '[^']*';/,"const BACKEND_URL = '"+(connected?'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec':'')+"';"),context);
  elements.get('upload-code').value=s.config().uploadCode;
  const file=(name='手機相片.png',bytes=png,type='image/png',size=bytes.length)=>({name,type,size,arrayBuffer:()=>{throw new Error('whole-file read forbidden');},slice(start,end){const length=Math.min(size,end)-start;assert.ok(length<=CHUNK,'slice is bounded');const part=Buffer.alloc(length);if(start<bytes.length)bytes.copy(part,0,start,Math.min(start+length,bytes.length));return {start,size:length,bytes:part,arrayBuffer:async()=>{assert.ok(length<=65536,'only prefix is hashed');reads.push({kind:'hash',size:length,start});return part.buffer.slice(part.byteOffset,part.byteOffset+part.byteLength);}};}});
  const add=files=>elements.get('photos').listeners.change({target:{files,value:'selected'}});
  const run=expression=>vm.runInContext(expression,context);
  const states=()=>Array.from(run('rows.map(row=>row.state)'));
  return {s,elements,listeners,timers,requests,reads,state,body,dispatch,file,add,run,states,rpcTimers:()=>[...timers.values()].filter(timer=>timer.delay===120000),setTime:value=>{clock=value;s.setTime(value);}};
}

await test('client sends original image and video with status, bounded reads and reusable preview',async()=>{
  const f=frontend(),bytes=large(CHUNK+33);f.add([f.file('large.png',bytes),f.file('clip.mov',bmff('qt  '),'video/quicktime')]);
  const video=f.run('rows[1].mediaElement');assert.equal(video.tagName,'video');assert.equal(video.muted,true);assert.equal(video.playsInline,true);assert.equal(video.preload,'metadata');assert.equal(video.autoplay,undefined);
  f.run('render()');assert.equal(f.run('rows[1].mediaElement'),video);
  await f.run('startUpload([...rows])');assert.deepEqual(f.states(),['saved','saved']);assert.equal(f.s.files.size,2);assert.equal(f.run('rows[0].uploaded'),bytes.length);
  assert.deepEqual(f.requests.map(r=>r.method),['prepareUpload','getUploadStatus','uploadChunk','uploadChunk','prepareUpload','getUploadStatus','uploadChunk']);
  assert.ok(f.reads.every(read=>read.size<=(read.kind==='hash'?65536:CHUNK)));
  assert.match(f.elements.get('summary').textContent,/已儲存 2 個/);
  f.run('rows[0].mediaElement.onerror()');assert.equal(f.run('rows[0].previewFailed'),true);
});

await test('manual retry checks server progress and retains original ticket after lost chunk response',async()=>{
  const f=frontend();f.add([f.file('clip.png',large(CHUNK+99))]);f.state.loseChunk=true;await f.run('startUpload([...rows])');assert.deepEqual(f.states(),['failed']);const ticket=clone(f.run('rows[0].ticket'));
  const count=f.requests.length;await f.run('startUpload([...rows])');assert.deepEqual(f.states(),['saved']);assert.deepEqual(clone(f.run('rows[0].ticket')),ticket);
  assert.equal(f.requests[count].method,'getUploadStatus');assert.equal(f.requests[count+1].args[2],CHUNK);assert.equal(f.requests.filter(r=>r.method==='prepareUpload').length,1);assert.equal(f.s.calls.quotaWrite,1);
});

await test('lost prepare response reuses fixed metadata, uploadKey, ID and reservation',async()=>{
  const f=frontend();f.add([f.file()]);f.state.losePrepare=true;await f.run('startUpload([...rows])');assert.deepEqual(f.states(),['failed']);const first=f.requests[0].args[1];assert.equal(f.run('rows[0].ticket'),null);
  await f.run('startUpload([...rows])');assert.deepEqual(f.states(),['saved']);assert.deepEqual(f.requests[1].args[1],first);assert.equal(f.s.calls.generate,1);assert.equal(f.s.calls.quotaWrite,1);assert.equal(f.reads.filter(r=>r.kind==='hash').length,1);
});

await test('selection allows exact 2 GiB, 30 mixed files and no oversized or unknown file',()=>{
  const f=frontend();f.add([f.file('big.mp4',bmff('mp42'),'video/mp4',MAX),f.file('too-big.png',png,'image/png',MAX+1),f.file('notes.txt',Buffer.from('text'),'text/plain'),f.file('empty.png',png,'image/png',0)]);
  assert.equal(f.states().length,1);assert.match(f.elements.get('notice').textContent,/2 GB/);
  f.add(Array.from({length:31},(_,index)=>f.file(index+'.dng',Buffer.from('II\x2a\x00','binary'),'')));assert.equal(f.states().length,30);assert.match(f.elements.get('notice').textContent,/最多 30 個/);
  assert.equal(f.run('rows[1].mime'),'image/x-adobe-dng');assert.match(f.run('rows[0].uploadKey'),/^[a-f0-9]{32}$/);assert.equal(f.reads.length,0);
});

await test('2 GiB client reads only prefix and first chunk before an explicit retry',async()=>{
  const f=frontend();f.add([f.file('big.mp4',bmff('mp42'),'video/mp4',MAX)]);f.state.loseChunk=true;
  await f.run('startUpload([...rows])');assert.deepEqual(f.states(),['failed']);
  assert.deepEqual(f.reads.map(r=>[r.kind,r.size]),[['hash',65536],['base64',65536],['base64',CHUNK]]);
  assert.equal(f.requests.filter(r=>r.method==='uploadChunk').length,1);assert.equal(f.s.calls.quotaWrite,1);
  assert.equal(f.run('rows[0].ticket.size'),MAX);assert.equal(f.run('rows[0].uploaded'),0);
});

await test('no-progress replies stop rather than automatically replaying a chunk',async()=>{
  const f=frontend();f.add([f.file('large.png',large(CHUNK+1))]);f.s.state.override=response(308);
  f.s.state.partial=0;await f.run('startUpload([...rows])');assert.deepEqual(f.states(),['failed']);
  assert.equal(f.requests.filter(r=>r.method==='uploadChunk').length,1);assert.match(f.run('rows[0].error'),/未確認新增進度/);
});

await test('failed tickets survive malformed receipts and expiry with no silent renewal',async()=>{
  const f=frontend();f.add([f.file()]);f.state.loseChunk=true;await f.run('startUpload([...rows])');const ticket=clone(f.run('rows[0].ticket'));
  f.state.nextResult={status:'uploading',offset:MAX+1};await f.run('startUpload([...rows])');assert.deepEqual(f.states(),['failed']);assert.match(f.run('rows[0].error'),/未有確認/);
  f.setTime(ticket.expiresAt);await f.run('startUpload([...rows])');assert.deepEqual(f.states(),['failed']);assert.match(f.run('rows[0].error'),/過期/);
  assert.deepEqual(clone(f.run('rows[0].ticket')),ticket);assert.equal(f.requests.filter(r=>r.method==='prepareUpload').length,1);
  const actions=f.elements.get('photo-list').children[0].querySelector('.row-actions').children;assert.equal(actions.some(b=>b.textContent==='移除'),false);
});

await test('preview mode and client cutoff stop requests and preserve saved outcomes',async()=>{
  const preview=frontend(false);preview.add([preview.file()]);await preview.run('startUpload([...rows])');assert.deepEqual(preview.states(),['queued']);assert.equal(preview.requests.length,0);assert.match(preview.elements.get('notice').textContent,/預覽/);
  for(const origin of ['null','http://localhost:8080','https://other.example']){const local=frontend(true,NOW,origin);local.add([local.file()]);await local.run('startUpload([...rows])');assert.equal(local.requests.length,0);assert.equal(local.elements.get('upload').disabled,true);assert.match(local.elements.get('notice').textContent,/預覽/);}
  const f=frontend(true,DEADLINE-1);f.add([f.file()]);await f.run('startUpload([...rows])');assert.deepEqual(f.states(),['saved']);assert.equal(f.run('rows[0].ticket.expiresAt'),DEADLINE);
  f.setTime(DEADLINE);[...f.timers.values()].find(t=>t.delay===1).callback();assert.deepEqual(f.states(),['saved']);
  for(const id of ['upload-code','photos','upload'])assert.equal(f.elements.get(id).disabled,true);
  for(const method of ['prepareUpload','uploadChunk','getUploadStatus'])await assert.rejects(f.run("rpc('"+method+"', [])"),/截止/);
  const late=frontend(true,DEADLINE+1);assert.equal(late.elements.get('photos').disabled,true);assert.match(html,/請在截止前完成上傳；截止後未完成的檔案不能繼續傳送/);
});

await test('postMessage validates origin, random nonce, method and reply schema',async()=>{
  const f=frontend();f.state.autoReply=false;const pending=f.run("rpc('prepareUpload', ['code', {}, 'data'])"),request=f.requests[0];assert.match(request.id,/^[a-f0-9]{32}$/);
  const valid={id:request.id,method:request.method,ok:true,result:{fileId:'valid'}};
  for(const origin of ['null','http://script.google.com','https://evil.example','https://script.googleusercontent.com.evil.example','https://attacker-script.google.com'])f.dispatch(valid,origin);
  for(const reply of [null,{}, {...valid,id:'f'.repeat(32)},{...valid,method:'uploadChunk'},{...valid,ok:'true'},{...valid,result:null},{...valid,ok:false,error:42}])f.dispatch(reply);
  assert.equal(f.rpcTimers().length,1);f.dispatch(valid,'https://abc-123-script.googleusercontent.com');assert.deepEqual(await pending,{fileId:'valid'});assert.equal(f.rpcTimers().length,0);assert.equal(f.body.children.length,0);assert.equal(f.listeners.get('message').size,0);
  await assert.rejects(f.run("rpc('setup_', [])"),/要求無效/);
});

await test('transport timeout cleans up and never automatically replays writes',async()=>{
  const f=frontend();f.state.autoReply=false;const pending=f.run("rpc('uploadChunk', ['code', {}, 0, 'data'])"),rejection=assert.rejects(pending,/連線逾時/);assert.equal(f.rpcTimers()[0].delay,120000);f.rpcTimers()[0].callback();await rejection;
  assert.equal(f.requests.length,1);assert.equal(f.body.children.length,0);assert.equal(f.listeners.get('message').size,0);assert.equal(f.rpcTimers().length,0);
});

await test('a real client retry timeout retains the original ticket and needs another click',async()=>{
  const f=frontend();f.add([f.file()]);f.state.loseChunk=true;await f.run('startUpload([...rows])');
  const ticket=clone(f.run('rows[0].ticket'));f.state.autoReply=false;const retry=f.run('startUpload([...rows])');
  for(let index=0;index<20&&!f.rpcTimers().length;index++)await Promise.resolve();
  const count=f.requests.length;assert.equal(f.requests.at(-1).method,'getUploadStatus');f.rpcTimers()[0].callback();await retry;
  assert.deepEqual(f.states(),['failed']);assert.deepEqual(clone(f.run('rows[0].ticket')),ticket);assert.equal(f.requests.length,count);assert.match(f.run('rows[0].error'),/連線逾時/);
});

console.log('\n'+passed+' checks passed. Mock services only. Real Google authorization, file sharing, phone codecs and 2 GiB uploads still require verification.');
