exec(open('/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/lib.py').read())
tb=''.join(f'<button type="button" aria-label="{l}" title="{l} ({k})" style="width: 32px; height: 30px; border: 0; border-radius: 4px; background: none; color: var(--text-muted); cursor: pointer; font-family: var(--mono); font-size: 14px">{g}</button>' for g,l,k in [('B','Bold','⌘B'),('•','Bulleted list','⌘⇧8'),('☐','Checklist item','⌘⇧9'),('&lt;/&gt;','Inline code','⌘E')])
crit=('<div style="border: 1px solid var(--line-hover); border-radius: 6px; background: var(--bg-inset)">'
 f'<div style="display: flex; gap: 2px; padding: 4px; border-bottom: 1px solid var(--line-soft)">{tb}<span style="flex: 1"></span><span style="align-self: center; padding-right: 8px; font-size: 12px; color: var(--text-meta)">each line: a criterion, then “verify:” and a command</span></div>'
 '<div style="padding: 10px 12px; font-family: var(--mono); font-size: 14px; line-height: 1.7; color: var(--text)">☐ Escalation arrives as one card on Decisions<br><span style="color: var(--text-meta)">&nbsp;&nbsp;verify: bun test tests/unit/decision.test.ts</span><br>☐ Your answer reaches the Orchestrator as a ruling note<span style="background: var(--text); color: var(--bg)"> </span></div></div>')
chips=''.join(f'<span style="display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 4px 0 10px; border: 1px solid var(--line-hover); border-radius: 999px; font-family: var(--mono); font-size: 12px">{c}<button aria-label="Remove blocker {c}" style="width: 22px; height: 22px; border: 0; border-radius: 50%; background: none; color: var(--text-muted); cursor: pointer">×</button></span>' for c in ['t_a87b · metrics table'])
modal=(f'<div role="dialog" aria-modal="true" aria-labelledby="tf-h" style="position: relative; width: 760px; margin: 40px auto; padding: 24px; {POP}; display: flex; flex-direction: column; gap: 16px">'
 '<div style="display: flex; align-items: center; gap: 12px"><h1 id="tf-h" style="margin: 0; font-size: 18px; font-weight: 600">New ticket — Draft</h1><span style="font-size: 12px; color: var(--text-meta)">in # cubilot</span><button aria-label="Close" style="margin-left: auto; width: 32px; height: 32px; border: 0; background: none; color: var(--text-muted); font-size: 18px; cursor: pointer">×</button></div>'
 + field('Title',inp('Human escalation: decision Kind and your answer'))
 + field('Acceptance criteria',crit)
 + '<div style="display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 12px">'
 + field('Radius','<div role="group" style="display: flex; border: 1px solid var(--line-hover); border-radius: 6px; overflow: hidden"><button aria-pressed="false" style="flex: 1; height: 36px; border: 0; background: none; color: var(--text); cursor: pointer">Low</button><button aria-pressed="true" style="flex: 1; height: 36px; border: 0; border-left: 1px solid var(--line-hover); background: color-mix(in srgb, var(--red) 14%, transparent); color: var(--red-strong); cursor: pointer; font-weight: 600">High</button></div>','reason: permissions')
 + field('Priority',sel('↑ High'))
 + field('Assignee',sel('Unassigned · the lead triages'))
 + '</div><div style="display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px">'
 + field('Request',sel('human-touchpoints-checkpoint',True))
 + field('Ref (spec task, issue, link)',inp('openspec 2.1','',True))
 + '</div>'
 + field('Waits for (blockers)',f'<div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 36px; padding: 4px; border: 1px solid var(--line-hover); border-radius: 6px; background: var(--bg-inset)">{chips}<input placeholder="Search tickets to add as a blocker" style="flex: 1; min-width: 200px; height: 28px; border: 0; background: none; color: var(--text); outline: none; font-size: 14px"></div>','every blocker needs a reason')
 + field('Attachments','<div style="display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px dashed var(--line-hover); border-radius: 6px; font-size: 14px; color: var(--text-muted)"><span style="flex: 1">Drop files here, or paste an image</span><button type="button" style="'+BTN2+'">Attach file</button></div>')
 + '<p style="margin: 0; font-size: 12px; color: var(--amber)">High radius: this ticket gets a second review instead of your Allow.</p>'
 f'<div style="display: flex; justify-content: flex-end; gap: 8px"><button style="{BTN2}">Cancel</button><button style="{BTNP}">Create in Draft</button></div></div>')
body=('<div aria-hidden="true" style="position: absolute; inset: 0; background: rgba(0,0,0,.55); z-index: 30"></div>'
 '<main style="position: relative; z-index: 31; flex: 1; min-width: 0">'+modal+'</main>')
