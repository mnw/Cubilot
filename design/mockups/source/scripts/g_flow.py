exec(open('/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/lib.py').read())
LIGHT={'red':('var(--red)','waits for you'),'orange':('var(--orange)','an agent works on it'),'green':('var(--green)','no one works on it')}
def tlight(l):
    if not l: return ''
    return '<span role="img" aria-label="Light: '+LIGHT[l][1]+'" title="'+LIGHT[l][1]+'" style="display: inline-flex; gap: 2px; padding: 2px 3px; border-radius: 999px; background: var(--bg-inset)">'+''.join('<span style="width: 6px; height: 6px; border-radius: 50%; background: '+(LIGHT[k][0] if k==l else 'var(--line-hover)')+'"></span>' for k in ['red','orange','green'])+'</span>'
def tcard(id,title,radius,prio,who_,extra='',hl=False,menu='',light=''):
    pc={'highest':'var(--red-strong)','high':'var(--red-strong)','medium':'var(--amber)','low':'var(--text-muted)','lowest':'var(--text-meta)'}[prio]
    arrows={'highest':'⇈','high':'↑','medium':'=','low':'↓','lowest':'⇊'}[prio]
    return (f'<article style="position: relative; {CARD}; {"border-color: var(--line-hover);" if hl else ""} padding: 10px 12px; display: flex; flex-direction: column; gap: 6px">'
      f'<div style="display: flex; align-items: center; gap: 6px; font-size: 12px"><a href="Ticket.dc.html" style="font-family: var(--mono); color: var(--text-meta); text-decoration: none">{id}</a>'
      f'<span title="Priority {prio}" style="color: {pc}; font-family: var(--mono)">{arrows}</span>'
      + (pill('high','padding: 0 6px; '+PR['high']) if radius=='high' else '') +
      tlight(light)+f'<button aria-label="Move {id} to column" style="margin-left: auto; width: 24px; height: 24px; border: 0; border-radius: 4px; background: none; color: var(--text-muted); cursor: pointer">⋯</button></div>'
      f'<a href="Ticket.dc.html" style="color: var(--text); text-decoration: none; font-size: 14px; line-height: 1.4">{title}</a>'
      f'<div style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-meta)">{who_}{extra}</div>{menu}</article>')
mv=(f'<div role="menu" aria-label="Move to" style="position: absolute; top: 34px; right: 8px; z-index: 15; width: 200px; padding: 6px; {POP}; display: flex; flex-direction: column; gap: 2px; font-size: 14px">'
    '<div style="padding: 4px 8px; font-size: 12px; color: var(--text-meta)">Move to</div>'
    + ''.join(f'<button role="menuitem" style="height: 32px; text-align: left; padding: 0 8px; border: 0; border-radius: 4px; background: {"var(--bg-elev)" if n=="Draft" else "none"}; color: var(--text); cursor: pointer">{n}</button>' for n in ['Draft','Queued','In review','Done']) +
    '<div style="height: 1px; background: var(--line-soft); margin: 4px 0"></div>'
    '<button role="menuitem" style="height: 32px; text-align: left; padding: 0 8px; border: 0; border-radius: 4px; background: none; color: var(--text); cursor: pointer">Assign to…</button>'
    '<button role="menuitem" style="height: 32px; text-align: left; padding: 0 8px; border: 0; border-radius: 4px; background: none; color: var(--text); cursor: pointer">Copy ticket id</button>'
    '<button role="menuitem" style="height: 32px; text-align: left; padding: 0 8px; border: 0; border-radius: 4px; background: none; color: var(--text); cursor: pointer">Archive</button>'
    '<button role="menuitem" style="height: 32px; text-align: left; padding: 0 8px; border: 0; border-radius: 4px; background: none; color: var(--red-strong); cursor: pointer">Cancel ticket…</button></div>')
