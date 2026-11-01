exec(open('/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/lib.py').read())
MI='height: 32px; display: flex; align-items: center; gap: 8px; width: 100%; padding: 0 10px; border: 0; border-radius: 4px; background: none; color: var(--text); cursor: pointer; text-align: left; font-size: 14px'
menu=(f'<div role="menu" aria-label="worker-1 actions" style="position: absolute; left: 200px; top: 58px; z-index: 15; width: 280px; padding: 6px; {POP}">'
 f'<button role="menuitem" style="{MI}">Reload status<span style="margin-left: auto; font-size: 12px; color: var(--text-meta)">read again</span></button>'
 f'<button role="menuitem" style="{MI}">Relaunch to apply<span style="margin-left: auto; font-size: 12px; color: var(--amber)">2 changes</span></button>'
 f'<button role="menuitem" style="{MI}">Pause this agent</button>'
 f'<button role="menuitem" style="{MI}">Open editor at this agent</button>'
 f'<button role="menuitem" aria-expanded="true" style="{MI}; background: var(--bg-elev)">MCP servers<span style="margin-left: auto; font-size: 12px; color: var(--text-meta)">3 of 5 on ›</span></button>'
 f'<button role="menuitem" style="{MI}">Skills folder</button>'
 '<div style="height: 1px; background: var(--line-soft); margin: 4px 0"></div>'
 f'<button role="menuitem" style="{MI}; color: var(--red-strong)">Kill session…</button>'
 f'<button role="menuitem" style="{MI}; color: var(--red-strong)">Remove agent…</button></div>'
 f'<div role="menu" aria-label="MCP servers for worker-1" style="position: absolute; left: 488px; top: 196px; z-index: 15; width: 260px; padding: 10px; {POP}; display: flex; flex-direction: column; gap: 10px">'
 + toggle(True,'cubilot-hub') + toggle(True,'context7') + toggle(True,'playwright') + toggle(False,'gemini-cli') + toggle(False,'mysql')
 + f'<button style="{BTN2}; height: 30px">Turn all on</button><div style="font-size: 12px; color: var(--amber)">Relaunch worker-1 to apply</div></div>')
def srow(n,sub,c,pct,cur=False,dotc='green'):
    return (f'<div style="display: grid; grid-template-columns: 10px minmax(0,1fr) auto 24px; gap: 8px; align-items: center; padding: 8px; border-radius: 6px; {"background: var(--bg-elev);" if cur else ""}">{dot(dotc)}'
            f'<span><span style="display: block; font-family: var(--mono); color: var(--{c})">{n}</span><span style="display: block; font-size: 12px; color: var(--text-muted)">{sub}</span></span>'
            f'<span style="font-family: var(--mono); font-size: 12px; color: var(--text-meta)">{pct}</span><button aria-label="{n} actions" aria-expanded="{"true" if cur else "false"}" style="width: 24px; height: 24px; border: 0; border-radius: 4px; background: {"var(--bg-hover)" if cur else "none"}; color: var(--text-muted); cursor: pointer">⋯</button></div>')
left=('<nav aria-label="Sessions" style="position: relative; width: 260px; flex: none; border-right: 1px solid var(--line-soft); background: var(--bg-inset); padding: 16px 10px; display: flex; flex-direction: column; gap: 4px">'
 f'<div style="{SEC}; padding: 0 8px 6px">Live · 5</div>'
 + srow('worker-1','t_46fd · rework 5','amber','38%',True) + srow('tester-1','t_dc9f · full suite','teal','12%')
 + srow('validator','stalled 22 min','purple','71%',dotc='amber') + srow('orchestrator','lead · # cubilot','orange','54%')
 + srow('worker-2','idle','text-muted','',dotc='line-hover')
 + f'<div style="{SEC}; padding: 14px 8px 6px; display: flex"><span>Finished</span><span style="margin-left: auto">544</span></div>'
 + ''.join(f'<a href="#" style="display: flex; justify-content: space-between; padding: 6px 8px; font-size: 12px; color: var(--text-muted); text-decoration: none"><span style="font-family: var(--mono)">{a}</span><span>{b}</span></a>' for a,b in [('validator · t_3186','PASS · 18:40'),('worker-1 · t_cc25','done · 17:55'),('tester-1 · t_cc25','2231/0 · 17:20')])
 + '<a href="#" style="padding: 4px 8px; font-size: 12px">All finished sessions</a>' + menu + '</nav>')
