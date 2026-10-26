import test from 'node:test'
import assert from 'node:assert/strict'
import { freshInlineDraft, readDraft, putDraft, buildBatchEdit, rebaseInlineDraft, resolveInlineConflict, committedInlineDataset, draftCount, cacheInlineDraft, cachedInlineDraft, clearInlineDrafts, retainAccessibleInlineDrafts, inlineDraftEpoch, inlineDraftResume } from '../web/src/core/navigation-inline.ts'
const cat=(id,parentId=null)=>({id,spaceId:'s',name:id,parentId,icon:'folder',sortOrder:0})
const link=(id='l1')=>({id,spaceId:'s',title:id,url:'https://example.invalid/'+id,categoryId:'c2',description:'Original',icon:'link',iconMode:'manual',tags:['one'],sortOrder:1,isFavorite:true,endpoints:[],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'})
const base=()=>({revision:'4',version:1,data:{categories:[cat('c1'),cat('c2','c1')],links:[link()]}})
const edit=(d,kind,id,patch)=>putDraft(d,kind,id,{...readDraft(d,kind,id),...patch})
test('patches preserve omission and explicit null, false, zero, and empty tags',()=>{
 let draft=freshInlineDraft(base())
 draft=edit(draft,'categories','c2',{parentId:null,name:'  Renamed  '})
 draft=edit(draft,'links','l1',{categoryId:null,isFavorite:false,sortOrder:'0',tags:''})
 const {body,errors}=buildBatchEdit(draft)
 assert.deepEqual(errors,[])
 assert.deepEqual(body,{expectedRevision:'4',categories:[{id:'c2',patch:{name:'Renamed',parentId:null}}],links:[{id:'l1',patch:{categoryId:null,isFavorite:false,sortOrder:0,tags:[]}}]})
 assert.equal(draft.base.data.links[0].title,'l1')
})
test('normalized no-op emits no patch; reverting a cell removes its draft',()=>{
 let d=edit(freshInlineDraft(base()),'links','l1',{title:' l1 ',tags:' one,one ， '})
 assert.equal(draftCount(d),1);assert.equal(buildBatchEdit(d).body.links.length,0)
 d=putDraft(d,'links','l1',readDraft(freshInlineDraft(d.base),'links','l1'))
 assert.equal(draftCount(d),0)
})
test('validates final category tree, including simultaneous top-level reparent',()=>{
 let d=edit(freshInlineDraft(base()),'categories','c1',{parentId:'c2'})
 assert(buildBatchEdit(d).errors.some(e=>e.code==='cycle'))
 d=edit(d,'categories','c2',{parentId:null})
 assert.deepEqual(buildBatchEdit(d).errors,[])
 const b=base();b.data.categories=Array.from({length:33},(_,i)=>cat('n'+i,i?'n'+(i-1):null))
 let chain=edit(freshInlineDraft(b),'categories','n0',{name:'Changed'})
 assert(buildBatchEdit(chain).errors.some(e=>e.code==='depth'))
 chain=edit(chain,'categories','n32',{parentId:null})
 assert.deepEqual(buildBatchEdit(chain).errors,[])
})
test('invalid content identifies row and field and refuses a 501-record batch',()=>{
 for(const [field,value,code]of [['url','javascript:alert(1)','url'],['sortOrder','1.5','order'],['title',' ','title'],['tags',Array(33).fill(0).map((_,i)=>'t'+i).join(','),'tags']]){
  const d=edit(freshInlineDraft(base()),'links','l1',{[field]:value})
  assert(buildBatchEdit(d).errors.some(e=>e.id==='l1'&&e.field===field&&e.code===code))
 }
 const b=base();b.data.links=Array.from({length:501},(_,i)=>link('l'+i))
 let d=freshInlineDraft(b);for(const row of b.data.links)d=edit(d,'links',row.id,{title:'Updated '+row.id})
 assert(buildBatchEdit(d).errors.some(e=>e.code==='limit'))
 d=putDraft(d,'links','l500',readDraft(freshInlineDraft(b),'links','l500'))
 assert(!buildBatchEdit(d).errors.some(e=>e.code==='limit'))
})
test('readback preserves touched fields and accepts concurrent untouched fields',()=>{
 const b=base(),d=edit(freshInlineDraft(b),'links','l1',{title:'Mine'})
 const latest=structuredClone(b);latest.revision='5';latest.data.links[0].description='Remote description'
 const rebased=rebaseInlineDraft(d,latest)
 assert.deepEqual(rebased.conflicts,[])
 assert.equal(readDraft(rebased.draft,'links','l1').description,'Remote description')
 assert.deepEqual(buildBatchEdit(rebased.draft).body.links,[{id:'l1',patch:{title:'Mine'}}])
 assert.equal(buildBatchEdit(rebased.draft).body.expectedRevision,'5')
})
test('field conflict requires an explicit mine/server resolution',()=>{
 const b=base(),d=edit(freshInlineDraft(b),'links','l1',{title:'Mine',tags:'a,b'})
 const latest=structuredClone(b);latest.revision='5';latest.data.links[0].title='Remote'
 const result=rebaseInlineDraft(d,latest)
 assert.equal(result.conflicts.length,1);assert.equal(result.conflicts[0].field,'title')
 const mine=resolveInlineConflict(result.draft,result.conflicts[0],'mine')
 assert.equal(readDraft(mine,'links','l1').title,'Mine')
 const server=resolveInlineConflict(result.draft,result.conflicts[0],'server')
 assert.deepEqual(buildBatchEdit(server).body.links,[{id:'l1',patch:{tags:['a','b']}}])
})
test('lost response readback recognises changes already committed by server',()=>{
 const b=base(),d=edit(freshInlineDraft(b),'links','l1',{title:' Saved ',tags:'one,two,two'})
 const latest=structuredClone(b);latest.revision='5';latest.data.links[0].title='Saved';latest.data.links[0].tags=['one','two']
 const result=rebaseInlineDraft(d,latest)
 assert.deepEqual(result.conflicts,[]);assert.equal(draftCount(result.draft),0)
})
test('deleted rows cannot be silently recreated',()=>{
 const b=base(),d=edit(freshInlineDraft(b),'links','l1',{title:'Mine'})
 const latest=structuredClone(b);latest.revision='5';latest.data.links=[]
 const result=rebaseInlineDraft(d,latest)
 assert.equal(result.conflicts[0].field,'$deleted')
 assert(buildBatchEdit(result.draft).errors.some(e=>e.code==='deleted'))
 assert.equal(draftCount(resolveInlineConflict(result.draft,result.conflicts[0],'server')),0)
})
test('commit replaces only server-confirmed records and retains untouched records',()=>{
 const b=base(),d=edit(freshInlineDraft(b),'links','l1',{title:' Mine '})
 const saved={...b.data.links[0],title:'Mine',updatedAt:'2026-02-01T00:00:00Z'}
 const result=committedInlineDataset(d,{revision:'5',updatedCount:1,categories:[],links:[saved]})
 assert.equal(result.revision,'5');assert.deepEqual(result.data.links,[saved]);assert.deepEqual(result.data.categories,b.data.categories)
})
test('memory drafts are isolated by account and space; logout invalidates stale callbacks',()=>{
 clearInlineDrafts()
 const draft=edit(freshInlineDraft(base()),'links','l1',{title:'Private draft'})
 const entry={identity:'a:public_read',spaceId:'s',kind:'links',draft,conflicts:[],needsRead:false}
 const epoch=inlineDraftEpoch(entry.identity,'s')
 cacheInlineDraft(entry,epoch)
 assert.equal(cachedInlineDraft('b:public_read','s'),undefined)
 assert.deepEqual(inlineDraftResume(entry.identity),{spaceId:'s',kind:'links'})
 clearInlineDrafts();cacheInlineDraft(entry,epoch)
 assert.equal(cachedInlineDraft(entry.identity,'s'),undefined)
 cacheInlineDraft(entry,inlineDraftEpoch(entry.identity,'s'))
 const beforeRevocation=inlineDraftEpoch(entry.identity,'s')
 retainAccessibleInlineDrafts(entry.identity,[])
 cacheInlineDraft(entry,beforeRevocation)
 assert.equal(cachedInlineDraft(entry.identity,'s'),undefined)
 clearInlineDrafts()
})