cols=[('Draft',3,[('t_9b68','Agent column shows context %','low','medium','<span>origin: you</span>','',False,'','green'),('t_e21c','Delivery report lists rulings','high','high','<span>needs your Approve</span>','',False,'','red')]),
 ('Queued',4,[('t_5e7a','Stage metrics in the delivery report','low','medium','<span>waits for t_46fd</span>','',False,'','green'),('t_abf6','Room fix: spec reviews','low','low','<span>start now</span>','',True,mv,'green')]),
 ('In progress',2,[('t_46fd','context-pack 5.1–5.4: stage metrics writer','high','highest',who('worker-1'),' <span>· rework 5 · 6 min</span>',False,'','red'),('t_dc9f','Full suite run for install 29','low','medium',who('tester-1'),' <span>· 14 min</span>',False,'','orange')]),
 ('In review',1,[('t_ebd5','Spec review: human-touchpoints','low','high',who('validator'),' <span style="color: var(--amber)">· stalled 22 min</span>',False,'','orange')]),
 ('Done',544,[('t_3186','Hub restart keeps sessions','low','medium','<span>merged · install 28</span>','',False,'',''),('t_cc25','Spec reviews take the ticket room','high','high','<span>merged · install 28</span>','',False,'','')])]
colhtml=''
for name,n,cards in cols:
    colhtml+=(f'<section aria-label="{name}" style="flex: 1 1 0; min-width: 220px; display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 8px; background: var(--bg-inset)">'
      f'<div style="display: flex; align-items: center; gap: 8px"><h2 style="margin: 0; font-size: 14px; font-weight: 600">{name}</h2><span style="font-family: var(--mono); font-size: 12px; color: var(--text-meta)">{n}</span>'
      f'<button aria-label="New ticket in {name}" title="New ticket in {name}" style="margin-left: auto; width: 28px; height: 28px; border: 1px solid var(--line); border-radius: 6px; background: none; color: var(--text-muted); cursor: pointer">+</button></div>'
      + ''.join(tcard(*c) for c in cards) +
      (f'<div style="display: flex; justify-content: space-between"><a href="#" style="font-size: 12px; padding: 4px 2px">Show all {n}</a><button style="border: 0; background: none; color: var(--text-muted); font-size: 12px; cursor: pointer">Archive all done</button></div>' if n>10 else '') + '</section>')
flt=(f'<div role="dialog" aria-label="Filter tickets" style="position: absolute; top: 46px; right: 0; z-index: 15; width: 340px; padding: 16px; {POP}; display: flex; flex-direction: column; gap: 14px">'
  '<div style="font-weight: 600">Filter tickets</div>'
  + field('Ticket id',inp('','e.g. a5e0 or t_a5e0',True))
  + field('Radius','<div role="group" style="display: flex; border: 1px solid var(--line-hover); border-radius: 6px; overflow: hidden">'+''.join(f'<button aria-pressed="{"true" if i==0 else "false"}" style="flex: 1; height: 32px; border: 0; {"border-left: 1px solid var(--line-hover);" if i else ""} background: {"var(--bg-elev)" if i==0 else "none"}; color: var(--text); cursor: pointer">{x}</button>' for i,x in enumerate(['All','High','Low']))+'</div>')
  + field('Request',sel('human-touchpoints-checkpoint',True))
  + field('Priority','<div style="display: flex; gap: 6px; flex-wrap: wrap">'+''.join(f'<button aria-pressed="{"true" if x in ("Highest","High") else "false"}" style="height: 30px; padding: 0 10px; border: 1px solid var(--line-hover); border-radius: 999px; background: {"var(--bg-elev)" if x in ("Highest","High") else "none"}; color: var(--text); cursor: pointer; font-size: 12px">{x}</button>' for x in ['Highest','High','Medium','Low','Lowest'])+'</div>')
  + toggle(False,'Show archived') + toggle(True,'Show cancelled','3 cancelled this week')
  + f'<div style="display: flex; justify-content: space-between"><button style="{BTN2}">Reset</button><button style="{BTNP}">Done</button></div></div>')
