# Part 6: live check by the human

Run this after the install that holds all of Part 6 (P6-02, P6-08, P6-15 and t_d9ef merged). About 30 minutes. Each step: do exactly what it says, compare with "Expect", tick PASS or FAIL. Do not interpret: if the output differs from "Expect", it is a FAIL. Write the step number and the output in the FAIL line and go on with the next step.

The Orchestrator checks every command of this file against the installed build before you start (read-only commands run, write commands checked for route and body), and fixes this file if a route or field name differs. Lines marked `[ORCH]` are filled in by him.

Arbiter steps are not in this check: the arbiter is in the backlog (decision 2026-10-30).

## 0. Setup (one terminal, keep it open for all steps)

0.1 Do: paste
```
D="$HOME/Library/Application Support/Cubilot"; U=$(cat "$D/hub.url"); T=$(cat "$D/hub.token"); H() { curl -s -H "Authorization: Bearer $T" -H "Content-Type: application/json" "$@"; }
H "$U/rooms/cubilot/settings" | jq -c .settings.role_limits
```
Expect: one line like `{"worker":4,"tester":2,"validator":3,...}`. Write it down here: ____________________
[ ] PASS [ ] FAIL

0.2 Do: stop new stages during the test, so no agent starts work on the test tickets:
```
H -X PUT "$U/rooms/cubilot/settings" -d '{"role_limits":{"worker":0,"tester":0,"validator":0}}' | jq -c .settings.role_limits
```
Expect: `"worker":0,"tester":0,"validator":0`.
[ ] PASS [ ] FAIL

## 1. One Approve per request (P6-02, L1, L2)

1.1 Do: create the test request and two draft tickets:
```
R=r-live-check-$(date +%Y%m%d-%H%M)
H -X POST "$U/requests" -d "{\"by\":\"human\",\"room\":\"cubilot\",\"request_id\":\"$R\",\"title\":\"Live check Part 6\"}" | jq -c .   # [ORCH] body
for n in 1 2; do H -X POST "$U/tickets" -d "{\"by\":\"human\",\"room\":\"cubilot\",\"request_id\":\"$R\",\"status\":\"draft\",\"role\":\"worker\",\"title\":\"[code] Live check ticket $n\",\"acceptance_criteria\":\"Given nothing, when nothing, then nothing.\",\"blast_radius\":\"low\"}" | jq -r '.snapshot.id // .id // .'; done
```
Expect: the request answer has no `error`. Then two ticket ids (`t_…`). Write them down: A = __________ B = __________
[ ] PASS [ ] FAIL

1.2 Do: `A=<id A>; B=<id B>` (paste the ids), then approve once:
```
H -X POST "$U/requests/cubilot/$R/approve" -d '{"by":"human"}' | jq -c .
```
Expect: `"queued":[` with both ids, `"not_queued":[]`.
[ ] PASS [ ] FAIL

1.3 Do: edit the criteria of A:
```
H -X POST "$U/tickets/$A/edit" -d '{"by":"human","acceptance_criteria":"Given a live check, when the criteria change, then the ticket stays queued."}' | jq -r '.snapshot.status // .status'
```
Expect: `queued` (not `draft`).
[ ] PASS [ ] FAIL

1.4 Do: add a third ticket C to the same request:
```
C=$(H -X POST "$U/tickets" -d "{\"by\":\"human\",\"room\":\"cubilot\",\"request_id\":\"$R\",\"status\":\"draft\",\"role\":\"worker\",\"title\":\"[code] Live check ticket 3\",\"acceptance_criteria\":\"Given nothing, when nothing, then nothing.\",\"blast_radius\":\"low\"}" | jq -r '.snapshot.id // .id'); echo $C
```
Expect: a ticket id. In the app, the Approve card of the request names ticket 3 as new since the last Approve. It does not start without an Approve.
[ ] PASS [ ] FAIL

1.5 Do: approve again: `H -X POST "$U/requests/cubilot/$R/approve" -d '{"by":"human"}' | jq -c .`
Expect: `"queued":["<C>"]`.
[ ] PASS [ ] FAIL

## 2. Radius by rule (P6-03)

2.1 Do: create a ticket whose title names a launch, asked as low:
```
X=$(H -X POST "$U/tickets" -d "{\"by\":\"human\",\"room\":\"cubilot\",\"request_id\":\"$R\",\"status\":\"draft\",\"role\":\"worker\",\"title\":\"[code] Live check: launch a session\",\"acceptance_criteria\":\"Given nothing, when nothing, then nothing.\",\"blast_radius\":\"low\"}"); echo "$X" | jq -c '{id:(.snapshot.id // .id), radius:(.snapshot.blast_radius // .blast_radius), source:(.snapshot.radius_source // .radius_source)}'
```
Expect: `radius":"high"` and `source":"rule"`. In the app, its card shows the radius source "rule".
[ ] PASS [ ] FAIL

## 3. High ticket closes on two PASSes, no Allow (L4, P6-04, t_7e3d, t_739f, t_2a66)

Uses a real high ticket that merged last night: t_739fbe56aa911c01.

