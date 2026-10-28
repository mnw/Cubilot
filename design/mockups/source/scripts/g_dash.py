exec(open('/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/lib.py').read())
import re
TABS[:]=['Decisions','Requests','Flow','Dashboard','Room','Agents','Delivery']
# ---------- data (structure from openspec/changes/human-touchpoints-checkpoint/tasks.md; state = example)
M={1:('Decision Kind',4,'low'),2:('Request Kind, Approve rule',8,'high'),3:('Radius by rule',5,'high'),4:('High radius checks',6,'high'),5:('FAIL count, 3rd review',2,'high'),6:('Arbiter stage',5,'high'),7:('Rulings applied',5,'high'),8:('Delivery report',3,'low'),
   9:('Measure lead inbox',2,'low'),10:('Briefing skips stages',1,'low'),11:('Context % column',2,'low'),12:('Ticket-event digest',1,'low'),13:('Result summary',1,'low'),14:('State summary',1,'low'),15:('Checkpoint run',6,'high'),16:('Docs, role files',3,'low'),17:('Your live check',1,'low'),18:('Closing',3,'low')}
DONE={1:4,2:8,9:2,11:2,14:1,12:1,3:3}
STATE={1:'done',2:'done',9:'done',11:'done',14:'done',12:'done',3:'active',10:'review',13:'ready'}
POS={1:(0,0),2:(1,0),3:(2,0),4:(3,0),5:(4,0),6:(5,0),7:(6,0),8:(7,0),16:(8,0),17:(9,0),18:(10,0),14:(1,1),15:(3,1),13:(7,1),9:(0,2),12:(1,2),11:(0,3),10:(2,3)}
E=[(1,2),(2,3),(3,4),(4,5),(5,6),(6,7),(7,8),(8,16),(16,17),(17,18),(1,14),(14,15),(2,15),(3,15),(11,15),(15,16),(9,12),(12,13),(7,13),(13,16),(9,10),(10,16),(11,6)]
CW,RH,NW,NH,X0,Y0=124,96,112,76,8,10
def xy(n): c,r=POS[n]; return X0+c*CW, Y0+r*RH
svg_w=X0+11*CW; svg_h=Y0+4*RH
paths=''
for a,b in E:
    ax,ay=xy(a); bx,by=xy(b); x1,y1=ax+NW,ay+NH/2; x2,y2=bx,by+NH/2
    main = POS[a][1]==0 and POS[b][1]==0
    done = STATE.get(a)=='done'
    col='var(--green)' if done else ('var(--line-hover)')
    mx=(x1+x2)/2
    paths+=f'<path d="M{x1},{y1} C{mx},{y1} {mx},{y2} {x2},{y2}" fill="none" stroke="{col}" stroke-width="{2 if main else 1.5}" {"" if done else "stroke-dasharray=\"4 4\""} opacity="{1 if main else .8}"></path>'
nodes=''
SC={'done':('var(--green)','color-mix(in srgb, var(--green) 12%, var(--bg-raised))','✓ done'),'active':('var(--orange)','color-mix(in srgb, var(--orange) 12%, var(--bg-raised))','● building'),'review':('var(--purple)','color-mix(in srgb, var(--purple) 12%, var(--bg-raised))','◐ in review'),'ready':('var(--line-hover)','var(--bg-raised)','○ ready'),'todo':('var(--line)','var(--bg-inset)','· waits')}
for n,(name,tot,rad) in M.items():
    x,y=xy(n); st=STATE.get(n,'todo'); bc,bg,lab=SC[st]; d=DONE.get(n,0); w=int((NW-20)*d/tot)
    nodes+=(f'<a href="Request.dc.html" title="{n}. {name}: {d} of {tot} tasks, radius {rad}, {lab[2:]}" style="position: absolute; left: {x}px; top: {y}px; width: {NW}px; height: {NH}px; padding: 7px 9px; border: 1px solid {bc}; {"border-width: 2px;" if st=="active" else ""} border-radius: 6px; background: {bg}; color: var(--text); text-decoration: none; display: flex; flex-direction: column; gap: 3px">'
      f'<span style="display: flex; gap: 6px; align-items: center; font-size: 12px"><span style="font-family: var(--mono); font-weight: 600">{n}</span>{"<span style=\"color: var(--red-strong)\">high</span>" if rad=="high" else ""}<span style="margin-left: auto; font-family: var(--mono); color: var(--text-meta)">{d}/{tot}</span></span>'
      f'<span style="font-size: 12px; line-height: 1.25; height: 31px; overflow: hidden">{name}</span>'
      f'<span style="height: 4px; border-radius: 2px; background: var(--bg-elev); overflow: hidden"><span style="display: block; width: {w+ (0 if d<tot else 20)}px; max-width: 100%; height: 100%; background: {bc if st!="todo" else "var(--line)"}"></span></span></a>')
