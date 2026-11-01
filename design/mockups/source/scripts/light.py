import re,json,glob,os
P='/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/canvas/project/'
dawn={'bg':'#faf4ed','bg-raised':'#fffaf3','bg-elev':'#f2e9e1','bg-inset':'#f4ede8','bg-hover':'#dfdad9','line':'#dfdad9','line-soft':'#f4ede8','line-hover':'#cecacd','text':'#575279','text-muted':'#6a6587','text-meta':'#6a6587','orange':'#d7827e','orange-text':'#b83f39','amber':'#a8691a','green':'#286983','red':'#b4637a','red-strong':'#a14d65','green-strong':'#286983','blue':'#56949f','purple':'#907aa9','teal':'#286983','code-text':'#b83f39'}
fonts="--sans:Inter,-apple-system,'Segoe UI',sans-serif;--mono:'JetBrains Mono',ui-monospace,Menlo,monospace;--serif:Fraunces,Georgia,serif"
root=':root{color-scheme:light;'+''.join(f'--{k}:{v};' for k,v in dawn.items())+fonts+'}'
reps=[('a:hover{color:#e08265}','a:hover{color:#c97165}'),('background: var(--green); color: #14110f','background: var(--green); color: #fffaf3'),('background: var(--purple); color: #14110f','background: var(--purple); color: #fffaf3'),
 ('color: #9bbfe0','color: #286983'),('color: #c4abdb','color: var(--text)'),('background: #0f0d0b','background: #fffaf3'),('"#0f0d0b"','"#fffaf3"'),('color: #d8cfc3','color: #575279'),
 ('background: #d8cfc3; color: #0f0d0b','background: #d7827e; color: #fffaf3'),('#3a322b','#cecacd'),('rgba(0,0,0,.45)','rgba(87,82,121,.14)'),('rgba(0,0,0,.55)','rgba(87,82,121,.28)'),('rgba(0,0,0,.35)','rgba(87,82,121,.2)'),
 ('color-mix(in srgb, var(--amber) 14%, var(--bg))','color-mix(in srgb, #ea9d34 18%, var(--bg))')]
darks=[f[len(P):-8] for f in glob.glob(P+'*.dc.html') if not f.endswith('Light.dc.html')]
for b in darks:
    s=open(P+b+'.dc.html').read()
    s,n=re.subn(r':root\{color-scheme:dark;[^}]*\}',lambda m:root,s,count=1); assert n==1,b
    for o,nw in reps: s=s.replace(o,nw)
    s=s.replace('<title>Cubilot · ','<title>Cubilot light · ',1)
    for x in darks: s=s.replace(f'href="{x}.dc.html"',f'href="{x}Light.dc.html"')
    open(P+b+'Light.dc.html','w').write(s)
# canvas
c=json.load(open(P+'canvas.json'))
y=6120
for d,ph in [('Login','LoginPhone'),('SignInStates',None),('Flow','FlowPhone'),('Dashboard','DashboardPhone'),('TicketForm','TicketFormPhone'),('RoomCards',None),('Agents','AgentsPhone'),('Requests','RequestsPhone'),('Delivery','DeliveryPhone'),('Settings',None),('Dialogs',None),('Diagnosis','DiagnosisPhone'),('Mutation',None),('Deliver',None),('Admin',None),('SetupStart',None),('SetupComponents',None),('SetupInstall',None),('SetupAccounts',None),('Coverage',None)]:
    h=int(re.search(r'"height":(\d+)',open(P+d+'.dc.html').read()).group(1))
    titles={'Diagnosis':'Stage diagnosis: why it failed, trace, checks','Mutation':'Ticket · mutation result','Deliver':'Deliver to client · leak gate','Admin':'Admin: checks, components, accounts, projects, backup, updates','SetupStart':'Setup 0 · start','SetupComponents':'Setup 1 · components','SetupInstall':'Setup 3 · install','SetupAccounts':'Setup 4 · accounts and secrets','Login':'Sign in','SignInStates':'Sign-in states: setup, codes, fallback, lock, step-up','Dashboard':'Dashboard · milestones and health','Flow':'Flow · board, filters, move to','TicketForm':'Ticket · new / edit form','RoomCards':'Room · cards and menus','Agents':'Agents · launch, menu, shell, finished','Requests':'Requests · list and start','Delivery':'Delivery · your test','Settings':'Settings','Dialogs':'Dialogs and toasts','Coverage':'Coverage · every feature → element'}
    c['boards'][d+'.dc.html']={'x':0,'y':y,'w':1440,'h':h,'title':titles[d],'expand':'fill'}
    if ph: c['boards'][ph+'.dc.html']={'x':1520,'y':y,'w':390,'h':844,'title':titles[d].split(' · ')[0]+' · phone'}
    y+=max(h,844)+120
for k in list(c['boards']):
    if k.endswith('Light.dc.html'): del c['boards'][k]
for k in [k for k in c['boards'] if not k.endswith('Light.dc.html')]:
    if k=='Coverage.dc.html': continue
    v=dict(c['boards'][k]); v['x']+=2000; v['title']+=' · light'; c['boards'][k[:-8]+'Light.dc.html']=v
c['order']=[k for k in c['boards']]
open(P+'canvas.json','w').write(json.dumps(c,separators=(',',':')))
os.remove(P+'CoverageLight.dc.html')
print(len(c['boards']),'boards')
