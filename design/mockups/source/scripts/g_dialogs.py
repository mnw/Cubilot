exec(open('/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/lib.py').read())
def dlg(title,inner,btns,w=420,cap=''):
    return (f'<div style="display: flex; flex-direction: column; gap: 8px"><div style="font-size: 12px; color: var(--text-meta)">{cap}</div>'
     f'<div role="dialog" aria-label="{title}" style="width: {w}px; padding: 20px; {POP}; display: flex; flex-direction: column; gap: 14px">'
     f'<h2 style="margin: 0; font-size: 18px; font-weight: 600">{title}</h2>{inner}<div style="display: flex; justify-content: flex-end; gap: 8px">{btns}</div></div></div>')
B2=lambda t: f'<button style="{BTN2}">{t}</button>'
BP=lambda t: f'<button style="{BTNP}">{t}</button>'
BD=lambda t: f'<button style="height: 34px; padding: 0 14px; border: 0; border-radius: 6px; background: var(--red); color: #fffaf3; font-weight: 600; cursor: pointer; font-size: 14px">{t}</button>'
ta=lambda v,rows=4,mono=False: f'<textarea rows="{rows}" style="{INP.replace("height: 36px","height: auto")}; padding: 8px 10px; resize: vertical; {"font-family: var(--mono); font-size: 12px;" if mono else ""}">{v}</textarea>'
d1=dlg('New factory room', field('Room name',inp('my-product','my-product',True))+field('Project folder','<div style="display: flex; gap: 6px">'+inp('~/Workspace/my-product','',True)+f'<button style="{BTN2}; height: 36px">Pick…</button></div>')
   +'<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">'+field('Workers',sel('2'))+field('Testers',sel('1'))+'</div><div style="font-size: 12px; color: var(--text-meta)">Starts an Orchestrator as lead, plus the agents you choose.</div>',
   B2('Cancel')+BP('Create room'),cap='From the room switcher · + New room, or Agents · New factory room')
d2=dlg('Edit the nutshell', field('Proposed nutshell (v9)',ta('Room cubilot builds Cubilot, an app that runs Claude Code and Pi agents in shared rooms. Team: the Orchestrator (lead), two workers, a tester and a validator.',5))
   +'<div style="font-size: 12px; color: var(--text-meta)">v8 by Orchestrator · your edit goes to the lead as a proposal</div>',B2('Cancel')+BP('Propose edit'),w=520,cap='Room · Nutshell · Edit')
d3=dlg('Cancel ticket t_5e7a?','<div style="font-size: 14px; color: var(--text-muted)">Stage metrics in the delivery report. Its branch is kept; the ticket moves to Cancelled and can be shown with the filter.</div>',
   B2('Keep it')+BD('Cancel ticket'),cap='Confirm: any action that cannot be undone in one click')
d4=dlg('Decline the handoff','<div style="font-size: 14px; color: var(--text-muted)">worker-1 will see your reason.</div>'+field('Reason',ta('The plan for t_46fd changed; wait for the new handoff.',3)),
   B2('Back')+BP('Decline'),cap='Reason: decline, deny, interrupt, cancel, send back')
d5=dlg('Global MCP servers','<div style="font-size: 14px; color: var(--text-muted)">Shared by every agent. Edit in your editor; agents pick it up on relaunch.</div>'
   +ta('{\n  "mcpServers": {\n    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },\n    "playwright": { "command": "npx", "args": ["@playwright/mcp"] }\n  }\n}',7,True),
   B2('Copy')+B2('Open in editor')+BP('Close'),w=520,cap='Settings · Agents · Global MCP servers')
d6=dlg('Claude launch command','<div style="font-size: 14px; color: var(--text-muted)">Run this in your own terminal to start an agent outside the app.</div>'
   +'<pre style="margin: 0; padding: 10px 12px; border-radius: 6px; background: var(--bg-inset); font-family: var(--mono); font-size: 12px; color: var(--code-text); white-space: pre-wrap">CUBILOT_ROOM=cubilot CUBILOT_NAME=worker-3 \\\n  claude --mcp-config ~/.cubilot/mcp.json</pre>',
   B2('Copy')+BP('Close'),w=520,cap='Agents · Launch command')
def toast(c,t,sub,btn): return (f'<div role="status" style="width: 380px; display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border-left: 3px solid var(--{c}); {POP}">'
   f'<div style="flex: 1"><div style="font-size: 14px; font-weight: 600">{t}</div><div style="font-size: 12px; color: var(--text-muted)">{sub}</div></div>{btn}</div>')
toasts=('<div style="display: flex; flex-direction: column; gap: 8px"><div style="font-size: 12px; color: var(--text-meta)">Toasts · bottom right, 6 s, or until acted on</div>'
 + toast('green','worker-3 launched','# cubilot · Opus 5.5 · ~/Workspace/cubilot',f'<a href="Session.dc.html" style="font-size: 14px">Watch</a>')
 + toast('red','Launch failed: worker-3','claude exited: model not available','<a href="#" style="font-size: 14px">Details</a>')
 + toast('amber','Settings saved — hub restart needed','config.yml changed 2 keys',f'<button style="{BTNP}; height: 30px">Restart hub</button>')
 + toast('orange','Copied','t_46fd9a1728df0fc2','') + '</div>')
body=('<main style="flex: 1; padding: 28px 32px 40px; display: flex; flex-direction: column; gap: 24px">'
 '<div><h1 style="margin: 0; font-size: 22px; font-weight: 600">Dialogs and toasts</h1><div style="font-size: 14px; color: var(--text-muted)">Shown over the screen that opens them, with the page dimmed. On a phone they open as a full-height sheet.</div></div>'
 f'<div style="display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start">{d1}{d2}{d3}{d4}{d5}{d6}{toasts}</div></main>')
open(P+'Dialogs.dc.html','w').write(desk('Dialogs',1720,'','<span style="color: var(--text)">Dialogs and toasts</span>',body))
print('ok')
