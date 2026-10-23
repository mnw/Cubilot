# Part 15: ticket card and ticket dialog redesign

Status: the human asked on 2026-10-23 for this part to be built. Ready to split into tickets.
Date: 2026-10-23. File paths refer to the working tree on that date. `ui/kinds/ticket.js`, `ui/styles/kinds.css` and `ui/index.html` have uncommitted ticket-grouping changes. Build on top of them. Do not revert them.
Reader: the Orchestrator. Split this part into tickets. The section "Tickets" gives one ticket for each item, with acceptance criteria.
This part replaces T11, T12 and T13 of Part 14 ([14-ui-redesign.md](14-ui-redesign.md)). The other tickets of Part 14 do not change.

## Source

- Mockup: the page "Ticket card + dialog" on the human's claude.ai canvas. Agents cannot open it. This file is the specification.
- Images of the four screens, in `ui-redesign/` next to this file. Read them before you start:
  - `TicketBoard.png`: the board pane with cards in each state. Card 8.3a shows the hover and focus state.
  - `TicketDraft.png`: the dialog for a draft. It opens in edit mode.
  - `TicketReview.png`: the dialog for a ticket in review with a pending approval. It opens in read mode.
  - `TicketReviewEdit.png`: the same ticket after the human clicks Edit.
- The design source of each image is the `.dc.html` file with the same name. Read it for exact sizes, spacing and colours. Do not copy its code: it has inline styles and literal colour values.
- Some content in the images is invented: the second draft (8.4), the notes, the criteria text of 8.3b and its approval. The ticket "Example: export the room transcript as Markdown" is real.

## Problems with the current card and dialog

1. The board has five columns in a pane of about 770 px. Each card is about 150 px wide.
2. "Move to" and "Assignee" are two full-width selects on every card. They use half of the card height.
3. The meta line ("High · @Worker2 · GH-142 · r-2026-10-23-mockup · high radius") wraps in the middle of words.
4. "Cancel ticket" is a large button on every card, for a terminal action.
5. The dialog is one long column. Uppercase mono labels have the same weight as content. "Move to" is below the attachments and goes off the screen.
6. The title shows twice in a draft: as the heading and as the Title field.
7. "Blocked by" is a text field for ticket IDs separated by commas. A done blocker shows with a strikethrough.
8. A ticket that is not a draft or queued cannot be edited in the dialog. The hub allows it.

## Rules for this part

1. Obey `CLAUDE.md`. The UI stays vanilla HTML, CSS and JS. Do not add a framework or a build step.
2. Use the tokens in `ui/styles/tokens.css`. Do not write a colour value outside `tokens.css`. For tints, use `color-mix(in srgb, var(--token) N%, transparent)`.
3. If Part 14 ticket T01 is not done, add `--text-meta` first (Part 14, "Design tokens", change 1). Use it for meta text: times, counts, labels.
4. All three themes must work: `default`, `rose-pine-dawn`, `rose-pine-moon`.
5. Fonts: `--sans` (Inter) and `--mono` (JetBrains Mono). Font sizes: the `--fs-*` steps.
6. **Keep the traffic light.** The human requires it. Do not change `lightOf()`, `lightHtml()` or the `.ticket-light` CSS (`ticket.js:706-717`, `kinds.css:442-447`). Only its position on the card changes.
7. Keep the class names and ids that `tests/unit/ticket-board.test.ts` uses as hooks: `ticket-card`, `ticket-move`, `ticket-assign`, `ticket-light`, `ticket-cancel-btn`, `ticket-archive`, `ticket-file-remove`, `ticket-file-replace`, `ticket-view-*`, `ticket-edit-*`. Update the test expectations that check markup. Do not delete a test to make it pass.
8. Put new pure helpers in `ticket.js` and add them to the object that `TicketBoard` returns, as `lightOf` is today. Test them in `tests/unit/`.
9. Use real `<button>`, `<select>`, `<input>` and `<label>` elements. Every action must work from the keyboard. Text contrast must be 4.5:1 or more.
10. Do not commit. The human commits.

## Data that exists

Every field below is in the ticket snapshot today. No hub change is needed for this part.

| Field | Use |
|---|---|
| `title` | Parse the tag, the ID and the subtitle for display (ticket P1) |
| `acceptance_criteria` | Rendered markdown. Count `- [x]` and `- [ ]` lines for the progress (P1) |
| `status`, `assignee`, `creator`, `priority`, `blast_radius`, `external_ref`, `request_id` | Card and properties |
| `blocked_by`, `open_blockers` | Blocker list and "Blocked by N open tickets" (use `openBlockers()`) |
| `approval_request_id`, `approval` | Approval banner, Allow and Deny |
| `notes_count`, `attachments_count` | Card counters |
| `created_at_ms`, `updated_at_ms`, `archived_at_ms`, `id` | Properties panel |

