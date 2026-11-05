import { expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { Session } from '@deepseek-ai/dsh-session'
import { createHistoryView } from '../src/index.ts'
import { collectHistory, readHistoryItem, searchHistory } from '../src/history.ts'
import { engineHarness, followup, ScriptedAdapter, textResponse, toolCall } from './harness.ts'
const text = (m: {content: readonly {type:string;text?:string}[]}) => m.content.filter(b=>b.type==='text').map(b=>b.text).join('')
const id = (s:string) => /\n\[id: (\d+)\]$/.exec(s)?.[1]
it('delivers ordered short IDs on first consumption and restores original Unicode content after prune, reset and replay', async()=>{
  const {ctx,agent,session,engine}=await engineHarness('short-roundtrip')
  await ctx.plugin(ToolResultPruner,{thresholdChars:120,headChars:30,tailChars:0})
  ctx.on('agent/pre-step',async(_p,next)=>{const d=await next();ctx.toolResultPruner.pruneSession(session);return d})
  const body='START '+ '😀'.repeat(4000)+' ORIGINAL_TAIL'
  ctx.tools.register(defineTool({name:'material',description:'Read test material',parameters:{},output:{schema:{type:'json'},render:()=>[{type:'text',text:body}]},execute:async()=>({ok:true})}))
  const adapter=new ScriptedAdapter([toolCall('material','{}','read-one'),textResponse('finished '+'filler '.repeat(1000))])
  ctx.llm.registerAdapter(['mock'],adapter)
  await followup(agent,'USER_REQUEST')
  const first=adapter.requests[0]!.find(m=>text(m).startsWith('USER_REQUEST'))!
  const result=adapter.requests[1]!.find(m=>m.role==='tool')!
  expect(id(text(first))).toMatch(/^\d{1,3}$/)
  expect(Number(id(text(result)))).toBeGreaterThan(Number(id(text(first))))
  expect(text(result)).toContain('middle pruned')
  expect(text(result)).not.toContain('ORIGINAL_TAIL')
  const native=session.snapshotEvents().find(e=>e.type==='tool/result')!
  const source=createHistoryView(session.id,session.snapshotEvents())
  expect(source.read(`${session.id}:initial`,String(native.seq)).content).toContain('ORIGINAL_TAIL')
  await engine.compactNow(agent,new AbortController().signal)
  const own=searchHistory(session,{query:'ORIGINAL_TAIL'})
  expect(own.items).toHaveLength(1)
  expect(own.items[0]!.item_id).toBe(id(text(result)))
  const replay=Session.create(session.id,JSON.parse(JSON.stringify(session.snapshotEvents())),session.header)
  const item=readHistoryItem(replay,`${session.id}:initial`,id(text(result))!,3980,200)
  expect(item.content).toContain('ORIGINAL_TAIL')
  expect(item.content).not.toContain('[id:')
  expect(collectHistory(replay).filter(i=>i.role==='tool')).toHaveLength(1)
})
it('does not archive an active logical message merely to attach its ID',async()=>{
  const {ctx,agent,session}=await engineHarness('active-ids')
  ctx.tools.register(defineTool({name:'material',description:'test',parameters:{},output:{schema:{type:'json'},render:()=>[{type:'text',text:'small result'}]},execute:async()=>({ok:true})}))
  const adapter=new ScriptedAdapter([toolCall('material','{}'),textResponse('done')]);ctx.llm.registerAdapter(['mock'],adapter)
  await followup(agent,'active request')
  expect(id(text(adapter.requests[1]!.find(m=>m.role==='tool')!))).toBeDefined()
  expect(collectHistory(session)).toEqual([])
})
it('keeps errors from pipeline failures and finalizer replacements identifiable',async()=>{
 const {ctx,agent}=await engineHarness('final-ids')
 ctx.tools.register(defineTool({name:'finalized',description:'test',parameters:{},output:{schema:{type:'json'},render:()=>[{type:'text',text:'before'}]},finalizeContent:()=>[{type:'text',text:'AFTER_FINALIZER'}],execute:async()=>({ok:true})}))
 ctx.on('tools/execute',async(exec,next)=>{if(exec.name==='broken')throw Error('PIPELINE_ERROR');return next()})
 ctx.tools.register(defineTool({name:'broken',description:'test',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:async()=>({})}))
 const adapter=new ScriptedAdapter([toolCall('finalized','{}','f'),toolCall('broken','{}','b'),textResponse('done')]);ctx.llm.registerAdapter(['mock'],adapter)
 await followup(agent,'run')
 for(const needle of ['AFTER_FINALIZER','PIPELINE_ERROR']){const m=adapter.requests.at(-1)!.find(m=>m.role==='tool'&&text(m).includes(needle))!;expect(id(text(m))).toBeDefined()}
})
it('prices marker replacements exactly, is idempotent and replays the same signed delta',async()=>{
  const {ctx,session}=await engineHarness('marker-price')
  const {appendExchange}=await import('./harness.ts')
  const {markToolResults}=await import('../src/item-id.ts')
  appendExchange(session,1,'body',true)
  const before=ctx.tokenMeter.measure(session)
  const original=session.deriveMessages().find(m=>m.role==='tool')!
  markToolResults(session,ctx.tokenMeter)
  const projected=session.deriveMessages().find(m=>m.role==='tool')!
  const delta=ctx.tokenMeter.estimateMessage(projected)-ctx.tokenMeter.estimateMessage(original)
  expect(delta).toBeGreaterThan(0)
  expect(ctx.tokenMeter.measure(session).totalTokens-before.totalTokens).toBe(delta)
  const revision=session.seq
  markToolResults(session,ctx.tokenMeter)
  expect(session.seq).toBe(revision)
  const replay=Session.create(session.id,JSON.parse(JSON.stringify(session.snapshotEvents())),session.header)
  expect(ctx.tokenMeter.measure(replay).totalTokens).toBe(ctx.tokenMeter.measure(session).totalTokens)
  expect(replay.deriveMessages()).toEqual(session.deriveMessages())
})
it('preserves literal marker-looking blocks and only strips plugin-owned annotations',async()=>{
 const {session}=await engineHarness('literal-marker')
 const {createUserMessage}=await import('@deepseek-ai/dsh-llm')
 const {markInputs,stripItemId}=await import('../src/item-id.ts')
 const input=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'literal'},{type:'text',text:'\n[id: 1]'}]})
 expect(stripItemId(input.content)).toEqual(input.content)
 const [marked]=markInputs(session,[input])
 expect(markInputs(session,[marked!])).toEqual([marked])
 expect(stripItemId(marked!.content)).toEqual(input.content)
 session.append('user/message',input,{surfaceOp:'append'})
 const {normalizedItems}=await import('../src/history.ts')
 expect(normalizedItems(session)[0]!.content).toContain('[id: 1]')
})
it('keeps a first admitted input ID stable when native controls are committed before it',async()=>{
 const {session}=await engineHarness('late-native-controls')
 const {createUserMessage}=await import('@deepseek-ai/dsh-llm')
 const {markInputs,itemIds}=await import('../src/item-id.ts')
 const {normalizedItems}=await import('../src/history.ts')
 const input=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'ORIGINAL_REQUIREMENT'}]})
 const [marked]=markInputs(session,[input])
 expect(id(text(marked!))).toBe('1')
 for(const kind of ['skill-catalog','agent-instructions'])session.append('user/message',createUserMessage({source:{kind} as Parameters<typeof createUserMessage>[0]['source'],content:[{type:'text',text:'NATIVE_CONTROL'}]}),{surfaceOp:'append'})
 session.append('user/message',marked!,{surfaceOp:'append'})
 const replay=Session.create(session.id,JSON.parse(JSON.stringify(session.snapshotEvents())),session.header)
 expect(itemIds(replay.snapshotEvents()).get(input.id)).toBe('1')
 expect(normalizedItems(replay)).toMatchObject([{item_id:'1',content:'ORIGINAL_REQUIREMENT'}])
})

