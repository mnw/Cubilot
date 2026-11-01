exec(open('/tmp/claude-0/-home-claude/3bf293c1-0591-5816-9680-a8749163b7f9/scratchpad/lib.py').read())
LOGO='<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--orange)" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 3 7v10l9 5 9-5V7z"></path><path d="m3 7 9 5 9-5"></path><path d="M12 12v10"></path></svg>'
KEY='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="15" r="4"></circle><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14 9l2 2"></path></svg>'
LOCK='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>'
def bare(title,h,inner,w=1440):
    return (HEAD.replace('Cubilot · Ticket t_46fd','Cubilot · '+title)+
      f'\n<div style="min-height: {h}px; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; line-height: 1.5">{inner}</div>\n'+tail(w,h))
host=f'<div style="display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 12px; color: var(--text-meta)"><span style="color: var(--green-strong)">{LOCK}</span>cubilot.kohaku.example</div>'
BIG='height: 44px; width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 10px; border-radius: 6px; font-size: 16px; cursor: pointer; white-space: nowrap'
def card(inner,w=400): return f'<div style="width: {w}px; max-width: 100%; padding: 32px; {POP.replace("0 12px 32px rgba(0,0,0,.45)","0 20px 60px rgba(0,0,0,.35)")}; display: flex; flex-direction: column; gap: 18px">{inner}</div>'
head_=lambda t,sub: f'<div style="display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center">{LOGO}<h1 style="margin: 0; font-family: var(--serif); font-weight: 500; font-size: 28px">{t}</h1><div style="font-size: 14px; color: var(--text-muted)">{sub}</div></div>'
signin=card(head_('Cubilot','Sign in to your factory')
 + field('Account',inp('michel','your account name').replace('font-size: 14px','font-size: 16px'))
 + f'<button style="{BIG}; border: 0; background: var(--orange); color: #1a1714; font-weight: 600">{KEY}Sign in with a passkey</button>'
 + '<div style="display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--text-meta)"><span style="flex: 1; height: 1px; background: var(--line)"></span>or<span style="flex: 1; height: 1px; background: var(--line)"></span></div>'
 + f'<button style="{BIG}; border: 1px solid var(--line-hover); background: none; color: var(--text)">Use password and code</button>'
 + '<div style="display: flex; justify-content: space-between; font-size: 12px"><a href="#">Use a recovery code</a><span style="color: var(--text-meta)">No account? Ask the owner.</span></div>')
desk_body=('<div style="flex: 1; display: grid; place-items: center; padding: 40px 16px; background: radial-gradient(900px 500px at 50% 0%, color-mix(in srgb, var(--orange) 9%, transparent), transparent)">'
 + f'<div style="display: flex; flex-direction: column; align-items: center; gap: 16px">{signin}{host}</div></div>'
 '<footer style="flex: none; display: flex; justify-content: center; gap: 16px; padding: 14px; font-size: 12px; color: var(--text-meta)"><span>HTTPS · passkey or password with a code · 5 tries in 15 min</span></footer>')
open(P+'Login.dc.html','w').write(bare('Sign in',900,desk_body))
pb=('<div style="flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 16px; padding: 24px 16px; background: radial-gradient(500px 360px at 50% 0%, color-mix(in srgb, var(--orange) 9%, transparent), transparent)">'
 + signin.replace('width: 400px','width: 358px').replace('padding: 32px','padding: 24px') + f'<div style="text-align: center">{host}</div></div>')
open(P+'LoginPhone.dc.html','w').write(PHEAD.replace('Cubilot · Room on a phone','Cubilot · Sign in on a phone')+'\n<div style="width: 390px; height: 844px; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 16px; line-height: 1.45; overflow: hidden">'+pb+'</div>\n'+tail(390,844))
# ---- states board
def cap_(t,c): return f'<div style="display: flex; flex-direction: column; gap: 8px"><div style="font-size: 12px; color: var(--text-meta)">{t}</div>{c}</div>'
pw=card(head_('Password and code','For michel')
 + field('Password','<input type="password" value="••••••••••••" style="'+INP+'; font-size: 16px">')
 + field('6-digit code from your authenticator app','<input inputmode="numeric" value="482 913" style="'+INP+'; font-size: 16px; font-family: var(--mono); letter-spacing: .3em">')
 + f'<button style="{BIG}; border: 0; background: var(--orange); color: #1a1714; font-weight: 600">Sign in</button><a href="#" style="font-size: 12px; text-align: center">Back to passkey</a>',360)
locked=card(head_('Too many tries','Sign-in for michel is locked for 12 more minutes.')
 + '<div role="alert" style="padding: 10px 12px; border-left: 3px solid var(--red); border-radius: 4px; background: color-mix(in srgb, var(--red) 10%, transparent); font-size: 14px">5 failed sign-ins from 203.0.113.24 since 21:02. The attempts are in the sign-in log.</div>'
 + f'<button disabled style="{BIG}; border: 0; background: var(--bg-elev); color: var(--text-meta); cursor: not-allowed">Try again at 21:29</button><a href="#" style="font-size: 12px; text-align: center">Use a recovery code</a>',360)
setup=card(head_('Set up Cubilot','First run on this server')
 + field('Setup code','<input value="K7Q4-9XMB" style="'+INP+'; font-size: 16px; font-family: var(--mono)">','printed on the server console · expires in 15 min')
 + field('Owner account',inp('michel').replace('font-size: 14px','font-size: 16px'))
 + f'<button style="{BIG}; border: 0; background: var(--orange); color: #1a1714; font-weight: 600">{KEY}Create owner with a passkey</button>'
 + '<div style="font-size: 12px; color: var(--text-meta)">Next: 10 recovery codes to save, and an optional password with a code as a fallback.</div>',360)