tabs=('<div role="tablist" style="flex: none; display: flex; align-items: flex-end; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--line-soft); background: var(--bg-inset)">'
 + ''.join(f'<button role="tab" aria-selected="{"true" if a else "false"}" style="height: 36px; display: inline-flex; align-items: center; gap: 8px; padding: 0 12px; border: 0; border-radius: 6px 6px 0 0; background: {"#0f0d0b" if a else "none"}; color: {"var(--text)" if a else "var(--text-muted)"}; cursor: pointer; font-family: var(--mono); font-size: 12px; {"box-shadow: inset 0 2px 0 var(--orange);" if a else ""}">{l}</button>' for l,a in [(who('worker-1'),False),(who('tester-1'),False),('Shell · your scratch shell',True)])
 + '<button aria-label="Launch agent" style="height: 30px; width: 30px; margin-bottom: 3px; border: 0; background: none; color: var(--text-muted); cursor: pointer">+</button></div>')
term=('<pre role="log" aria-label="Shell" style="flex: 1; margin: 0; padding: 14px 16px; background: #0f0d0b; font-family: var(--mono); font-size: 13px; line-height: 1.55; color: #d8cfc3; white-space: pre-wrap">'
 '<span style="color: var(--text-meta)">Your scratch shell — cross-room, cross-project. Not an agent.</span>\n\n'
 '<span style="color: var(--green-strong)">michel@mac</span> ~/Workspace/cubilot (staging) $ git log --oneline -3\n'
 'a0a89b1 docs(openspec): human-touchpoints-checkpoint\n5283321 install 28\n736040b FAIL gate t_65a8\n\n'
 '<span style="color: var(--green-strong)">michel@mac</span> ~/Workspace/cubilot (staging) $ <span style="background: #d8cfc3; color: #0f0d0b"> </span></pre>')
models=''.join(f'<button aria-pressed="{"true" if i==1 else "false"}" style="height: 52px; padding: 6px 10px; border: 1px solid {"var(--orange)" if i==1 else "var(--line-hover)"}; border-radius: 6px; background: {"color-mix(in srgb, var(--orange) 10%, transparent)" if i==1 else "none"}; color: var(--text); cursor: pointer; text-align: left"><span style="display: block; font-size: 14px">{m}</span><span style="display: block; font-size: 12px; color: var(--text-meta)">{d}</span></button>' for i,(m,d) in enumerate([('Fable 5.1','default'),('Opus 5.5','hard tasks'),('Sonnet 5.5','balanced'),('Haiku 5.5','fast')]))
form=('<aside role="dialog" aria-label="Launch an agent" style="width: 420px; flex: none; border-left: 1px solid var(--line-hover); background: var(--bg-raised); padding: 20px; display: flex; flex-direction: column; gap: 14px">'
 '<div style="display: flex; align-items: center"><h2 style="margin: 0; font-size: 18px; font-weight: 600">Launch an agent</h2><button aria-label="Close" style="margin-left: auto; width: 32px; height: 32px; border: 0; background: none; color: var(--text-muted); font-size: 18px; cursor: pointer">×</button></div>'
 + '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">' + field('Name',inp('worker-3','alice',True)) + field('Role',sel('worker'),'or: No role (your own skills)') + '</div>'
 + field('Runs on','<div role="group" style="display: flex; border: 1px solid var(--line-hover); border-radius: 6px; overflow: hidden"><button aria-pressed="true" style="flex: 1; height: 36px; border: 0; background: var(--bg-elev); color: var(--text); cursor: pointer; font-weight: 600">Claude</button><button aria-pressed="false" style="flex: 1; height: 36px; border: 0; border-left: 1px solid var(--line-hover); background: none; color: var(--text); cursor: pointer">Pi</button></div>')
 + field('Model',inp('','type to filter models')+f'<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 6px">{models}</div>')
 + field('Folder','<div style="display: flex; gap: 6px">'+inp('~/Workspace/cubilot','',True)+f'<button style="{BTN2}; height: 36px">Pick…</button></div>')
 + field('Room','<div style="display: flex; gap: 6px">'+inp('cubilot','defaults to git-root basename',True)+f'<button aria-label="Pick from existing rooms" style="{BTN2}; height: 36px">{caret}</button></div>')
 + field('Session','<div role="group" style="display: flex; border: 1px solid var(--line-hover); border-radius: 6px; overflow: hidden">'+''.join(f'<button aria-pressed="{"true" if i==0 else "false"}" style="flex: 1; height: 36px; border: 0; {"border-left: 1px solid var(--line-hover);" if i else ""} background: {"var(--bg-elev)" if i==0 else "none"}; color: var(--text); cursor: pointer; font-size: 14px">{x}</button>' for i,x in enumerate(['New','Continue last','Resume…']))+'</div>')
 + '<div style="font-size: 12px; color: var(--amber)">Room limit: workers 2 of 2 in use. worker-3 waits for a free slot.</div>'
 + f'<div style="margin-top: auto; display: flex; justify-content: flex-end; gap: 8px"><button style="{BTN2}">Cancel</button><button style="{BTNP}">Launch</button></div></aside>')