3.1 Do: `H "$U/tickets?room=cubilot&status=all" | jq -c '.[] | select(.id=="t_739fbe56aa911c01") | {status, blast_radius}'`
Expect: `{"status":"done","blast_radius":"high"}`.
[ ] PASS [ ] FAIL

3.2 Do: `H "$U/tickets/t_739fbe56aa911c01/merge-message"; echo`
Expect: one line `Merge ticket/t_739fbe56aa911c01: …` that names two PASS ids (`h_…` twice).
[ ] PASS [ ] FAIL

3.3 Do: `H "$U/permissions?status=pending" | jq '[.[] | select(.tool_name|test("done"))] | length'`   # [ORCH] route
Expect: `0` (no Allow is asked for a done move).
[ ] PASS [ ] FAIL

3.4 Do: in the app, open the Flow board and find t_739f in Done.
Expect: the card shows two PASS marks and no Allow button.
[ ] PASS [ ] FAIL

## 4. Delivery report (P6-08)

4.1 Do: `H "$U/requests/cubilot/r-2026-10-29-lean-flow/delivery" | jq -c '{tickets:(.tickets|length), merges:[.tickets[].merge_commit], high:[.high_radius[]?.ticket_id]}'`   # [ORCH] field names
Expect: 4 tickets (L1 to L4), each with a merge commit (no `null`), and the high-radius list names all 4.
[ ] PASS [ ] FAIL

4.2 Do: `H "$U/requests/cubilot/$R/delivery" | jq '.criteria_edits'`   # [ORCH] field name
Expect: one entry for ticket A with both texts: the old "Given nothing…" and the new "Given a live check…".
[ ] PASS [ ] FAIL

## 5. A question from the Orchestrator reaches you, your answer reaches him (P6-01)

5.1 Do: `H -X POST "$U/send" -d '{"target":"Orchestrator","room":"cubilot","text":"LIVE CHECK 5: escalate one test question to me now with the escalate tool: block \"live check\", two options A and B, recommend A. Do nothing else."}' | jq -c .`
Expect: no `error`. Within 2 minutes, the Decisions view has one new line "live check" with buttons A and B.
[ ] PASS [ ] FAIL

5.2 Do: click B.
Expect: the line leaves Needs you. Within 2 minutes the Orchestrator writes in the Room that he got answer B.
[ ] PASS [ ] FAIL

## 6. Waits-for-you list (P6-15c)

6.1 Do: in the app, open the "Waits for you" panel.
Expect: ticket X (step 2.1, high, not approved) is listed with what it waits for.
[ ] PASS [ ] FAIL

## 7. Context use in the agent column (P6-11)

7.1 Do: in the app, look at the Agents column, row Orchestrator.
Expect: a percentage (for example `42 %`), not `–`.
[ ] PASS [ ] FAIL

## 8. Flow report (item 9, t_d9ef)

8.1 Do: `H "$U/rooms/cubilot/flow" | jq -c 'keys'`   # [ORCH] route and keys
Expect: keys for slot use per role, ready tickets, wait reasons and FAIL rates; no `error`.
[ ] PASS [ ] FAIL

## 9. Trust boundary in the role files (t_1316)

9.1 Do: `grep -l -i "untrusted" "$D"/factory/active/{validator,tester}/role.md`
Expect: both file paths are printed.
[ ] PASS [ ] FAIL

## 10. Checkpoint of the Orchestrator (P6-15, t_e948)

Do this step last, when the Orchestrator is between tasks.

10.1 Do: `H -X POST "$U/checkpoints" -d '{"by":"human","room":"cubilot"}' | jq -c .`   # [ORCH] body
Expect: a checkpoint id and status `noting`.
[ ] PASS [ ] FAIL

10.2 Do: wait 3 minutes, then `H "$U/checkpoints?room=cubilot" | jq -c '.[-1] | {status, pct_before, pct_after}'`   # [ORCH] route and fields
Expect: `status":"done"`, and pct_after lower than pct_before. In his pane, the Orchestrator's context was cleared, and his first message after it starts with the state summary.
[ ] PASS [ ] FAIL

10.3 Do: `H -X POST "$U/send" -d '{"target":"Orchestrator","room":"cubilot","text":"LIVE CHECK 10: in one line, which tickets are in review now?"}' > /dev/null`
Expect: his answer names the tickets that the board shows in review.
[ ] PASS [ ] FAIL

## 11. Clean up

11.1 Do:
```
for t in $A $B $C $(echo "$X" | jq -r '.snapshot.id // .id'); do H -X POST "$U/tickets/$t/transition" -d '{"by":"human","to":"cancelled"}' | jq -r '.snapshot.status // .status'; done
```
Expect: `cancelled` four times.
[ ] PASS [ ] FAIL

11.2 Do: restore the limits you wrote down in 0.1:
```
H -X PUT "$U/rooms/cubilot/settings" -d '{"role_limits":{"worker":4,"tester":2,"validator":3}}' | jq -c .settings.role_limits
```
Expect: the same numbers as in 0.1.
[ ] PASS [ ] FAIL

## Result

All PASS: Part 6 is accepted. Merge staging into main.
Any FAIL: send the Orchestrator the step numbers and outputs. A FAIL in 1, 3, 5 or 9 stops the merge into main. A FAIL elsewhere becomes a ticket, and the merge can go ahead.