step=(f'<div role="dialog" aria-label="Confirm it is you" style="width: 380px; padding: 22px; {POP}; display: flex; flex-direction: column; gap: 14px">'
 '<h2 style="margin: 0; font-size: 18px; font-weight: 600">Confirm it is you</h2>'
 '<div style="font-size: 14px; color: var(--text-muted)">You are about to type into <span style="font-family: var(--mono); color: var(--amber)">worker-1</span>\'s terminal. Your last check was 34 minutes ago.</div>'
 f'<button style="{BIG}; border: 0; background: var(--orange); color: #1a1714; font-weight: 600">{KEY}Confirm with passkey</button>'
 f'<div style="display: flex; justify-content: space-between; font-size: 12px"><a href="#">Use a code instead</a><a href="#" style="color: var(--text-muted)">Cancel</a></div>'
 '<div style="font-size: 12px; color: var(--text-meta)">Asked again after 10 minutes for: Take control, Shell, Settings, security, Kill session, Remove agent.</div></div>')
codes=''.join(f'<span style="font-family: var(--mono); font-size: 14px">{c}</span>' for c in ['7HXQ-2KPL','R9TB-44MV','C3WZ-8NQA','PL6D-0YTE','M2KF-91XR','B8SU-Q5JG','W4NA-73CH','E1VZ-6PDK','T0YQ-J2LS','G5RM-8BWE'])
rec=card(head_('Save your recovery codes','Each code works once if you lose your passkey')+f'<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; padding: 14px; border-radius: 6px; background: var(--bg-inset)">{codes}</div>'
 + f'<div style="display: flex; gap: 8px"><button style="{BTN2}; flex: 1; justify-content: center">Copy</button><button style="{BTNP}; flex: 1; justify-content: center">I saved them</button></div>',360)
body=('<main style="flex: 1; padding: 28px 32px 40px; display: flex; flex-direction: column; gap: 24px">'
 '<div><h1 style="margin: 0; font-size: 22px; font-weight: 600">Sign-in states</h1><div style="font-size: 14px; color: var(--text-muted)">Part 12 · Internet access and sign-in. Pages before sign-in have no app header; the step-up dialog opens over the screen that asks for it.</div></div>'
 f'<div style="display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start">{cap_("First run: owner account",setup)}{cap_("After setup",rec)}{cap_("Fallback: password and code",pw)}{cap_("Locked after 5 failures",locked)}{cap_("Step-up: older than 10 minutes",step)}</div></main>')
open(P+'SignInStates.dc.html','w').write(bare('Sign-in states',1100,body))
# ---- Settings: add Security section
s=open(P+'Settings.dc.html').read()
if 'id="security"' not in s:
    row=lambda a,b: f'<div style="display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-top: 1px solid var(--line-soft)"><div style="min-width: 0">{a}</div><div style="flex: none; display: flex; gap: 8px; align-items: center">{b}</div></div>'
    lbl=lambda t,su='': f'<div style="font-size: 14px">{t}</div>'+(f'<div style="font-size: 12px; color: var(--text-meta)">{su}</div>' if su else '')
    B2=lambda t: f'<button style="{BTN2}">{t}</button>'
    sess=''.join(row(lbl(a,b),c) for a,b,c in [('This browser · Safari on macOS','Antwerp · signed in 09:12 · passkey','<span style="font-size: 12px; color: var(--green-strong)">current</span>'),('iPhone · paired device','last seen 20:51 · device session',B2('Remove')),('Firefox on Linux','Brussels · last seen yesterday 18:03',B2('Sign out'))])
    sec=(f'<section id="security" style="{CARD}; padding: 18px 20px; display: flex; flex-direction: column"><div style="display: flex; align-items: baseline; gap: 10px; padding-bottom: 6px"><h2 style="margin: 0; font-size: 18px; font-weight: 600">Security</h2><span style="font-size: 12px; color: var(--text-meta)">account michel · owner · internet mode on cubilot.kohaku.example</span></div>'
     + row(lbl('Passkeys','MacBook (Touch ID) · iPhone'),B2('Add passkey'))
     + row(lbl('Password and code','Fallback sign-in · authenticator app set'),B2('Change'))
     + row(lbl('Recovery codes','7 of 10 left'),B2('Make new codes'))
     + row(lbl('Typing into terminals from other devices','Off by default · asks for your passkey each time'),toggle(False,''))
     + '<div style="padding: 14px 0 4px; font-size: 14px; font-weight: 600">Sessions and devices</div>' + sess
     + row(lbl('Sign out all other sessions'),B2('Sign out others'))
     + row(lbl('Pair a phone','Shows a QR code with a one-time code'),B2('Show QR code'))
     + row(lbl('Sign-in log','2 failed sign-ins today · 1 lock'),B2('Open log'))
     + '</section>')
    s=s.replace('<section id="look"',sec+'<section id="look"',1)
    s=s.replace("<a href=\"#look\"","<a href=\"#security\" style=\"height: 34px; display: flex; align-items: center; padding: 0 10px; border-radius: 6px; text-decoration: none; color: var(--text-muted); font-size: 14px\">Security</a><a href=\"#look\"",1)
    s=s.replace('min-height: 1960px','min-height: 2560px').replace('"height":1960}','"height":2560}')
    open(P+'Settings.dc.html','w').write(s)
print('ok')