graph=(f'<div style="overflow-x: auto"><div style="position: relative; width: {svg_w}px; height: {svg_h}px">'
 f'<svg width="{svg_w}" height="{svg_h}" viewBox="0 0 {svg_w} {svg_h}" aria-hidden="true" style="position: absolute; inset: 0">{paths}</svg>{nodes}'
 f'<span style="position: absolute; left: {X0+11*CW-130}px; top: {Y0+RH+20}px; font-size: 12px; color: var(--text-meta); width: 120px">Main track on top; checkpoint track below. Arrows: “waits for”.</span>'
 '</div></div>')
legend=''.join(f'<span style="display: inline-flex; align-items: center; gap: 6px"><span style="width: 12px; height: 12px; border-radius: 3px; border: 1px solid {SC[k][0]}; background: {SC[k][1]}"></span>{SC[k][2]}</span>' for k in ['done','active','review','ready','todo'])
# ---------- roadmap of brief parts in build order
PARTS=[('1','Rebrand','done'),('2','Roles','done'),('3','Grouping','done'),('4','Sessions','done'),('6','Review patterns','now'),('12','Hub-first, browser','next'),('14','UI redesign','plan'),('5','Delivery, backup','plan'),('7','Toolchain','plan'),('8','Setup screen','plan'),('11','Dashboard','plan'),('13','Mutation','plan'),('9','A11y council','council'),('16','Design council','council'),('10','SEO council','council'),('17','Plan council','council')]
n=len(PARTS); RW=1340; step=(RW-100)/(n-1)
rsvg=f'<line x1="50" y1="34" x2="{50+step*3}" y2="34" stroke="var(--green)" stroke-width="3"></line><line x1="{50+step*3}" y1="34" x2="{50+step*4}" y2="34" stroke="var(--orange)" stroke-width="3"></line><line x1="{50+step*4}" y1="34" x2="{RW-50}" y2="34" stroke="var(--line-hover)" stroke-width="2" stroke-dasharray="5 5"></line>'
rnodes=''
for i,(num,name,st) in enumerate(PARTS):
    cx=50+step*i
    if st=='done': c=f'<circle cx="{cx}" cy="34" r="10" fill="var(--green)"></circle><path d="M{cx-4},34 l3,3 l6,-6" stroke="var(--bg)" stroke-width="2" fill="none"></path>'
    elif st=='now': c=f'<circle cx="{cx}" cy="34" r="13" fill="var(--bg)" stroke="var(--orange)" stroke-width="3"></circle><path d="M{cx},34 L{cx},21 A13,13 0 0 1 {cx+12.4},30 Z" fill="var(--orange)"></path>'
    elif st=='council': c=f'<rect x="{cx-8}" y="26" width="16" height="16" rx="3" fill="var(--bg)" stroke="var(--purple)" stroke-width="2"></rect>'
    else: c=f'<circle cx="{cx}" cy="34" r="8" fill="var(--bg)" stroke="{"var(--text-muted)" if st=="next" else "var(--line-hover)"}" stroke-width="2"></circle>'
    rnodes+=c+f'<text x="{cx}" y="12" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="12" fill="var(--text-meta)">{num}</text><text x="{cx}" y="{64 if i%2==0 else 82}" text-anchor="middle" font-family="Inter, sans-serif" font-size="12" fill="{"var(--text)" if st in ("now","done") else "var(--text-muted)"}" font-weight="{600 if st=="now" else 400}">{name}</text>'