main=('<main style="flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 20px 24px 24px; gap: 12px">'
 f'<div style="display: flex; align-items: center; gap: 12px"><h1 style="margin: 0; font-size: 22px; font-weight: 600">Agents</h1><span style="font-size: 14px; color: var(--text-muted)">5 live · 1 stalled</span><span style="flex: 1"></span><button style="{BTN2}">Launch command</button><button style="{BTN2}">New factory room</button><button style="{BTNP}">+ Launch agent</button></div>'
 '<div style="flex: 1; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 8px; overflow: hidden">'+tabs+term+'</div></main>')
open(P+'Agents.dc.html','w').write(desk('Agents',1000,'Agents','<a href="#" style="color: var(--text-muted); text-decoration: none">Agents</a><span>/</span><span style="color: var(--text)">Shell</span>',left+main+form))
# phone agents list
rows=''.join(f'<a href="SessionPhone.dc.html" style="display: grid; grid-template-columns: 10px minmax(0,1fr) auto 32px; gap: 10px; align-items: center; min-height: 60px; padding: 8px 12px; {"border-top: 1px solid var(--line-soft);" if i else ""} text-decoration: none; color: var(--text)">{dot(dc)}<span><span style="display: block; font-family: var(--mono); font-size: 14px; color: var(--{c})">{n}</span><span style="display: block; font-size: 14px; color: var(--text-muted)">{s}</span></span><span style="font-family: var(--mono); font-size: 12px; color: var(--text-meta)">{p}</span><span aria-label="{n} actions" style="font-size: 18px; color: var(--text-muted); text-align: center">⋯</span></a>' for i,(n,s,c,p,dc) in enumerate([('worker-1','t_46fd · rework 5','amber','38%','green'),('tester-1','t_dc9f · full suite','teal','12%','green'),('validator','stalled 22 min','purple','71%','amber'),('orchestrator','lead','orange','54%','green'),('worker-2','idle','text-muted','','line-hover')]))
pb=(phdr('Agents','5 live · 1 stalled',False)+
 f'<div style="flex: 1; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px"><div style="{CARD}; overflow: hidden">{rows}</div>'
 f'<a href="#" style="{CARD}; display: flex; justify-content: space-between; align-items: center; min-height: 52px; padding: 0 14px; color: var(--text); text-decoration: none"><span>Finished sessions</span><span style="font-family: var(--mono); color: var(--text-meta)">544 ›</span></a>'
 f'<a href="#" style="{CARD}; display: flex; justify-content: space-between; align-items: center; min-height: 52px; padding: 0 14px; color: var(--text); text-decoration: none"><span>Shell · your scratch shell</span><span style="color: var(--text-meta)">›</span></a></div>'
 '<button style="position: absolute; right: 16px; bottom: 74px; height: 48px; padding: 0 18px; border: 0; border-radius: 999px; background: var(--orange); color: #1a1714; font-weight: 600; font-size: 16px; box-shadow: 0 6px 18px rgba(0,0,0,.35)">+ Launch agent</button>'
 + pnav('Agents'))
open(P+'AgentsPhone.dc.html','w').write(phone('Agents on a phone',pb))
print('ok')
