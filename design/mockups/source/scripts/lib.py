import re
P='/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/canvas/project/'
exec(open('/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/hdr.py').read().split("cfg={")[0])
_t=open(P+'Ticket.dc.html').read()
HEAD=_t[:_t.index('</helmet>')+9].replace('code{font-family:var(--mono);color:var(--code-text);font-size: 12px}','code{font-family:var(--mono);color:var(--code-text);font-size: 12px}\ntextarea,input,select{font:inherit}')
_f=_t.index('<footer'); FOOT=_t[_f:_t.index('</footer>',_f)+9]
_p=open(P+'RoomPhone.dc.html').read()
PHEAD=_p[:_p.index('</helmet>')+9]
def tail(w,h): return '</x-dc>\n<script type="text/x-dc" data-dc-script data-props=\'{"$preview":{"width":%d,"height":%d}}\'>\nclass Component extends DCLogic {\nrenderVals() { return {}; }\n}\n</script>\n</body>\n</html>\n'%(w,h)
def fix_sizes(s):
    # normalise header/subbar sizes to the scale
    return re.sub(r'font-size: *12\.5px','font-size: 14px',re.sub(r'font-size: *(10\.5|11|11\.5)px','font-size: 12px',s))
def desk(title,h,active,crumb,body,room_open=False,extra_header=''):
    hd=fix_sizes(header(room_open)).replace('Find a ticket, request or agent<span','<span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0">Find a ticket, request or agent</span><span'); 
    if extra_header: hd=hd.replace('</header>',extra_header+'</header>')
    sb=fix_sizes(subbar(active,crumb))
    return (HEAD.replace('Cubilot · Ticket t_46fd','Cubilot · '+title)+
      f'\n<div style="min-height: {h}px; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; line-height: 1.5; position: relative">\n'
      +hd+sb+'\n<div style="flex: 1; display: flex; min-height: 0">\n'+body+'\n</div>\n'+FOOT+'\n</div>\n'+tail(1440,h))
# phone
caret='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-meta)" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>'
def roomchip(): return f'<button aria-haspopup="listbox" style="height: 32px; display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-raised); color: var(--text); font-family: var(--mono); font-size: 12px"><span style="color: var(--text-meta)">#</span>cubilot{caret}</button>'
back='<a href="#" aria-label="Back" style="width: 44px; height: 44px; margin-left: -12px; display: grid; place-items: center; color: var(--text-muted)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg></a>'
def phdr(title,sub,with_back=True,extra=''):
    return (f'<header style="flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 16px; min-height: 56px; border-bottom: 1px solid var(--line-soft)">'+(back if with_back else '')+
      f'<div style="flex: 1; min-width: 0"><div style="font-weight: 600; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{title}</div><div style="font-family: var(--mono); font-size: 12px; color: var(--text-meta); white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{sub}</div></div>'+extra+roomchip()+'</header>')
navitems=[('Decisions','<path d="M4 12h4l2 3h4l2-3h4"></path><path d="M5.5 5.5 4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6l-1.5-6.5A2 2 0 0 0 16.6 4H7.4a2 2 0 0 0-1.9 1.5z"></path>'),('Flow','<path d="M3 6h6v12H3zM10 6h4v8h-4zM15 6h6v5h-6z"></path>'),('Room','<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.7A8 8 0 1 1 21 12z"></path>'),('Agents','<circle cx="12" cy="8" r="3"></circle><path d="M5 20a7 7 0 0 1 14 0"></path>'),('More','<circle cx="5" cy="12" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><circle cx="19" cy="12" r="1.5"></circle>')]
def pnav(active):
    out='<nav aria-label="Sections" style="flex: none; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border-top: 1px solid var(--line-soft); background: var(--bg-inset)">'
    for n,d in navitems:
        a=n==active
        badge='<span style="position: absolute; top: 6px; left: 50%; margin-left: 6px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--orange); color: #1a1714; font-family: var(--mono); font-size: 12px; font-weight: 600; display: grid; place-items: center">4</span>' if n=='Decisions' else ''
        out+=f'<a href="#" {"aria-current=\"page\"" if a else ""} style="position: relative; height: 58px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; color: {"var(--orange-text)" if a else "var(--text-muted)"}; text-decoration: none; font-size: 12px; {"font-weight: 600" if a else ""}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">{d}</svg>{n}{badge}</a>'
    return out+'</nav>'