Hub rules that the design depends on (`hub/kinds/ticket.ts`):

- `POST /tickets/:id/edit` accepts title, acceptance criteria, blast radius, priority, external ref, request and blockers from the human on every ticket that is not done or cancelled (`editTicketVerb`, line 387).
- New acceptance criteria or a blast radius of `low` clears `approval_request_id`, and the hub dismisses the pending request (`retireStaleApproval`).
- `POST /permissions/:id/verdict` with `{ by, behavior: "allow" | "deny" }` answers an approval. `handlePermissionAction()` in `ui/kinds/permission.js:118` already sends it.
- The hub refuses a blocker list that makes a loop. The error text contains "cycle". `ERROR_FIELDS` already maps it to the blockers field.

## Tickets

### P1. Pure helpers

Priority: Highest. Radius: low. Files: `ui/kinds/ticket.js`, `tests/unit/`.

1. `parseTitle(title)` returns `{ tag, code, main, sub }`.
   - `tag`: a leading `[word]`, without brackets, in lower case. Else `null`.
   - `code`: the next token when it matches `^\d+(\.\d+)*[a-z]?$` (for example `8.3a`). Else `null`.
   - `sub`: text in brackets at the end of the title, without brackets. Else `null`.
   - `main`: the rest, trimmed. When `main` is empty, return the full title as `main` and `null` for the other fields.
2. `criteriaProgress(markdown)` returns `{ done, total }` from lines that start with `- [x]`, `- [X]` or `- [ ]`.
3. `priorityBars(ticket)` returns 4 for Highest, 3 for High, 2 for Medium, 1 for Low, 0 for Lowest.
4. `statusLine(ticket)` returns the first match, or `null`:
   1. A pending approval: "Waiting for your approval".
   2. The assignee is the human: "Assigned to you".
   3. One or more open blockers: "Blocked by N open ticket(s)".
   4. Else `null`.

Acceptance criteria:
1. Unit tests cover each rule, including a title with no tag, a title with a tag and no code, and a title that is only a tag.
2. `statusLine()` never disagrees with `lightOf()`: when it returns the approval or the human line, `lightOf()` is red.

### P2. Collapse empty columns

Priority: High. Radius: low. Files: `ticket.js` (`render()`), `kinds.css`.

1. A column with no visible ticket shows as a 40 px strip: the count, a vertical label (`writing-mode: vertical-rl`) and "+".
2. The strip stays a drop target. Keep the `.ticket-col` element and its `data-status`.
3. A column with tickets takes the free width (`flex: 1 1 210px; min-width: 200px`). The board scrolls sideways when the columns do not fit.
4. Move the "+" from the bottom of the column to its header, at the right.
5. "Archive all done" stays in the Done header. It shows when Done has tickets.

Acceptance criteria:
1. With one ticket in Draft and the other four columns empty, the Draft column is at least 550 px wide in a 770 px pane.
2. A drag onto a collapsed column moves the ticket.

### P3. New card layout

Priority: High. Radius: low. Files: `ticket.js` (`cardHtml()`), `kinds.css`.
Image: `TicketBoard.png`.

From top to bottom:
1. **Top row** (mono, `--fs-xs`): the tag as a chip in upper case (`--amber` tint for `code`, neutral for other tags), the code in `--text-meta`, and at the right the priority bars (P1) and label.
2. **Title**: `parseTitle().main`, `--fs-xl`, weight 600. Below it, `sub` in `--text-muted` when it exists.
3. **Chips** (mono, `--fs-xs`, wrap): request (with a layers icon), external ref, and "High radius" (red tint) when the radius is high. A chip truncates with an ellipsis. It never breaks inside a word.
4. **Status line** (`statusLine()`), when it is not `null`. Amber with a lock icon for blockers. Red-strong with a clock icon for the approval.
5. **Footer**, with a top border: assignee (an 18 px circle with the initial, and the name in mono), or "Unassigned" in italics. At the right: the criteria progress `done/total` (only when `total > 0`), the attachment count and the note count (each only when it is above 0). Then the traffic light, last.

Remove from the card:
- The "Acceptance criteria" `<details>` and the "Notes" `<details>`. They are in the dialog.
- The 3 px orange left border of `.radius-high`. The "High radius" chip replaces it.
- The always-visible "Move to", "Assignee" and "Cancel ticket" controls (P4 brings them back on hover).

Keep: `role="button"`, `tabindex="0"`, `draggable` on movable cards, `aria-label="Open ticket: …"`, the `archived` style.

Acceptance criteria:
1. A card with a one-line title and no request, ref, status line or counters is at most 130 px high at 210 px width.
2. The meta line no longer exists. No chip breaks inside a word.
3. The traffic light gives the same result as before for every status.

