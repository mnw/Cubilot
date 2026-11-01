import re,sys
ICON=lambda d,l: f'<button aria-label="{l}" title="{l}" style="width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: 6px; background: none; color: var(--text-muted); cursor: pointer"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">{d}</svg></button>'
BTN='height: 30px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-raised); color: var(--text); cursor: pointer; font-size: 12.5px'
def header(room_open=False):
    caret='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-meta)" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>'
    dd=''
    if room_open:
        row=lambda n,b,cur=False: f'<a href="#" style="display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; border-radius: 6px; text-decoration: none; color: var(--text); {"background: var(--bg-elev);" if cur else ""}"><span style="font-family: var(--mono)"># {n}</span><span style="margin-left: auto; font-size: 11.5px; color: var(--text-meta)">{b}</span></a>'
        dd=('<div role="listbox" aria-label="Rooms" style="position: absolute; top: 36px; left: 0; z-index: 20; width: 280px; padding: 6px; border: 1px solid var(--line-hover); border-radius: 8px; background: var(--bg-raised); box-shadow: 0 12px 32px rgba(0,0,0,.45); display: flex; flex-direction: column; gap: 2px">'
            + row('cubilot','<span style="color: var(--orange-text)">1 decision</span> · 5 agents',True)
            + row('eu-space','2 agents · paused')
            + row('ardoise','no agents')
            + '<div style="height: 1px; background: var(--line-soft); margin: 4px 0"></div>'
            + '<a href="#" style="display: flex; align-items: center; height: 34px; padding: 0 10px; border-radius: 6px; text-decoration: none">+ New room</a></div>')
    room=f'<div style="position: relative"><button aria-haspopup="listbox" aria-expanded="{"true" if room_open else "false"}" style="{BTN}; font-family: var(--mono); min-width: 150px"><span style="color: var(--text-meta)">#</span>cubilot<span style="flex: 1"></span>{caret}</button>{dd}</div>'
    search='<button style="'+BTN+'; flex: 1; max-width: 420px; background: var(--bg-inset); color: var(--text-meta)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>Find a ticket, request or agent<span style="flex: 1"></span><kbd style="font-family: var(--mono); font-size: 11px; padding: 1px 6px; border: 1px solid var(--line); border-radius: 4px">⌘K</kbd></button>'
    lead=f'<div style="display: flex; align-items: center; gap: 8px"><span style="font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; color: var(--text-meta)">LEAD</span><button aria-haspopup="listbox" style="{BTN}"><span style="width: 7px; height: 7px; border-radius: 50%; background: var(--green)"></span>Orchestrator{caret}</button></div>'
    run=('<div role="group" aria-label="Room run state" style="display: flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden">'
         '<button style="height: 30px; padding: 0 10px; border: 0; background: var(--bg-raised); color: var(--text); cursor: pointer; font-size: 12.5px; display: inline-flex; align-items: center; gap: 6px"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14"></rect><rect x="14" y="5" width="4" height="14"></rect></svg>Pause room</button>'
         '<span aria-live="polite" style="height: 30px; padding: 0 10px; border-left: 1px solid var(--line); display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--green-strong)"><span style="width: 7px; height: 7px; border-radius: 50%; background: var(--green)"></span>running</span></div>')
    add=f'<button style="{BTN}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add agent</button>'
    icons=('<div style="display: flex; align-items: center; gap: 2px">'
        + ICON('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5M9 13h6M9 17h6"></path>','Room instructions')
        + ICON('<circle cx="6" cy="6" r="2.5"></circle><circle cx="18" cy="6" r="2.5"></circle><circle cx="12" cy="18" r="2.5"></circle><path d="M8 7.5 10.5 16M16 7.5 13.5 16M8.5 6h7"></path>','Factory map')
        + ICON('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>','Project folder')
        + ICON('<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path>','Settings')
        + '</div>')
    brand='<div style="display: flex; align-items: center; gap: 8px"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--orange)" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 3 7v10l9 5 9-5V7z"></path><path d="m3 7 9 5 9-5"></path><path d="M12 12v10"></path></svg><span style="font-family: var(--serif); font-weight: 500; font-size: 17px">Cubilot</span></div>'
    av='<button aria-label="Michel" style="width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--line); background: var(--bg-elev); color: var(--text); font-weight: 600; font-size: 12px; cursor: pointer">M</button>'
    return ('<header style="height: 52px; flex: none; position: relative; z-index: 10; display: flex; align-items: center; gap: 12px; padding: 0 16px 0 20px; border-bottom: 1px solid var(--line-soft); background: var(--bg)">'
        + brand + room + search + '<div style="flex: 1"></div>' + lead + run + add
        + '<span style="width: 1px; height: 20px; background: var(--line)"></span>' + icons + av + '</header>')
TABS=['Decisions','Requests','Flow','Dashboard','Room','Agents','Delivery']
def subbar(active,crumb):
    t=''.join(f'<a href="#" {"aria-current=\"page\"" if n==active else ""} style="height: 40px; display: inline-flex; align-items: center; padding: 0 12px; text-decoration: none; font-size: 12.5px; {"color: var(--text); box-shadow: inset 0 -2px 0 var(--orange); font-weight: 500" if n==active else "color: var(--text-muted)"}">{n}{" <span style=\"margin-left: 6px; padding: 0 6px; border-radius: 999px; background: var(--orange); color: #1a1714; font-family: var(--mono); font-size: 11px; font-weight: 600\">4</span>" if n=="Decisions" else ""}</a>' for n in TABS)
    return (f'<div style="height: 40px; flex: none; display: flex; align-items: center; padding: 0 12px 0 8px; border-bottom: 1px solid var(--line-soft); background: var(--bg)"><nav aria-label="Sections" style="display: flex">{t}</nav>'
        f'<nav aria-label="Breadcrumb" style="margin-left: auto; display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-meta)">{crumb}</nav></div>')
cfg={
 'Main':(None,None,False),
 'Request':('Requests','<a href="#" style="color: var(--text-muted); text-decoration: none">Requests</a><span>/</span><span style="font-family: var(--mono); color: var(--text)">human-touchpoints-checkpoint</span>',False),
 'Ticket':('Requests','<a href="Request.dc.html" style="color: var(--text-muted); text-decoration: none; font-family: var(--mono)">context-pack</a><span>/</span><span style="font-family: var(--mono); color: var(--text)">t_46fd9a1728df0fc2</span>',False),
 'Session':('Agents','<a href="#" style="color: var(--text-muted); text-decoration: none">Agents</a><span>/</span><span style="font-family: var(--mono); color: var(--text)">worker-1</span>',False),
 'Room':('Room','<span style="font-family: var(--mono); color: var(--text)"># cubilot</span>',True),
}
for f,(act,crumb,ro) in cfg.items():
    p=f+'.dc.html'; s=open(p).read()
    new=header(ro)+('' if act is None else subbar(act,crumb))
    s,n=re.subn(r'<header.*?</header>',lambda m:new,s,count=1,flags=re.S); assert n==1,f
    open(p,'w').write(s); print(f,'ok')