body=('<main style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 16px; padding: 20px 24px 24px">'
 '<div style="position: relative; display: flex; align-items: center; gap: 12px; flex-wrap: wrap">'
 '<h1 style="margin: 0; font-size: 22px; font-weight: 600">Flow</h1>'
 '<span style="font-size: 14px; color: var(--text-muted)">10 open · slots: workers 1/2 · testers 1/2 · validators 1/2</span>'
 '<span style="font-size: 14px; color: var(--amber)">1 stall</span><span style="flex: 1"></span>'
 '<span style="display: inline-flex; gap: 6px">'+pill('Priority: highest, high','background: var(--bg-elev); color: var(--text)')+pill('Show cancelled','background: var(--bg-elev); color: var(--text)')+'</span>'
 f'<button aria-expanded="true" style="{BTN2}; background: var(--bg-elev)">Filters · 2</button>'
 f'<button style="{BTNP}">+ New ticket</button>'+flt+'</div>'
 f'<div style="flex: 1; display: flex; gap: 12px; align-items: flex-start">{colhtml}</div>'
 '<div style="display: flex; gap: 20px; font-size: 12px; color: var(--text-meta)"><span>Light: red waits for you · orange an agent works · green no one works</span><span>Drag a card to move it, or use ⋯ · Move to</span><a href="#">Stage metrics for this room</a><a href="#">Cancel traces (2)</a></div>'
 '</main>')
open(P+'Flow.dc.html','w').write(desk('Flow',1000,'Flow','<span style="font-family: var(--mono); color: var(--text)"># cubilot</span>',body))
# phone flow: column tabs + list
tabs=''.join(f'<button aria-pressed="{"true" if n=="In progress" else "false"}" style="flex: none; height: 36px; padding: 0 12px; border: 1px solid var(--line-hover); border-radius: 999px; background: {"var(--bg-elev)" if n=="In progress" else "none"}; color: var(--text); font-size: 14px">{n} <span style="font-family: var(--mono); color: var(--text-meta)">{c}</span></button>' for n,c in [('Draft',3),('Queued',4),('In progress',2),('In review',1),('Done',544)])
pc=''.join(f'<a href="TicketPhone.dc.html" style="{CARD}; padding: 12px; display: flex; flex-direction: column; gap: 6px; text-decoration: none; color: var(--text)"><div style="display: flex; gap: 8px; align-items: center; font-size: 12px"><span style="font-family: var(--mono); color: var(--text-meta)">{i}</span>{r}</div><div style="font-size: 16px; line-height: 1.35">{t}</div><div style="font-size: 12px; color: var(--text-meta)">{w}</div></a>' for i,t,r,w in [('t_46fd','context-pack 5.1–5.4: stage metrics writer',pill('high','padding: 0 6px; '+PR['high']),who('worker-1')+' · rework 5 · 6 min'),('t_dc9f','Full suite run for install 29','',who('tester-1')+' · 14 min')])
pb=(phdr('Flow','10 open · 1 stall',False,'<button aria-label="Filters" style="width: 44px; height: 44px; display: grid; place-items: center; border: 0; background: none; color: var(--text-muted)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4-2v-4z"></path></svg></button>')+
 f'<div style="flex: none; display: flex; gap: 6px; padding: 10px 16px; overflow: hidden">{tabs}</div>'
 f'<div style="flex: 1; overflow: auto; padding: 4px 16px 16px; display: flex; flex-direction: column; gap: 10px">{pc}<div style="font-size: 12px; color: var(--text-meta)">Long-press a card to move, assign or archive it.</div></div>'
 '<button aria-label="New ticket" style="position: absolute; right: 16px; bottom: 74px; height: 48px; padding: 0 18px; border: 0; border-radius: 999px; background: var(--orange); color: #1a1714; font-weight: 600; font-size: 16px; box-shadow: 0 6px 18px rgba(0,0,0,.35)">+ New ticket</button>'
 + pnav('Flow'))
open(P+'FlowPhone.dc.html','w').write(phone('Flow on a phone',pb))
print('flow ok')
