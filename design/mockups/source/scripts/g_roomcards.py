exec(open('/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/lib.py').read())
def av(n,c): return f'<span aria-hidden="true" style="width: 32px; height: 32px; flex: none; border-radius: 6px; background: color-mix(in srgb, var(--{c}) 20%, transparent); color: var(--{c}); display: grid; place-items: center; font-family: var(--mono); font-weight: 600">{n[0].upper()}</span>'
def msg(n,c,time,kind,inner,hover=''):
    return (f'<article style="position: relative; display: grid; grid-template-columns: 32px minmax(0,1fr); gap: 12px; {"padding: 6px 8px; margin: -6px -8px; border-radius: 6px; background: var(--bg-raised);" if hover else ""}">{av(n,c)}<div style="display: flex; flex-direction: column; gap: 8px; min-width: 0">'
            f'<div style="display: flex; gap: 8px; font-size: 12px"><span style="font-weight: 600; font-family: var(--mono); color: var(--{c})">{n}</span><span style="color: var(--text-meta)">{time} · {kind}</span></div>{inner}</div>{hover}</article>')
def kcard(color,label,inner,btns):
    return (f'<div style="border: 1px solid var(--line); border-left: 3px solid var(--{color}); border-radius: 6px; background: var(--bg-raised); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px">'
            f'<div style="font-family: var(--mono); font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--{color})">{label}</div>{inner}'
            f'<div style="display: flex; gap: 8px; flex-wrap: wrap">{btns}</div></div>')
hover=('<div role="toolbar" aria-label="Message actions" style="position: absolute; top: -14px; right: 8px; display: flex; gap: 2px; padding: 2px; '+POP+'">'
  '<button style="height: 28px; padding: 0 8px; border: 0; background: none; color: var(--text); cursor: pointer; font-size: 12px">Copy</button>'
  '<button style="height: 28px; padding: 0 8px; border: 0; background: none; color: var(--text); cursor: pointer; font-size: 12px">Pin</button>'
  '<button style="height: 28px; padding: 0 8px; border: 0; background: none; color: var(--text); cursor: pointer; font-size: 12px">Reply</button></div>')
T='font-size: 14px; color: var(--text-muted)'
feed=('<div role="log" aria-label="Room messages" style="flex: 1; padding: 20px 32px 12px; display: flex; flex-direction: column; gap: 22px; max-width: 920px; width: 100%">'
 + msg('orchestrator','orange','19:02','handoff',kcard('orange','Handoff → worker-1',f'<div style="font-size: 14px"><a href="Ticket.dc.html" style="font-family: var(--mono)">t_46fd</a> rework 5: unreadable line returns source none. Validator checks only this fix.</div><div style="font-size: 12px; color: var(--text-meta)">pending · expires in 28 min · context: request_text, ticket_ids</div>',
   f'<button style="{BTNP}">Accept</button><button style="{BTN2}">Decline…</button><button style="{BTN2}">Cancel handoff</button>'),hover)
 + msg('worker-1','amber','19:05','permission',kcard('amber','Permission · Bash',f'<pre style="margin: 0; padding: 8px 10px; border-radius: 4px; background: var(--bg-inset); font-family: var(--mono); font-size: 12px; color: var(--code-text); white-space: pre-wrap">git push origin ticket/t_46fd</pre><div style="font-size: 12px; color: var(--text-meta)">worker-1 waits · asked 1 min ago</div>',
   f'<button style="height: 34px; padding: 0 14px; border: 0; border-radius: 6px; background: var(--green); color: #14110f; font-weight: 600; cursor: pointer; font-size: 14px">Allow</button><button style="{BTND}">Deny</button><button style="{BTN2}">Dismiss</button>'))
 + msg('orchestrator','orange','19:20','interrupt',kcard('red','Interrupt → validator',f'<div style="font-size: 14px">Stop the t_ebd5 review: the plan changed. Wait for the new version.</div><div style="font-size: 12px; color: var(--text-meta)">not yet acknowledged by validator</div>',
   f'<button style="{BTN2}">Acknowledge (as validator)</button>'))
 + msg('tester-1','teal','19:31','stage',kcard('teal','Stage · test · t_46fd',f'<div style="display: flex; gap: 16px; font-size: 14px"><span>2056 pass · 0 fail</span><span style="color: var(--text-meta)">14 min · 41k tokens</span></div>',
   f'<a href="Session.dc.html" style="{BTN2}; text-decoration: none">Watch session</a><a href="#" style="{BTN2}; text-decoration: none">Report</a>'))
 + msg('worker-1','amber','19:40','message',f'<div style="{T}">The FAIL 5 trace, before the fix:</div><a href="#" style="display: block; width: 280px; height: 150px; border-radius: 6px; border: 1px solid var(--line); background: linear-gradient(135deg, var(--bg-elev), var(--bg-inset)); position: relative"><span style="position: absolute; left: 8px; bottom: 8px; font-family: var(--mono); font-size: 12px; color: var(--text-muted)">fail5-trace.png · open full size</span></a>')
 + '</div>')
pins=('<div style="flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 32px; border-bottom: 1px solid var(--line-soft); font-size: 14px">'
 '<span style="'+SEC+'">Pinned 2</span><a href="#" style="color: var(--text); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 420px">📌 Interim rule: the Orchestrator decides unless scope, undo or security</a>'
 '<a href="#" style="color: var(--text-muted); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px">📌 Install 28 notes</a><button style="margin-left: auto; border: 0; background: none; color: var(--text-muted); font-size: 12px; cursor: pointer">Unpin…</button></div>')