roadmap=f'<div style="overflow-x: auto"><svg width="{RW}" height="92" viewBox="0 0 {RW} 92" role="img" aria-label="Brief parts in build order: 1 to 4 done, Part 6 in progress, then 12, 14, 5, 7, 8, 11, 13, then the councils 9, 16, 10, 17">{rsvg}{rnodes}</svg></div>'
# ---------- burn-up
days=['29 Oct','30','31','1 Nov','2','3','4','5','6']
done=[0,9,21]; proj=[21,31,41,51,59]
W,Hc,L,B,T,Rr=640,220,40,30,14,12
px=lambda i: L+i*(W-L-Rr)/(len(days)-1); py=lambda v: T+(Hc-T-B)*(1-v/60)
grid=''.join(f'<line x1="{L}" x2="{W-Rr}" y1="{py(v)}" y2="{py(v)}" stroke="var(--line-soft)"></line><text x="{L-8}" y="{py(v)+4}" text-anchor="end" font-size="12" font-family="JetBrains Mono, monospace" fill="var(--text-meta)">{v}</text>' for v in [0,20,40,60])
xl=''.join(f'<text x="{px(i)}" y="{Hc-8}" text-anchor="middle" font-size="12" font-family="Inter, sans-serif" fill="var(--text-meta)">{d}</text>' for i,d in enumerate(days) if i%2==0)
scope=f'<line x1="{L}" x2="{W-Rr}" y1="{py(59)}" y2="{py(59)}" stroke="var(--text-muted)" stroke-width="1.5" stroke-dasharray="2 4"></line><text x="{W-Rr}" y="{py(59)-6}" text-anchor="end" font-size="12" font-family="Inter, sans-serif" fill="var(--text-muted)">scope 59 tasks</text>'
dl=' '.join(f'{px(i)},{py(v)}' for i,v in enumerate(done))
area=f'<polygon points="{px(0)},{py(0)} {dl} {px(len(done)-1)},{py(0)}" fill="color-mix(in srgb, var(--orange) 16%, transparent)"></polygon>'
line=f'<polyline points="{dl}" fill="none" stroke="var(--orange)" stroke-width="2" stroke-linejoin="round"></polyline>'
pl=' '.join(f'{px(i+2)},{py(v)}' for i,v in enumerate(proj))
projl=f'<polyline points="{pl}" fill="none" stroke="var(--orange)" stroke-width="2" stroke-dasharray="5 5" opacity=".7"></polyline>'
pts=''.join(f'<circle cx="{px(i)}" cy="{py(v)}" r="4.5" fill="var(--orange)" stroke="var(--bg-raised)" stroke-width="2"><title>{days[i]}: {v} of 59 tasks done</title></circle>' for i,v in enumerate(done))
ms=''.join(f'<g><line x1="{px(i)}" x2="{px(i)}" y1="{py(0)}" y2="{py(v)}" stroke="var(--green)" stroke-width="1" opacity=".6"></line><text x="{px(i)+(8 if i==1 else -8)}" y="{py(v)+(18 if i==1 else -10)}" text-anchor="{"start" if i==1 else "end"}" font-size="12" font-family="Inter, sans-serif" fill="var(--text-muted)">{t}</text></g>' for i,v,t in [(1,9,'milestones 1, 9, 11 done'),(2,21,'2, 12, 14 done')])
endl=f'<text x="{px(6)+6}" y="{py(59)+18}" font-size="12" font-family="Inter, sans-serif" fill="var(--text)">projected 4 Nov</text><circle cx="{px(6)}" cy="{py(59)}" r="4" fill="var(--bg-raised)" stroke="var(--orange)" stroke-width="2"></circle>'
burn=f'<svg width="100%" viewBox="0 0 {W} {Hc}" role="img" aria-label="Burn-up: 0, 9, 21 of 59 tasks done on 29, 30, 31 Oct; projected to finish 4 Nov" style="max-width: {W}px">{grid}{scope}{area}{line}{projl}{ms}{pts}{endl}{xl}</svg>'
blegend=('<div style="display: flex; gap: 16px; font-size: 12px; color: var(--text-muted)"><span style="display: inline-flex; align-items: center; gap: 6px"><span style="width: 16px; height: 2px; background: var(--orange)"></span>tasks done</span>'
 '<span style="display: inline-flex; align-items: center; gap: 6px"><span style="width: 16px; border-top: 2px dashed var(--orange); opacity: .7"></span>projection at the current rate</span><span style="display: inline-flex; align-items: center; gap: 6px"><span style="width: 16px; border-top: 2px dotted var(--text-muted)"></span>scope</span></div>')