open(P+'TicketForm.dc.html','w').write(desk('New ticket',1000,'Flow','<span style="color: var(--text)">New ticket</span>',body))
# phone ticket form
pb=(phdr('New ticket','Draft · # cubilot')+
 '<div style="flex: 1; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px">'
 + field('Title',inp('Human escalation: decision Kind').replace('font-size: 14px','font-size: 16px'))
 + field('Acceptance criteria','<textarea rows="4" style="'+INP.replace('height: 36px','height: auto')+'; padding: 8px 10px; font-size: 16px; font-family: var(--mono)">☐ Escalation arrives as one card\n  verify: bun test tests/unit/decision.test.ts</textarea>')
 + '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">'+field('Radius',sel('High · permissions'))+field('Priority',sel('↑ High'))+'</div>'
 + field('Assignee',sel('Unassigned · the lead triages'))
 + field('Request',sel('human-touchpoints-checkpoint',True))
 + field('Waits for',sel('t_a87b · metrics table',True))
 + f'<button style="{BTN2}; height: 44px; justify-content: center">Attach file or photo</button>'
 '</div><div style="flex: none; display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line-soft); background: var(--bg-raised)"><button style="flex: 1; height: 48px; border: 1px solid var(--line-hover); border-radius: 6px; background: none; color: var(--text); font-size: 16px">Cancel</button><button style="flex: 2; height: 48px; border: 0; border-radius: 6px; background: var(--orange); color: #1a1714; font-weight: 600; font-size: 16px">Create in Draft</button></div>')
open(P+'TicketFormPhone.dc.html','w').write(phone('New ticket on a phone',pb))
# patch Ticket.dc.html
t=open(P+'Ticket.dc.html').read()
if 'data-cov="props"' not in t:
    a=t.index('<aside'); a=t.index('>',a)+1
    props=('<div data-cov="props" style="display: flex; flex-direction: column; gap: 8px"><div style="display: flex; align-items: center"><div style="'+SEC+'">Properties</div><button style="margin-left: auto; '+BTN2+'; height: 28px">Edit</button></div>'
      '<div style="display: flex; flex-direction: column; gap: 6px; font-size: 14px">'
      '<div style="display: flex; justify-content: space-between; gap: 8px"><span style="color: var(--text-muted)">Priority</span><span style="color: var(--red-strong)">⇈ Highest</span></div>'
      '<div style="display: flex; justify-content: space-between; gap: 8px; align-items: center"><span style="color: var(--text-muted)">Assignee</span><span>'+who('worker-1')+' <a href="#" style="font-size: 12px; margin-left: 6px">reassign</a></span></div>'
      '<div style="display: flex; justify-content: space-between; gap: 8px"><span style="color: var(--text-muted)">Ref</span><span style="font-family: var(--mono)">openspec 5.1–5.4</span></div>'
      '<div style="display: flex; justify-content: space-between; gap: 8px"><span style="color: var(--text-muted)">Request</span><a href="Request.dc.html" style="font-family: var(--mono)">context-pack</a></div></div></div>'
      '<div style="display: flex; flex-direction: column; gap: 8px"><div style="display: flex; align-items: center"><div style="'+SEC+'">Attachments</div><button style="margin-left: auto; '+BTN2+'; height: 28px">Attach</button></div>'
      '<div style="display: flex; align-items: center; gap: 8px; font-size: 14px"><span style="width: 36px; height: 28px; border-radius: 4px; background: var(--bg-elev); border: 1px solid var(--line)"></span><span style="flex: 1; font-family: var(--mono); font-size: 12px">fail5-trace.png</span><button style="border: 0; background: none; color: var(--text-muted); font-size: 12px; cursor: pointer">Replace</button><button aria-label="Remove fail5-trace.png" style="border: 0; background: none; color: var(--text-muted); cursor: pointer">×</button></div></div>')
    t=t[:a]+props+t[a:]
    o='<button style="height: 34px; border: 1px solid var(--line-hover); border-radius: 6px; background: none; color: var(--text); text-align: left; padding: 0 12px; cursor: pointer">Move back to draft</button>'
    assert o in t
    t=t.replace(o,'<button style="height: 34px; border: 1px solid var(--line-hover); border-radius: 6px; background: none; color: var(--text); text-align: left; padding: 0 12px; cursor: pointer">Move to… (Draft, Queued, In review, Done)</button><button style="height: 34px; border: 1px solid var(--line-hover); border-radius: 6px; background: none; color: var(--text); text-align: left; padding: 0 12px; cursor: pointer">Archive</button>')
    # notes composer after rulings
    k='</section>\n</main>'
    assert k in t
    note=('<div style="display: flex; gap: 8px"><label for="tn" style="position: absolute; left: -9999px">Add a note</label><input id="tn" placeholder="Add a note or a ruling to this ticket" style="'+INP+'"><button style="'+BTNP+'; height: 36px">Add note</button></div>')
    t=t.replace(k,note+k,1)
    open(P+'Ticket.dc.html','w').write(t)
print('ticket ok')
