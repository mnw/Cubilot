import re,glob,json,os
P='/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/canvas/project/'
exec(open('/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/lib.py').read().split('# phone')[0].replace("_t=open(P+'Ticket.dc.html')","_t=open(P+'Ticket.dc.html')"))
def body(f): s=open(P+f+'.dc.html').read(); return s[s.index('</helmet>')+9:s.index('</x-dc>')]
def rootvars(f): s=open(P+f+'.dc.html').read(); return re.search(r':root\{color-scheme:\w+;([^}]*)\}',s).group(1)
names=sorted({os.path.basename(f)[:-8] for f in glob.glob(P+'*.dc.html')})
# More sheet for phone
lib=open('/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/lib.py').read()
ns={}; exec(lib,ns)
items=[('Dashboard','DashboardPhone','6/18 milestones'),('Admin','Admin','checks, backup'),('Requests','RequestsPhone','3 open'),('Delivery','DeliveryPhone','1 ready for your test'),('Settings','Settings','theme, config, room'),('Dialogs and toasts','Dialogs',''),('Coverage','Coverage','every feature')]
li=''.join(f'<a href="{t}.dc.html" style="display: flex; justify-content: space-between; align-items: center; min-height: 56px; padding: 0 14px; {"border-top: 1px solid var(--line-soft);" if i else ""} color: var(--text); text-decoration: none"><span>{a}</span><span style="font-size: 14px; color: var(--text-meta)">{b} ›</span></a>' for i,(a,t,b) in enumerate(items))
more=ns['phdr']('More','',False)+f'<div style="flex: 1; padding: 14px 16px"><div style="{ns["CARD"]}; overflow: hidden">{li}</div></div>'+ns['pnav']('More')
moreD='<div style="width: 390px; height: 844px; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 16px; line-height: 1.45; overflow: hidden; position: relative">'+more+'</div>'
tpl={n:body(n) for n in names}
tpl['MorePhone']=moreD; tpl['MorePhoneLight']=moreD
dark=rootvars('Ticket')+'--bg-hover:#2f2621;'; light=rootvars('TicketLight')+'--bg-hover:#dfdad9;'
css=f'''
:root{{{dark};color-scheme:dark}}
@media (prefers-color-scheme: light){{:root:not([data-theme="dark"]){{{light};color-scheme:light}}}}
:root[data-theme="light"]{{{light};color-scheme:light}}
:root[data-theme="dark"]{{{dark};color-scheme:dark}}
html,body{{background:var(--bg)}}
body{{margin:0;color:var(--text);font-family:var(--sans)}}
*{{box-sizing:border-box}}
button,textarea,input,select{{font:inherit}}
a{{color:var(--orange-text)}}
code{{font-family:var(--mono);color:var(--code-text);font-size:12px}}
th{{font-weight:500}}
@media (max-width: 900px){{.c-side{{display:none !important}}}}
:focus-visible{{outline:2px solid var(--orange);outline-offset:2px}}
#stage.phone{{display:flex;justify-content:center;padding:24px max(16px, env(safe-area-inset-right, 0px)) 96px max(16px, env(safe-area-inset-left, 0px))}}
#stage.phone>.frame{{border:1px solid var(--line-hover);border-radius:28px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);max-width:100%}}
#pbar{{position:fixed;z-index:1000;right:calc(16px + env(safe-area-inset-right, 0px));bottom:calc(40px + env(safe-area-inset-bottom, 0px));display:flex;gap:6px;align-items:center;padding:6px;border:1px solid var(--line-hover);border-radius:10px;background:var(--bg-raised);box-shadow:0 10px 30px rgba(0,0,0,.35);font-size:13px;color:var(--text)}}
#pbar select,#pbar button{{height:30px;border:1px solid var(--line-hover);border-radius:6px;background:var(--bg-inset);color:var(--text);padding:0 8px;cursor:pointer;font-size:13px}}
#pbar .lab{{font-family:var(--mono);font-size:11px;letter-spacing:.08em;color:var(--text-meta);padding:0 4px}}
#toast{{position:fixed;z-index:1001;left:50%;bottom:calc(96px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);max-width:calc(100% - 32px);padding:10px 14px;border:1px solid var(--line-hover);border-left:3px solid var(--orange);border-radius:8px;background:var(--bg-raised);color:var(--text);font-size:14px;box-shadow:0 10px 30px rgba(0,0,0,.35)}}
@media (prefers-reduced-motion: no-preference){{#stage>*{{animation:fi .14s ease-out}}@keyframes fi{{from{{opacity:.6}}to{{opacity:1}}}}}}
'''
H={'Diagnosis':'why-it-failed','Mutation':'mutation','Deliver':'deliver','Admin':'admin','SetupStart':'setup','SetupComponents':'setup-components','SetupInstall':'setup-install','SetupAccounts':'setup-accounts','Login':'sign-in','SignInStates':'sign-in-states','Dashboard':'dashboard','Main':'decisions','Request':'request','Ticket':'ticket','Session':'session','Room':'room','RoomCards':'room-cards','Flow':'flow','TicketForm':'ticket-new','Agents':'agents','Requests':'requests','Delivery':'delivery','Settings':'app-settings','Dialogs':'dialogs','Coverage':'coverage','More':'more'}
PH={'Diagnosis':'DiagnosisPhone','Login':'LoginPhone','Dashboard':'DashboardPhone','Main':'DecisionsPhone','Request':'RequestPhone','Ticket':'TicketPhone','Session':'SessionPhone','Room':'RoomPhone','Flow':'FlowPhone','TicketForm':'TicketFormPhone','Agents':'AgentsPhone','Requests':'RequestsPhone','Delivery':'DeliveryPhone','More':'MorePhone'}
LABEL={'Login':'Sign in','SignInStates':'Sign-in states','Main':'Decisions','Dashboard':'Dashboard','Request':'Request · plan to approve','Ticket':'Ticket · in review','Session':'Agent session · terminal','Room':'Room','RoomCards':'Room · cards and menus','Flow':'Flow','TicketForm':'New ticket form','Agents':'Agents · launch, menu, shell','Requests':'Requests','Delivery':'Delivery','Settings':'Settings','Admin':'Admin','Diagnosis':'Stage diagnosis','Mutation':'Mutation result','Deliver':'Deliver to client','SetupStart':'Setup 0 · start','SetupComponents':'Setup 1 · components','SetupInstall':'Setup 3 · install','SetupAccounts':'Setup 4 · accounts','Dialogs':'Dialogs and toasts','Coverage':'Coverage'}
opts=''.join(f'<option value="{k}">{v}</option>' for k,v in LABEL.items())
templates=''.join(f'<template id="t-{k}">{v}</template>\n' for k,v in tpl.items())
js=r'''
const H=%s, PH=%s;
const R=Object.fromEntries(Object.entries(H).map(([k,v])=>[v,k]));
const PHR=Object.fromEntries(Object.entries(PH).map(([k,v])=>[v,k]));
const stage=document.getElementById('stage'), pick=document.getElementById('pick'), toastEl=document.getElementById('toast');
let device = matchMedia('(max-width: 760px)').matches ? 'phone' : 'desktop';
try{ device = localStorage.getItem('cub-device') || device; }catch(e){}
let cur='Main';
function theme(){ const t=document.documentElement.dataset.theme; if(t==='light'||t==='dark') return t; return matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'; }
function tid(base){ let n=base; if(device==='phone'){ n = PH[base]; if(!n) return null; } return n+(theme()==='light'?'Light':''); }
function render(){
  let id=tid(cur), note='';
  if(!id){ id=cur+(theme()==='light'?'Light':''); note='No phone board for this screen: showing the desktop one.'; }
  let t=document.getElementById('t-'+id), ph=(device==='phone' && PH[cur]);
  if(!t && PH[cur]){ t=document.getElementById('t-'+PH[cur]+(theme()==='light'?'Light':'')); ph=true; }
  if(!t){ toast('Missing board '+id); return; }
  stage.className = ph ? 'phone' : '';
  stage.innerHTML='';
  const node=t.content.cloneNode(true);
  if(stage.className==='phone'){ const f=document.createElement('div'); f.className='frame'; f.appendChild(node); stage.appendChild(f); } else stage.appendChild(node);
  pick.value = cur in %s ? cur : pick.value;
  document.getElementById('dev').textContent = device==='phone'?'Phone':'Desktop';
  document.getElementById('thm').textContent = theme()==='light'?'Light':'Dark';
  document.title = 'Cubilot prototype';
  window.scrollTo(0,0);
  if(note) toast(note);
}
function go(base){ if(base===cur){ render(); return; } location.hash = H[base]||'decisions'; }
function fromHash(){ const h=location.hash.slice(1); cur = R[h] || 'Login'; render(); }
window.addEventListener('hashchange', fromHash);
let tt; function toast(m){ toastEl.textContent=m; toastEl.hidden=false; clearTimeout(tt); tt=setTimeout(()=>toastEl.hidden=true,2600); }
pick.addEventListener('change',()=>go(pick.value));
document.getElementById('dev').addEventListener('click',()=>{ device = device==='phone'?'desktop':'phone'; try{localStorage.setItem('cub-device',device)}catch(e){} render(); });
document.getElementById('thm').addEventListener('click',()=>{ document.documentElement.dataset.theme = theme()==='light'?'dark':'light'; render(); });
matchMedia('(prefers-color-scheme: light)').addEventListener('change',render);
new MutationObserver(render).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
const BYLABEL={'room instructions':'Room','factory map':'Coverage','project folder':'Agents','settings':'Settings','open settings':'Settings','michel':'Settings','michel, settings':'Settings','launch agent':'Agents','new ticket':'TicketForm'};
const BYTEXT=[['deliver to the client','Deliver'],['checks, components','Admin'],['new factory choose','SetupComponents'],['see the plan','SetupInstall'],['continue to accounts','SetupAccounts'],['why it failed','Diagnosis'],['project setting: mutation','Admin'],['sign in with a passkey','Main'],['sign in','Main'],['use password and code','SignInStates'],['use a recovery code','SignInStates'],['back to passkey','Login'],['open the decision','Main'],['decide','Main'],['read the full plan','Request'],['read plan','Request'],['show all 18','Request'],['watch','Session'],['session output','Session'],['open ticket','Ticket'],['facts','Ticket'],['edit settings','Settings'],['stage metrics','Delivery'],['cancel traces','Settings'],['all finished sessions','Agents'],['finished sessions','Agents'],['merged requests','Requests'],['what you will test','Delivery'],['decided today','Main'],['6 decided','Main'],['new factory room','Dialogs'],['+ new room','Dialogs'],['launch command','Dialogs'],['show…','Dialogs'],['edit…','Dialogs'],['archive transcript','Dialogs'],['archive…','Dialogs'],['cancel ticket','Dialogs'],['decline…','Dialogs'],['kill session','Dialogs'],['remove agent','Dialogs'],['⚠ interrupt','Dialogs'],['reply with something else','Room'],['+ new ticket','TicketForm'],['new ticket','TicketForm'],['+ launch agent','Agents'],['launch agent','Agents'],['add agent','Agents'],['+ start a request','Requests'],['start a request','Requests'],['shell','Agents'],['other deliveries','Delivery'],['part-4-sessions','Delivery'],['open folder','Agents'],['skills folder','Agents'],
 ['decisions','Main'],['requests','Requests'],['flow','Flow'],['dashboard','Dashboard'],['show all 18 and the burn-up','Dashboard'],['room','Room'],['agents','Agents'],['delivery','Delivery'],['more','More'],['settings','Settings'],['coverage','Coverage'],['dialogs','Dialogs']];
const DONE={'approve plan':'Plan approved. The Orchestrator queues the first tickets.','approve':'Approved.','allow merge':'Merge allowed.','choose a':'You chose A. The ruling goes to the ticket.','choose b':'You chose B.','send':'Sent to the Orchestrator.','send review':'Scoped review sent.','send scoped review':'Scoped review sent.','queue':'Queued.','queue without review':'Queued without review.','create in draft':'Created t_7c1e in Draft.','launch':'Launching worker-3…','accept':'Accepted.','allow':'Allowed.','deny':'Denied.','dismiss':'Dismissed.','overrule':'Overruled: the Orchestrator reopens it.','take control':'You have control. The hub holds messages for this agent.','hand back':'Handed back. Held messages are delivered.','pause room':'Room paused. Agents finish their current tool call.','apply and restart hub':'Hub restarting… agents keep running.','copy':'Copied.','pin':'Pinned.','add note':'Note added to the ticket.','accept: ready to merge':'Accepted. Merge staging into main when you are ready.','send back':'Sent back with your note.','send back 1 problem':'Sent back: 1 problem becomes a ticket note.','send request':'Request sent. The Orchestrator writes the plan.','propose edit':'Proposed to the lead.','create room':'Room my-product created.','clear':'Cleared.','turn all on':'All MCP servers on. Relaunch to apply.'};
function label(el){ return (el.getAttribute('aria-label')||'').trim().toLowerCase(); }
function text(el){ return (el.innerText||el.textContent).replace(/\s+/g,' ').trim().toLowerCase(); }
stage.addEventListener('submit',e=>e.preventDefault());
stage.addEventListener('click',e=>{
  const a=e.target.closest('a[href]');
  if(a){ const h=a.getAttribute('href'); const m=h.match(/^([A-Za-z]+)\.dc\.html$/); if(m){ e.preventDefault(); let b=m[1].replace(/Light$/,''); if(PHR[b]) b=PHR[b]; go(b); return; } }
  const el=e.target.closest('a,button,[role=switch],[role=option],[role=menuitem],[role=tab]'); if(!el) return;
  e.preventDefault();
  const sw=el.matches('[role=switch]')?el:el.querySelector('[role=switch]');
  if(sw){ const on=sw.getAttribute('aria-checked')!=='true'; sw.setAttribute('aria-checked',on); sw.style.background=on?'var(--orange)':'var(--bg-elev)'; const k=sw.firstElementChild; if(k){k.style.left=on?'16px':'2px';k.style.background=on?'#1a1714':'var(--text-meta)';} return; }
  if(el.hasAttribute('aria-pressed')){ const g=el.parentElement; g.querySelectorAll('[aria-pressed]').forEach(b=>{b.setAttribute('aria-pressed','false'); b.style.background='none';}); el.setAttribute('aria-pressed','true'); el.style.background='var(--bg-elev)'; return; }
  const l=label(el), t=text(el);
  if(l==='back'){ history.back(); return; }
  if(l==='close' || ((t==='cancel'||t==='back'||t==='keep it') && (cur==='TicketForm'))){ history.back(); return; }
  if(l==='search' || t.startsWith('find a ticket')){ pick.focus(); toast('Pick any screen in the prototype bar (bottom right).'); return; }
  if(cur==='Ticket' && t==='edit'){ go('TicketForm'); return; }
  if(t==='edit' && cur==='Room'){ go('Dialogs'); return; }
  if(t==='create in draft'){ toast(DONE[t]); setTimeout(()=>go('Flow'),700); return; }
  if(BYLABEL[l]){ go(BYLABEL[l]); return; }
  for(const [k,v] of BYTEXT){ if(t===k || t.startsWith(k+' ') || (k.length>5 && t.startsWith(k))){ if(v!==cur) { go(v); return; } break; } }
  if(DONE[t]){ toast(DONE[t]); return; }
  for(const k in DONE){ if(t.startsWith(k)){ toast(DONE[k]); return; } }
  if(el.matches('[aria-haspopup]') && t.includes('cubilot')){ toast('Rooms: # cubilot, # eu-space, # ardoise. The Room screen shows the list open.'); return; }
  toast('Prototype: “'+(el.textContent.replace(/\s+/g,' ').trim()||l||'control')+'” has no screen of its own.');
});
fromHash();
''' % (json.dumps(H), json.dumps(PH), json.dumps(LABEL))
html=f'''<title>Cubilot prototype</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500;600&amp;family=Fraunces:ital,wght@0,500;1,400&amp;display=swap">
<style>{css}</style>
<main id="stage" aria-live="off"></main>
<div id="pbar" role="toolbar" aria-label="Prototype controls"><span class="lab">PROTOTYPE</span><label for="pick" style="position:absolute;left:-9999px">Screen</label><select id="pick">{opts}</select><button id="thm" type="button" title="Switch dark or light">Dark</button><button id="dev" type="button" title="Switch desktop or phone">Desktop</button></div>
<div id="toast" role="status" hidden></div>
{templates}
<script>{js}</script>
'''
open('/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/proto/cubilot-prototype.html','w').write(html)
print(len(html))