def tile(v,l,c='var(--text)'): return f'<div style="background: var(--bg-raised); padding: 12px 14px"><div style="font-family: var(--mono); font-size: 22px; color: {c}; font-variant-numeric: tabular-nums">{v}</div><div style="font-size: 12px; color: var(--text-meta)">{l}</div></div>'
tiles=f'<div style="display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 1px; background: var(--line-soft); border: 1px solid var(--line-soft); border-radius: 6px; overflow: hidden">{tile("6/18","milestones done","var(--green-strong)")}{tile("21/59","tasks done")}{tile("8","milestones left on the longest chain","var(--amber)")}{tile("4 Nov","projected finish")}</div>'
# ---------- small panels
def panel(title,inner,link=''):
    return f'<section style="{CARD}; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0"><div style="display: flex; align-items: baseline; gap: 8px"><h3 style="margin: 0; font-size: 14px; font-weight: 600">{title}</h3>{f"<a href=\"#\" style=\"margin-left: auto; font-size: 12px\">{link}</a>" if link else ""}</div>{inner}</section>'
kv=lambda a,b,c='var(--text)': f'<div style="display: flex; justify-content: space-between; gap: 8px; font-size: 14px"><span style="color: var(--text-muted)">{a}</span><span style="font-family: var(--mono); color: {c}; font-variant-numeric: tabular-nums">{b}</span></div>'
stuck=''.join(f'<a href="{h}" style="display: flex; gap: 8px; align-items: center; font-size: 14px; color: var(--text); text-decoration: none">{dot("amber")}<span style="flex: 1">{a}</span><span style="font-family: var(--mono); font-size: 12px; color: var(--amber)">{b}</span></a>' for a,b,h in [('validator · t_ebd5 no event','22 min','Agents.dc.html'),('handoff → worker-2 pending','34 min','RoomCards.dc.html')])
spark=lambda vals,c: '<svg width="120" height="28" viewBox="0 0 120 28" aria-hidden="true"><polyline points="'+' '.join(f'{i*120/(len(vals)-1)},{26-22*v/max(vals)}' for i,v in enumerate(vals))+f'" fill="none" stroke="{c}" stroke-width="2"></polyline><circle cx="120" cy="{26-22*vals[-1]/max(vals)}" r="3" fill="{c}"></circle></svg>'
pairs=''.join(f'<div style="display: grid; grid-template-columns: minmax(0,1fr) 60px 56px; gap: 8px; font-size: 12px"><span style="font-family: var(--mono); color: var(--text-muted)">{a}</span><span style="text-align: right; font-family: var(--mono)">{b}</span><span style="text-align: right; font-family: var(--mono); color: var(--text-meta)">{c}</span></div>' for a,b,c in [('opus · sonnet','71%','$0.92'),('sonnet · sonnet','58%','$0.41'),('sonnet · haiku','44%','$0.19')])
panels=('<div style="display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 12px">'
 + panel('Waiting for you',f'<a href="Main.dc.html" style="display: flex; align-items: baseline; gap: 8px; text-decoration: none; color: var(--text)"><span style="font-family: var(--mono); font-size: 28px; color: var(--orange-text)">4</span><span style="font-size: 14px; color: var(--text-muted)">decisions · oldest 2 h</span></a>','Open Decisions')
 + panel('Stuck',stuck+'<div style="font-size: 12px; color: var(--text-meta)">no event for 30 min (room setting)</div>')
 + panel('Flow',f'<div style="display: flex; align-items: center; justify-content: space-between">{spark([3,5,4,7,6,9,8],"var(--green)")}<span style="font-size: 12px; color: var(--text-muted)">done per day</span></div>'+kv('claim → done, median','1 h 52 m')+kv('slowest','t_46fd · 9 h','var(--amber)'))
 + panel('Quality',kv('first-time PASS','62%')+kv('FAIL loops, median','1')+kv('over the two-loop limit','1','var(--red-strong)')+kv('mutation score, median','74%'))
 + panel('Cost',kv('Claude plan, session','$159 · 3 h 41 m')+kv('weekly','0%')+kv('Pi agents today','$3.20')+kv('summaries (Part 3)','$0.40'))
 + panel('Agents',''.join(f'<div style="display: grid; grid-template-columns: 10px minmax(0,1fr) auto; gap: 8px; align-items: center; font-size: 12px">{dot(dc)}<span>{who(a)} <span style="color: var(--text-meta)">{b}</span></span><span style="font-family: var(--mono); color: var(--text-meta)">{c}</span></div>' for a,b,c,dc in [('worker-1','claude · opus','t_46fd','green'),('tester-1','claude · sonnet','t_dc9f','green'),('validator','pi · sonnet','stalled','amber'),('worker-2','pi · haiku','idle','line-hover')]),'Agents')
 + panel('Model pairs · Jev',f'<div style="display: grid; grid-template-columns: minmax(0,1fr) 60px 56px; gap: 8px; font-size: 12px; color: var(--text-meta)"><span>worker · validator</span><span style="text-align: right">1st PASS</span><span style="text-align: right">cost</span></div>{pairs}<div style="font-size: 12px; color: var(--text-meta)">Step A: 38 of 50 stages before Jev</div>')
 + panel('Queue and graphs',kv('stages waiting for a slot','2 · validator','var(--amber)')+'<button style="'+BTN2+'; height: 30px; align-self: flex-start">Add a validator slot</button>'+kv('graph · worktree t_46fd','current','var(--green-strong)')+kv('graph · staging','3 commits behind','var(--amber)'))
 + '</div>')
