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