### P4. Card actions on hover and keyboard focus

Priority: High. Radius: low. Files: `ticket.js`, `kinds.css`.
Image: card 8.3a in `TicketBoard.png`.

1. When the card has `:hover` or `:focus-within`:
   - The assignee name in the footer becomes the existing `.ticket-assign` select (mono, small, max 104 px).
   - A row below the footer shows the `.ticket-move` select (full width) and a 26 px icon button for Cancel ticket (`aria-label="Cancel ticket <title>"`).
2. Hide the controls with `visibility: hidden` and `height: 0` when the card has no hover and no focus. Do not use `display: none`. Focus on the card shows them, and then Tab reaches them.
3. Cancel keeps the arm-then-confirm rule (`cancelArmed`, 5 s). In the armed state, show the text "Confirm" next to the icon.
4. A click on a control does not open the dialog (as today).

Acceptance criteria:
1. Keyboard path: Tab to the card, then Tab to Assignee, Move and Cancel.
2. The "In review" label in the Move select is not cut off at 210 px card width.

### P5. Dialog shell

Priority: High. Radius: low. Files: `ui/index.html` (`#ticket-view`), `ticket.js` (`viewHtml()`, `drawView()`), `kinds.css`.
Images: `TicketDraft.png`, `TicketReview.png`.

1. Three parts: a header, a body that scrolls, and a footer. Only the body scrolls.
2. **Header**: the tag chip and code, a status pill, the traffic light with its label (the second value of `lightOf()`), and at the right the Edit button (P6) and a Close icon button (`aria-label="Close"`). Below: the title (`--fs-6xl`, weight 600) and `sub`.
3. **Body**: two columns. Left (`flex: 999 1 380px`): approval banner (P9), acceptance criteria, blocked by, attachments, notes. Right (`flex: 1 1 220px`): the properties panel. With `flex-wrap: wrap`, the panel moves above the content when the dialog is narrower than about 600 px.
4. **Properties panel**: Status (the existing Move control), Assignee, Priority, Blast radius, Request, External ref. Then a rule, then Created ("date by creator"), Updated (only when it differs from Created), Archived (when set), and the ID in mono with a copy button.
5. Status and Assignee change at once, as today. In read mode, the other properties are text.
6. **Footer**: "Cancel ticket" at the left (red-strong text and border, arm-then-confirm). "Archive" or "Unarchive" for finished tickets. At the right: the unsaved-changes notice, Close, and Save (P6).
7. Section headings: sentence case, `--fs-xl`, weight 600, with a count in `--text-meta`. No uppercase mono labels.
8. Status pill colours: Draft neutral with a dashed dot. Queued `--blue` tint. In progress `--amber` tint. In review `--purple` tint. Done `--green` tint. Cancelled `--red` tint.
9. Keep: `showModal()`, the position over the board pane, focus on Close at open, focus back to the card at close, `requestClose()` for Escape and the backdrop.

Acceptance criteria:
1. Close, Cancel ticket and Save are visible at every scroll position.
2. The title shows once.
3. In a 500 px wide pane, the properties panel is above the content and nothing scrolls sideways.

### P6. Read mode, edit mode and the Edit button

Priority: High. Radius: high (changes what the human can edit). Files: `ticket.js` (`editable()`, `formValues()`, `diffOf()`, `requestFormHtml()`, `wireRequestForm()`), `kinds.css`.
Images: `TicketReview.png` (read mode), `TicketReviewEdit.png` (edit mode), `TicketDraft.png` (draft).

1. Add a view mode: `read` or `edit`.
   - A draft opens in `edit`. It has no Edit button.
   - Queued, claimed, in progress and in review tickets open in `read`, with an Edit button in the header.
   - Done and cancelled tickets have no Edit button. The hub refuses edits on them.
2. Edit unlocks: title (in the header, as an input with the full raw title, including the tag), acceptance criteria (P7), priority, blast radius (a Low and High radio pair), request, external ref and blockers (P8).
3. In edit mode:
   - An "Editing" pill shows in the header.
   - Status shows as text, with "Move the ticket after you save." Assignee stays a select. Save sends it with the other changes, through `/assign`.
   - The footer shows "Discard changes" at the left, instead of "Cancel ticket". At the right: "N unsaved changes" and Save. Save is the only primary button.
   - "Discard changes" leaves edit mode and drops `viewDraft`. For a draft, it resets the fields.
   - Close with changes asks first, as today (`requestClose()`).
4. When the ticket has a pending approval, edit mode shows a warning above the content: "This ticket waits for your approval. If you save new acceptance criteria or set the blast radius to low, <assignee>'s approval request is cancelled."
5. Extend `diffOf()` and `formValues()` to all fields for every editable status. Keep: only changed fields are sent, typed values survive a redraw, errors show under their field.