other=(f'<div style="display: flex; flex-direction: column; gap: 8px">'
 + ''.join(f'<a href="Request.dc.html" style="display: grid; grid-template-columns: minmax(0,1fr) 200px 90px; gap: 12px; align-items: center; padding: 10px 12px; {CARD}; text-decoration: none; color: var(--text)"><span><span style="display: block; font-size: 14px">{a}</span><span style="font-family: var(--mono); font-size: 12px; color: var(--text-meta)">{b}</span></span><span style="display: flex; gap: 2px">'+''.join(f'<span title="milestone {i+1}" style="flex: 1; height: 10px; border-radius: 2px; background: {cfun(i)}"></span>' for i in range(k))+f'</span><span style="text-align: right; font-size: 12px; color: var(--text-muted)">{s}</span></a>' for a,b,k,cfun,s in [
   ('Stage diagnosis','stage-diagnosis · 13 milestones · 63 tasks',13,lambda i:'var(--bg-elev)','plan, not approved'),
   ('Context pack','context-pack · archived 28 Oct',6,lambda i:'var(--green)','done')])
 + '<a href="#" style="font-size: 12px">22 archived changes since April</a></div>')
body=('<main style="flex: 1; min-width: 0; padding: 20px 24px 32px; display: flex; flex-direction: column; gap: 18px">'
 '<div style="display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap"><h1 style="margin: 0; font-size: 22px; font-weight: 600">Dashboard</h1><span style="font-size: 14px; color: var(--text-muted)"># cubilot · milestones from openspec/changes · updated live</span><span style="margin-left: auto; padding: 2px 8px; border: 1px dashed var(--line-hover); border-radius: 999px; font-size: 12px; color: var(--text-meta)">example state: day 3 of the Part 6 build</span></div>'
 f'<section style="{CARD}; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px"><div style="display: flex; align-items: baseline; gap: 10px"><h2 style="margin: 0; font-size: 18px; font-weight: 600">Roadmap</h2><span style="font-size: 12px; color: var(--text-meta)">brief parts in build order (00-index.md) · 4 done · Part 6 building · councils last</span></div>{roadmap}</section>'
 f'<section style="{CARD}; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px"><div style="display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap"><h2 style="margin: 0; font-size: 18px; font-weight: 600">Part 6 · human-touchpoints-checkpoint</h2><span style="font-size: 12px; color: var(--text-meta)">18 milestones = the sections of tasks.md · click one for its tickets</span><span style="margin-left: auto; display: flex; gap: 14px; font-size: 12px; color: var(--text-muted)">{legend}</span></div>{graph}'
 f'<div style="display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 20px; align-items: start; padding-top: 6px; border-top: 1px solid var(--line-soft)"><div style="display: flex; flex-direction: column; gap: 8px; min-width: 0"><div style="font-size: 14px; font-weight: 600">Burn-up</div>{blegend}{burn}</div>{tiles}</div></section>'
 f'<section style="display: flex; flex-direction: column; gap: 8px"><h2 style="margin: 0; font-size: 18px; font-weight: 600">Other changes</h2>{other}</section>'
 f'<section style="display: flex; flex-direction: column; gap: 8px"><h2 style="margin: 0; font-size: 18px; font-weight: 600">Factory health</h2>{panels}</section>'
 '</main>')