it('restarts IDs in each successful window and resolves identical short IDs by their original windows after replay', async () => {
  const {ctx,agent,session,engine}=await engineHarness('window-local-ids')
  const {currentWindow,normalizedItems}=await import('../src/history.ts')
  const adapter=new ScriptedAdapter([textResponse('completed work '+'detail '.repeat(2000))])
  ctx.llm.registerAdapter(['mock'],adapter)
  const references: Array<{window:string;body:string}> = []
  for (const body of ['FIRST_WINDOW_REQUEST','SECOND_WINDOW_REQUEST','THIRD_WINDOW_REQUEST']) {
    const window=currentWindow(session).window_id
    await followup(agent,body)
    const input=adapter.requests.at(-1)!.find(m=>m.content.some(b=>b.type==='text'&&b.text===body))!
    expect(id(text(input))).toBe('1')
    references.push({window,body})
    await engine.compactNow(agent,new AbortController().signal)
  }
  const replay=Session.create(session.id,JSON.parse(JSON.stringify(session.snapshotEvents())),session.header)
  for (const {window,body} of references) expect(readHistoryItem(replay,window,'1').content).toBe(body)
  expect(normalizedItems(replay).filter(i=>i.role==='user').map(i=>i.item_id)).toEqual(['1','1','1'])
})

it('does not restart numbering for an incomplete or failed native compaction', async () => {
  const {ctx,agent,session,engine}=await engineHarness('failed-window-ids')
  const {createUserMessage}=await import('@deepseek-ai/dsh-llm')
  const {itemIds}=await import('../src/item-id.ts')
  const adapter=new ScriptedAdapter([textResponse('completed work '+'detail '.repeat(2000))])
  ctx.llm.registerAdapter(['mock'],adapter)
  await followup(agent,'ORIGINAL')
  await engine.compactNow(agent,new AbortController().signal)
  const events=session.snapshotEvents()
  const pending=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'PENDING'}]})
  const incomplete=events.filter(e=>e.type!=='compaction/end')
  const failed=events.map(e=>e.type==='compaction/end'?{...e,data:{...e.data,error:'failed'}}:e)
  expect(itemIds(incomplete,[pending]).get(pending.id)).toBe('3')
  expect(itemIds(failed,[pending]).get(pending.id)).toBe('3')
  expect(itemIds(events,[pending]).get(pending.id)).toBe('1')
})