target=(f'<div role="listbox" aria-label="Send to" style="position: absolute; left: 32px; bottom: 96px; width: 260px; padding: 6px; z-index: 15; {POP}; display: flex; flex-direction: column; gap: 2px; font-size: 14px">'
 '<div style="padding: 4px 8px; font-size: 12px; color: var(--text-meta)">Send to</div>'
 + ''.join(f'<button role="option" aria-selected="{"true" if n=="orchestrator" else "false"}" style="height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border: 0; border-radius: 4px; background: {"var(--bg-elev)" if n=="orchestrator" else "none"}; color: var(--text); cursor: pointer; font-family: var(--mono)">→ {who(n) if n!="All" else "All agents"}</button>' for n in ['All','orchestrator','worker-1','tester-1','validator'])
 + '<div style="height: 1px; background: var(--line-soft); margin: 4px 0"></div>'
 '<button style="height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border: 0; border-radius: 4px; background: none; color: var(--red-strong); cursor: pointer">⚠ Interrupt worker-1…</button>'
 '<button style="height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border: 0; border-radius: 4px; background: none; color: var(--red-strong); cursor: pointer">⚠ Interrupt validator…</button></div>')
slash=(f'<div role="listbox" aria-label="Commands" style="position: absolute; left: 320px; bottom: 96px; width: 420px; padding: 6px; z-index: 15; {POP}; display: flex; flex-direction: column; gap: 2px; font-size: 14px">'
 '<div style="padding: 4px 8px; font-size: 12px; color: var(--text-meta)">Commands for @worker-1 · sent to its session</div>'
 + ''.join(f'<div role="option" aria-selected="{"true" if i==0 else "false"}" style="display: flex; gap: 12px; padding: 6px 8px; border-radius: 4px; {"background: var(--bg-elev);" if i==0 else ""}"><span style="font-family: var(--mono); width: 90px">{c}</span><span style="color: var(--text-muted)">{d}</span></div>' for i,(c,d) in enumerate([('/compact','Shorten the context'),('/context','Show context use'),('/clear','Start a fresh context'),('/model','Change the model'),('/cost','Show this session\'s cost')]))
 + '<div style="padding: 4px 8px; font-size: 12px; color: var(--text-meta)">47 commands · type to filter</div></div>')
mention=(f'<div role="listbox" aria-label="Mention" style="position: absolute; right: 120px; bottom: 96px; width: 220px; padding: 6px; z-index: 15; {POP}; font-size: 14px">'
 '<div style="padding: 4px 8px; font-size: 12px; color: var(--text-meta)">@ mention</div>'
 + ''.join(f'<div style="height: 30px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border-radius: 4px; {"background: var(--bg-elev);" if n=="tester-1" else ""}">{dot("green")}{who(n)}</div>' for n in ['tester-1','validator']) + '</div>')
kbd=lambda k: f'<kbd style="font-family: var(--mono); font-size: 12px; padding: 1px 6px; border: 1px solid var(--line); border-radius: 4px; color: var(--text-muted)">{k}</kbd>'
comp=('<form style="flex: none; padding: 12px 32px 20px; max-width: 920px; width: 100%; display: flex; flex-direction: column; gap: 8px">'
 '<div style="display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--text-muted)"><span style="display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; font-family: var(--mono)">📎 trace.log · 4 KB <button aria-label="Remove attachment" style="border: 0; background: none; color: var(--text-muted); cursor: pointer">×</button></span></div>'
 '<div style="display: flex; align-items: flex-end; gap: 8px">'
 f'<button type="button" aria-expanded="true" style="{BTN2}; height: 36px; font-family: var(--mono); font-size: 12px">@ orchestrator {caret}</button>'
 f'<button type="button" aria-label="Emoji" style="{BTN2}; height: 36px; width: 36px; padding: 0; justify-content: center">☺</button>'
 f'<button type="button" aria-label="Attach file" style="{BTN2}; height: 36px; width: 36px; padding: 0; justify-content: center">📎</button>'
 '<div style="flex: 1; min-height: 36px; padding: 7px 12px; border: 1px solid var(--orange); border-radius: 6px; background: var(--bg-inset); font-family: var(--mono); font-size: 14px">@worker-1 /comp<span style="background: var(--text); color: var(--bg)"> </span></div>'
 f'<button type="submit" style="{BTNP}; height: 36px">Send</button></div>'
 f'<div style="display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--text-meta)"><span>{kbd("Enter")} send</span><span>{kbd("Shift")}+{kbd("Enter")} new line</span><span>{kbd("@")} name target</span><span>{kbd("/")} command @target</span><span>{kbd("Shift")}+{kbd("Tab")} cycle modes</span></div></form>')
aside=('<aside style="width: 320px; flex: none; border-left: 1px solid var(--line-soft); background: var(--bg-inset); padding: 24px 20px; display: flex; flex-direction: column; gap: 16px">'
 f'<div style="{SEC}">Room transcript</div>'+toggle(True,'Persist chat transcript','On · 4,812 lines since 14 Oct')+toggle(True,'Auto-summarise this room','L1 every 300 lines, L2 every 20 L1s; replayed in the briefing for new agents')
 + f'<button style="{BTN2}">Archive transcript and start fresh…</button><div style="font-size: 12px; color: var(--text-meta)">Past data stays on disk. The chat window resets; agents see fresh context on restart.</div>'
 '</aside>')
body=('<main style="position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column">'+pins+feed+comp+target+slash+mention+'</main>'+aside)
open(P+'RoomCards.dc.html','w').write(desk('Room cards and menus',1100,'Room','<span style="font-family: var(--mono); color: var(--text)"># cubilot</span><span>·</span><span>cards and menus</span>',body))
print('ok')