open(P+'Dashboard.dc.html','w').write(desk('Dashboard',1900,'Dashboard','<span style="color: var(--text)">Dashboard</span>',body))
# ---------- phone
plist=''.join(f'<div style="display: grid; grid-template-columns: 26px minmax(0,1fr) 44px; gap: 8px; align-items: center; padding: 8px 12px; {"border-top: 1px solid var(--line-soft);" if i else ""}"><span style="font-family: var(--mono); font-size: 12px; color: var(--text-meta)">{n}</span><span style="min-width: 0"><span style="display: block; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{M[n][0]}</span><span style="display: block; height: 4px; margin-top: 4px; border-radius: 2px; background: var(--bg-elev)"><span style="display: block; width: {int(100*DONE.get(n,0)/M[n][1])}%; height: 100%; border-radius: 2px; background: {SC[STATE.get(n,"todo")][0]}"></span></span></span><span style="text-align: right; font-family: var(--mono); font-size: 12px; color: var(--text-meta)">{DONE.get(n,0)}/{M[n][1]}</span></div>' for i,n in enumerate([1,2,3,4,5,6,7,8,9,10]))
proad=''.join(f'<span title="Part {a}: {b}" style="flex: 1; height: 10px; border-radius: 2px; background: {"var(--green)" if s=="done" else "var(--orange)" if s=="now" else "var(--bg-elev)"}"></span>' for a,b,s in PARTS)
pb=(phdr('Dashboard','# cubilot · example state',False)+
 '<div style="flex: 1; overflow: auto; padding: 14px 16px; display: grid; align-content: start; gap: 14px">'
 f'<div style="{CARD}; padding: 12px; display: flex; flex-direction: column; gap: 8px"><div style="display: flex; justify-content: space-between; font-size: 14px"><span style="font-weight: 600">Roadmap</span><span style="color: var(--text-meta); font-size: 12px">4 of 16 parts · Part 6 now</span></div><div style="display: flex; gap: 2px">{proad}</div></div>'
 f'<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--line-soft); border: 1px solid var(--line-soft); border-radius: 6px; overflow: hidden">{tile("6/18","milestones","var(--green-strong)")}{tile("4 Nov","projected")}</div>'
 f'<div style="{SEC}">Part 6 milestones</div><div style="{CARD}; overflow: hidden">{plist}<a href="#" style="display: block; padding: 10px 12px; border-top: 1px solid var(--line-soft); font-size: 14px">Show all 18 and the burn-up</a></div>'
 f'<a href="DecisionsPhone.dc.html" style="{CARD}; display: flex; justify-content: space-between; align-items: center; min-height: 52px; padding: 0 14px; color: var(--text); text-decoration: none"><span>Waiting for you</span><span style="font-family: var(--mono); color: var(--orange-text)">4 ›</span></a>'
 f'<div style="{CARD}; display: flex; justify-content: space-between; align-items: center; min-height: 52px; padding: 0 14px"><span>Stuck</span><span style="font-family: var(--mono); color: var(--amber)">2 ›</span></div>'
 '</div>'+pnav('More'))
open(P+'DashboardPhone.dc.html','w').write(phone('Dashboard on a phone',pb))
print('ok')