Acceptance criteria:
1. The human edits the title and priority of an in-review ticket, saves, and the card shows the new values.
2. A done ticket has no Edit button.
3. With a pending approval, saving new criteria clears the approval. The card light is no longer red, unless the human is the assignee.
4. Existing draft and queued tests still pass, after their markup expectations are updated.

### P7. Acceptance criteria: Write and Preview

Priority: Medium. Radius: low. Files: `ticket.js`, `kinds.css`.

1. In edit mode: two tabs, Write and Preview (`role="tablist"`). Write shows the existing toolbar and textarea (`#ticket-edit-criteria`, mono). Preview shows `mdHtml()` of the current text.
2. In read mode: the rendered criteria. Show a checklist item as a 15 px box: filled `--green` with a check when done, an outline when not.
3. The heading shows "N of M checked" from `criteriaProgress()` when M is above 0.

Acceptance criteria:
1. Preview shows the typed text before Save.
2. The progress count matches the checklist lines.

### P8. Blocker list and picker

Priority: Medium. Radius: low. Files: `ticket.js` (`blockersHtml()`, the form), `kinds.css`.
Images: `TicketDraft.png` (list), `TicketReviewEdit.png` (picker open).

1. Show each blocker as a row: a status icon (green check when done, amber lock when open), the code, the title (ellipsis), a status pill, and in edit mode a remove button (`aria-label="Remove blocker <code or title>"`).
2. A done blocker shows "Done" with a check. Remove the strikethrough.
3. A blocker the board does not hold shows its id and "open" or "done" from `open_blockers`, as today.
4. In edit mode, "Add blocker" opens a search field (ARIA combobox pattern: `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, a `role="listbox"` list).
5. The list holds the tickets of the board's room. It leaves out the ticket itself and the blockers it already has. Match the typed text against the code and the title. Open tickets first.
6. Keyboard: Up and Down move, Enter adds, Escape closes.
7. The blocker list replaces the comma-separated input. Keep the id `ticket-edit-blockers` on the element that holds the list, so the error mapping still works. Save sends the ids as today.

Acceptance criteria:
1. The human adds a blocker with the keyboard only.
2. A loop is refused with the hub's message under the blocker list.

### P9. Approval in the dialog

Priority: Medium. Radius: high (approval gate). Files: `ticket.js` (`approvalHtml()`), `kinds.css`.
Image: `TicketReview.png`.

1. When `t.approval?.status === 'pending'`, show a banner at the top of the body: "Waiting for your approval. <assignee> asks to move this high-radius ticket to Done." Add Deny and Allow buttons.
2. Allow and Deny call `handlePermissionAction(t.approval_request_id, 'allow' | 'deny')`. Disable both buttons while the call runs.
3. Other approval states (approved, not your approval) show one line of text, as `approvalHtml()` does today.
4. The permission card in the chat stays. Both places answer the same request.

Acceptance criteria:
1. Allow in the dialog records the human's verdict. The chat card shows the same verdict.
2. An answer from the chat card removes the banner from an open dialog.

### P10. Attachments and notes

Priority: Low. Radius: low. Files: `ticket.js` (`filesHtml()`, `fileItemHtml()`, `notesHtml()`), `ui/index.html` (`.ticket-view-attach`), `kinds.css`.

1. Attachments: one row for each file: thumbnail (44 px) or extension, name link, "author · date", and two 30 px icon buttons for Replace and Remove with `aria-label`. Remove keeps arm-then-confirm.
2. Below the list: a dashed drop area "Drop files here or browse · pdf, md, txt, png, jpg · up to 8 MB". "browse" opens `#ticket-view-file`. A drop on the area attaches the files with `attachFiles()`.
3. Notes: newest first. Author in mono and role colour, then the time. Show three. "Show all N notes" shows the rest.
4. No notes: "No notes yet. Agents add notes while they work on the ticket."

Acceptance criteria:
1. A file dropped on the area is attached.
2. A ticket with eight notes shows three, and all eight after "Show all 8 notes".

## Build order

1. P1.
2. P2, P3, P4.
3. P5, then P6.
4. P7, P8, P9, P10.

## Tests

1. Unit tests for P1.
2. Update `tests/unit/ticket-board.test.ts` for the new markup. Keep the hooks in rule 7.
3. Manual checks, in all three themes:
   - the board with one ticket, and with tickets in every column
   - the hover and keyboard paths on a card
   - a draft, a queued, an in-progress, an in-review and a done ticket in the dialog
   - edit mode with and without a pending approval
   - the dialog at a board pane width of 500 px and of 900 px

## Open questions for the human

1. Should the New ticket dialog (`#ticket-modal`) use the same layout as the draft dialog? This part does not change it.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
