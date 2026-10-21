// Pause policy at the delivery boundary (cases found by the Reviewer): a pause that starts after a lease was yielded, and a queued peer whose sender left.
import { describe, expect, test } from "bun:test";
import { createAgentRegistry } from "../../hub/core/agents";
import { createStreamHandlers } from "../../hub/features/streams";

// In-process, so the ordering that matters is exact: a removed agent's stream ends in a microtask, and a
// new stream of the same name can register in the same turn, before that cleanup runs.
function world(staleMs = 60_000) {
  const registry = createAgentRegistry({
    defaultRoom: "d", staleMs, queueMax: 10,
    resolveRoom: (r) => r ?? "d", onRosterChange() {}, onPresenceChange() {},
  });
  const handlers = createStreamHandlers({
    sessionId: "s", uiQueueMax: 10, defaultRoom: "d", ledgerEnabled: () => false,
    chatLog: [], uiSubscribers: new Set(), agents: registry, ensureAgent: registry.ensure,
    broadcastPresence() {}, roomHydrator: null, roomSummariser: null,
    buildBriefing: () => ({ type: "briefing" }) as any, seedBriefingSignature() {},
    kinds: [], buildCap: () => ({}) as any,
  });
  const open: Response[] = [];
  const stream = (name: string) => { const r = handlers.handleAgentStream(name, "r"); open.push(r); return r; };
  const closeAll = async () => { for (const r of open) await r.body?.cancel().catch(() => {}); };
  const tick = () => new Promise((r) => setTimeout(r, 20));
  return { registry, stream, closeAll, tick };
}


test('pause between yielded lease and SSE send still drops peer chat',async()=>{
 const w=world();w.registry.ensure('bob','r');const response=w.stream('alice');
 w.registry.enqueueFor('alice',{from:'bob',to:'alice',text:'late-peer',ts:'',image:null,room:'r'});
 await Promise.resolve();w.registry.setPaused('alice',true);
 w.registry.enqueueFor('alice',{from:'you',to:'alice',text:'human-sentinel',ts:'',image:null,room:'r'});
 const reader=response.body!.getReader();let text='';try{for(let i=0;i<8&&!text.includes('human-sentinel');i++){const r=await reader.read();if(r.done)break;text+=new TextDecoder().decode(r.value);}}finally{await reader.cancel();await w.closeAll();}
 expect(text).toContain('human-sentinel');expect(text).not.toContain('late-peer');
});
test('queued chat from a removed peer remains peer chat under pause',async()=>{
 const w=world();w.registry.ensure('alice','r');w.registry.ensure('bob','r');
 w.registry.enqueueFor('alice',{from:'bob',to:'alice',text:'departed-peer',ts:'',image:null,room:'r'});w.registry.setPaused('alice',true);w.registry.remove('bob','fixture departed');
 w.registry.enqueueFor('alice',{from:'you',to:'alice',text:'human-sentinel',ts:'',image:null,room:'r'});const ac=new AbortController();
 try{const got=await w.registry.subscribeLeased('alice',ac.signal).next();expect(got.value?.item.text).toBe('human-sentinel');got.value?.take();}finally{ac.abort();await w.closeAll();}
});