def phone(title,body):
    return PHEAD.replace('Cubilot · Room on a phone','Cubilot · '+title)+'\n<div style="width: 390px; height: 844px; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 16px; line-height: 1.45; overflow: hidden; position: relative">\n'+body+'\n</div>\n'+tail(390,844)
# shared bits
SEC='font-family: var(--mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-meta)'
CARD='border: 1px solid var(--line); border-radius: 6px; background: var(--bg-raised)'
BTN2='white-space: nowrap; height: 34px; display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; border: 1px solid var(--line-hover); border-radius: 6px; background: none; color: var(--text); cursor: pointer; font-size: 14px'
BTNP='white-space: nowrap; height: 34px; display: inline-flex; align-items: center; gap: 6px; padding: 0 14px; border: 0; border-radius: 6px; background: var(--orange); color: #1a1714; font-weight: 600; cursor: pointer; font-size: 14px'
BTND='white-space: nowrap; height: 34px; display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; border: 1px solid color-mix(in srgb, var(--red-strong) 45%, transparent); border-radius: 6px; background: none; color: var(--red-strong); cursor: pointer; font-size: 14px'
INP='height: 36px; width: 100%; padding: 0 10px; border: 1px solid var(--line-hover); border-radius: 6px; background: var(--bg-inset); color: var(--text); font-size: 14px'
POP='border: 1px solid var(--line-hover); border-radius: 8px; background: var(--bg-raised); box-shadow: 0 12px 32px rgba(0,0,0,.45)'
def pill(t,st): return f'<span style="padding: 2px 8px; border-radius: 999px; font-size: 12px; white-space: nowrap; {st}">{t}</span>'
PR={'high':'border: 1px solid color-mix(in srgb, var(--red-strong) 45%, transparent); color: var(--red-strong)','low':'border: 1px solid var(--line-hover); color: var(--text-muted)'}
def field(label,ctrl,hint=''): return f'<label style="display: flex; flex-direction: column; gap: 4px"><span style="font-size: 12px; color: var(--text-meta)">{label}</span>{ctrl}{f"<span style=\"font-size: 12px; color: var(--text-meta)\">{hint}</span>" if hint else ""}</label>'
def sel(v,mono=False): return f'<button type="button" style="{INP}; display: flex; align-items: center; justify-content: space-between; cursor: pointer; text-align: left; {"font-family: var(--mono);" if mono else ""}"><span>{v}</span>{caret}</button>'
def inp(v,ph='',mono=False): return f'<input value="{v}" placeholder="{ph}" style="{INP}; {"font-family: var(--mono);" if mono else ""}">'
def toggle(on,label,sub=''):
    bg='var(--orange)' if on else 'var(--bg-elev)'; kx='16px' if on else '2px'; kc='#1a1714' if on else 'var(--text-meta)'
    return (f'<label style="display: grid; grid-template-columns: 34px minmax(0,1fr); gap: 10px; align-items: start"><span role="switch" aria-checked="{"true" if on else "false"}" style="width: 34px; height: 20px; border-radius: 999px; background: {bg}; border: 1px solid var(--line-hover); position: relative; margin-top: 1px"><span style="position: absolute; top: 2px; left: {kx}; width: 14px; height: 14px; border-radius: 50%; background: {kc}"></span></span>'
            f'<span><span style="display: block; font-size: 14px">{label}</span>{f"<span style=\"display: block; font-size: 12px; color: var(--text-meta)\">{sub}</span>" if sub else ""}</span></label>')
def dot(c): return f'<span style="width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--{c})"></span>'
ROLEC={'orchestrator':'orange','worker-1':'amber','worker-2':'amber','tester-1':'teal','validator':'purple','validator-1':'purple','validator-2':'purple'}
def who(n): return f'<span style="font-family: var(--mono); color: var(--{ROLEC.get(n,"blue")})">{n}</span>'
