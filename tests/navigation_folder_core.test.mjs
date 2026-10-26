import test from 'node:test'
import assert from 'node:assert/strict'
import {navigationGroupPreviewCounts,navigationFolderPageSize,normalizeNavigationGroupPreviewCount,navigationGroupPreview,navigationFolderPage} from '../web/src/core/navigation-folder.ts'
const links=n=>Object.freeze(Array.from({length:n},(_,i)=>Object.freeze({id:String(i),title:'Bookmark '+i,url:'https://bookmarks.example.invalid/'+i,description:'Description '+i,tags:Object.freeze(['common',i%2?'odd':'even'])})))
test('folder options default to six and retain zero as show all',()=>{
 assert.deepEqual([...navigationGroupPreviewCounts],[0,4,6,8,12,24])
 for(const value of navigationGroupPreviewCounts)assert.equal(normalizeNavigationGroupPreviewCount(value),value)
 for(const value of [undefined,null,false,'6',-1,5,7,6.5,NaN,Infinity,{},[]])assert.equal(normalizeNavigationGroupPreviewCount(value),6)
 assert.equal(navigationGroupPreview(links(75),0).hiddenCount,0)
})
test('preview preserves records and order; six/seven is the default boundary',()=>{
 for(const n of [0,3,6,7,30]){const input=links(n),before=JSON.stringify(input),result=navigationGroupPreview(input,undefined)
 assert.equal(result.visible.length,Math.min(6,n));assert.equal(result.totalCount,n);assert.equal(result.hiddenCount,Math.max(0,n-6));assert.deepEqual(result.visible,input.slice(0,6));assert.equal(JSON.stringify(input),before)}
})
test('24/25 boundaries and 1000-item traversal have no omissions or duplicates',()=>{
 assert.equal(navigationFolderPageSize,24)
 for(const n of [24,25,1000]){const input=links(n),ids=[]
 const pages=navigationFolderPage(input,'',1).pageCount
 for(let p=1;p<=pages;p++){const part=navigationFolderPage(input,'',p);assert(part.items.length<=24);ids.push(...part.items.map(x=>x.id));assert.equal(part.end,Math.min(p*24,n))}
 assert.deepEqual(ids,input.map(x=>x.id));assert.equal(new Set(ids).size,n)}
})
test('invalid pages clamp and a filtered page cannot become empty off the end',()=>{
 const input=links(100)
 for(const p of [-1,0,NaN,Infinity])assert.equal(navigationFolderPage(input,'',p).page,1)
 assert.equal(navigationFolderPage(input,'',2.9).page,2)
 const even=navigationFolderPage(input,'even',99)
 assert.deepEqual([even.count,even.page,even.pageCount,even.start,even.end],[50,3,3,49,50]);assert.deepEqual(even.items.map(x=>x.id),['96','98'])
 const empty=navigationFolderPage(input,'absent',4);assert.deepEqual([empty.count,empty.page,empty.pageCount,empty.start,empty.end],[0,1,1,0,0])
})
test('Unicode, multi-term and literal punctuation search span all searchable fields',()=>{
 const input=[{id:'work',title:'工作工具 Café C++ [Internal]',url:'https://EXAMPLE.invalid/docs',description:'团队工作流',tags:['自动化','Cloud']},{id:'home',title:'个人收藏',url:'https://personal.invalid',tags:['Home']}]
 for(const q of ['工作工具','EXAMPLE.invalid/docs','团队工作流','自动化','ＣＬＯＵＤ 自动化','CAFE\u0301','C++','[Internal]']){const result=navigationFolderPage(input,q,1,'zh-CN');assert.equal(result.count,1);assert.equal(result.items[0].id,'work')}
 assert.equal(navigationFolderPage(input,'Cloud Home',1).count,0)
 assert.equal(navigationFolderPage(input,' \t\n\u3000 ',1).count,2)
})
