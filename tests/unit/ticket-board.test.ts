import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Runs the production ui/kinds/ticket.js against a fake hub list. Checks that the
// permission preview's ticket_id is only a hint: an approval reaches a ticket only when
// its request id equals the ticket's current approval_request_id.
const SRC = readFileSync("ui/kinds/ticket.js", "utf8");
const settle = () => new Promise((r) => setTimeout(r, 0));

let list: any[];
let fetches: number;
let ctx: vm.Context;
let formSubmit: ((e: any) => Promise<void>) | null;
let postOk: boolean;
let gate: Promise<void> | null;
let posts: Array<{ path: string; body: any }>;
let postGate: Promise<void> | null;
let failPath: string | null;
let attachReplyId: number | null;
let refuseText = "upload refused";
let cols: { innerHTML: string; querySelectorAll: (sel: string) => any[] };
let observers: Record<string, (e: any) => void>;   // what the board registered with KindCardRenderer
let bodyClasses: Set<string>;
let attachmentsOnHub: Record<string, any[]>;   // GET /tickets/:id/attachments
let attachFetches: string[];
let uploads: string[];                              // file names POSTed to /upload
let uploadFails: boolean;
let notesOnHub: Record<string, any[]>;   // GET /tickets/:id/notes
let notesFetches: string[];
let docListeners: Record<string, Array<(e: any) => void>>;   // document.addEventListener
let mdButtons: any[];                // the criteria toolbar buttons
let active: any;                  // document.activeElement
let found: (selector: string) => any;   // document.querySelector
let messages: any[];                // addMessage calls
let store: Map<string, string>;   // fake localStorage
let els: Record<string, any>;     // extra elements by id (dialog, assignee select)

const ticket = (pointer: string, approval: any) => ({
  id: "t_1", room: "r", title: "T", acceptance_criteria: "c", blast_radius: "high", priority: "medium",
  creator: "a", assignee: "a", approval_request_id: pointer, external_ref: null,
  status: "in_review", created_at_ms: 1, updated_at_ms: 1, version: 5, approval,
});
const perm = (id: string, status: string, version: number, resolved_by: string | null = "human") => ({
  kind: "permission.resolved", permission_id: id, version,
  snapshot: { id, tool_name: "ticket:done", input_preview: JSON.stringify({ ticket_id: "t_1" }), status, resolved_by, version },
});
const draft = () => ({
  title: { value: "T" }, criteria: { value: "c" }, radius: { value: "high" }, priority: { value: "medium" },
  external_ref: { value: "" }, reset: () => {},
});
const paths = () => posts.map((p) => [p.path, p.body.to ?? null]);
const approvalOf = () => ctx.TicketBoard._tickets.get("t_1").approval;

beforeEach(async () => {
  list = [ticket("abcde", { id: "abcde", status: "pending", resolved_by: null })];
  fetches = 0;
  formSubmit = null;
  postOk = true;
  gate = null;
  posts = [];
  postGate = null;
  failPath = null;
  attachReplyId = null;
  refuseText = "upload refused";
  cols = { innerHTML: "", querySelectorAll: () => [] };
  store = new Map();
  messages = [];
  observers = {};
  notesOnHub = {};
  attachmentsOnHub = {};
  attachFetches = [];
  uploads = [];
  uploadFails = false;
  notesFetches = [];
  docListeners = {};
  mdButtons = [];
  active = null;
  bodyClasses = new Set();
  found = () => null;
  const control = (extra: object = {}) => {
    const c: any = { value: "all", checked: true, textContent: "", handlers: {} as Record<string, (e?: any) => void>, ...extra };
    c.addEventListener = (type: string, fn: (e?: any) => void) => { c.handlers[type] = fn; };
    return c;
  };
  els = { "ticket-filter-reset": control(), "ticket-filter-summary": control() };
  for (const v of ["all", "high", "low"]) els[`ticket-filter-radius-${v}`] = control({ value: v, checked: v === "all", focus() { active = this; } });
  // The Filters button and its panel (hidden until opened), the Done button.
  const classes = new Set<string>();
  els["ticket-filters-btn"] = control({ textContent: "Filters", attrs: {} as Record<string, string>, classes,
    classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
    setAttribute(k: string, v: string) { this.attrs[k] = v; }, focus() { active = this; }, contains(n: any) { return n === this; } });
  els["ticket-filter-panel"] = control({ hidden: true, contains(n: any) { return !!n?.inPanel; } });
  els["ticket-filter-done"] = control();
  for (const k of ["highest", "high", "medium", "low", "lowest"]) els[`ticket-filter-p-${k}`] = control();
  els["ticket-lead"] = control({ value: "", innerHTML: "", disabled: false });
  els["ticket-lead-wrap"] = control({ hidden: true });
  els["ticket-show-archived"] = control({ checked: false });
  els["ticket-show-cancelled"] = control({ checked: false });
  // The ticket view: a dialog, its title, content and action areas, and the Close button.
  els["ticket-view"] = control({ open: false, style: {}, showModal() { this.open = true; }, close() { if (this.open) { this.open = false; this.handlers.close?.(); } } });
  els["ticket-view-title"] = control({ textContent: "", innerHTML: "" });
  els["ticket-view-head-meta"] = control({ innerHTML: "" });                  // 15.5: tag chip, code, status pill, light and its label
  els["ticket-view-sub"] = control({ textContent: "", hidden: true });
  els["ticket-view-notes"] = control({ innerHTML: "" });                         // 15.6: the notes sit below the Attach block
  els["ticket-view-edit"] = control({ hidden: true });                            // 15.6: the Edit button
  els["ticket-view-dirty"] = control({ textContent: "", hidden: true });          // 15.6: "N unsaved changes"
  els["ticket-view-x"] = control({ focus() { active = this; } });                                        // the header's Close icon button
  els["ticket-view-content"] = control({ innerHTML: "" });
  els["ticket-view-actions"] = control({ innerHTML: "", queried: [] as string[], contains: () => false, querySelector: () => null,
    querySelectorAll(sel: string) { this.queried.push(sel); return []; } });
  els["ticket-new-btn"] = control({});
  els["ticket-view-drop"] = (() => { const cls = new Set<string>(); return control({ cls, classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c) } }); })();                                         // 15.10: the dashed drop area
  els["ticket-view-close"] = control({ focus() { active = this; } });
  // The bottom row: a slot for Cancel ticket / Archive, and the Save button (hidden unless the ticket is editable).
  els["ticket-view-row-actions"] = control({ innerHTML: "", queried: [] as string[], contains: () => false, querySelector: () => null,
    querySelectorAll(sel: string) { this.queried.push(sel); return []; } });
  els["ticket-view-save"] = control({ hidden: true, disabled: true });
  // The line above the action row ("Unsaved changes" with Discard and Keep editing, or the hub's refusal) and the Replace picker.
  const noticeButtons: Record<string, any> = {};
  els["ticket-view-notice"] = control({ innerHTML: "", querySelector(sel: string) {
    const id = sel.slice(1);
    return (this.innerHTML as string).includes(`id="${id}"`) ? (noticeButtons[id] ??= control({ id })) : null;
  } });
  els["ticket-view-replace"] = control({ files: [] as any[], value: "x", clicks: 0, click() { this.clicks++; } });
  // The criteria toolbar: four buttons with data-md, and the field they edit.
  for (const a of ["bold", "bullet", "checklist", "code"]) mdButtons.push(control({ dataset: { md: a } }));
  els["ticket-f-criteria"] = control({ value: "", selectionStart: 0, selectionEnd: 0 });
  // Attach controls: the view's button, file input and status; the popup's button, file input and list.
  els["ticket-view-attach-btn"] = control({ clicks: 0, click() { this.clicks++; } });
  els["ticket-view-file"] = control({ files: [] as any[], value: "x", clicks: 0, click() { this.clicks++; } });
  els["ticket-view-attach-status"] = control({ textContent: "" });
  els["ticket-f-attach-btn"] = control({ clicks: 0, click() { this.clicks++; } });
  els["ticket-f-files"] = control({ files: [] as any[], value: "x", clicks: 0, click() { this.clicks++; } });
  els["ticket-f-file-list"] = control({ innerHTML: "" });
  ctx = vm.createContext({
    SELECTED_ROOM: "r", ROOM_ALL: "__ALL__", HUMAN_NAME: "human",
    ROSTER: [
      { name: "alice", room: "r" }, { name: "bob", room: "r" },
      { name: "human", room: null }, { name: "carol", room: "other" },
    ],
    escHtml: String, escAttr: String, addMessage: (m: any) => messages.push(m), parseErrorBody: async () => refuseText,
    IMAGE_EXT_RE: /\.(png|jpe?g|gif|webp)$/i,
    imgUrl: (u: string) => `http://hub${u}?token=T`,
    FormData: class { file: any; append(_k: string, v: any) { this.file = v; } },
    console, setTimeout, clearTimeout,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    },
    document: {
      getElementById: (id: string) =>
        id === "ticket-board-columns" ? cols :
        els[id] ? els[id] :
        id === "ticket-new-form" ? { addEventListener: (_t: string, fn: any) => { formSubmit = fn; } } : null,
      addEventListener: (type: string, fn: (e: any) => void) => { (docListeners[type] ??= []).push(fn); },
      get activeElement() { return active; },
      querySelectorAll: (sel: string) => (sel === ".md-toolbar [data-md]" ? mdButtons : []),
      body: { classList: { contains: (c: string) => bodyClasses.has(c), toggle: (c: string, on: boolean) => (on ? bodyClasses.add(c) : bodyClasses.delete(c)) } },
      querySelector: (sel: string) => found(sel),
    },
    KindCardRenderer: { observe: (prefix: string, fn: (e: any) => void) => { observers[prefix] = fn; } },
    authedFetch: async (_path: string, init?: any) => {
      if (init?.method === "POST" && _path === "/upload") {
        uploads.push(init.body.file.name);
        if (uploadFails) return { ok: false, json: async () => ({}) };
        const ext = init.body.file.name.slice(init.body.file.name.lastIndexOf("."));
        return { ok: true, json: async () => ({ url: `/image/u${uploads.length}${ext}` }) };
      }
      if (init?.method === "POST") {
        posts.push({ path: _path, body: JSON.parse(init.body) });
        if (postGate && (_path === "/tickets" || _path.startsWith("/rooms/"))) await postGate;
        return { ok: postOk && _path !== failPath, json: async () => (_path === "/tickets" ? { snapshot: { id: "t_new" } } : attachReplyId != null && _path.endsWith("/attachments") ? { attachment: { id: attachReplyId } } : {}) };
      }
      const attachRoute = /^\/tickets\/([^/]+)\/attachments$/.exec(_path);
      if (attachRoute) {
        attachFetches.push(decodeURIComponent(attachRoute[1]));
        return { ok: true, json: async () => [...(attachmentsOnHub[decodeURIComponent(attachRoute[1])] ?? [])] };
      }
      const noteRoute = /^\/tickets\/([^/]+)\/notes$/.exec(_path);
      if (noteRoute) {
        notesFetches.push(decodeURIComponent(noteRoute[1]));
        return { ok: true, json: async () => notesOnHub[decodeURIComponent(noteRoute[1])] ?? [] };
      }
      fetches++;
      const snapshot = list;                 // the hub answers with the state at read time
      if (gate) await gate;
      return { ok: true, json: async () => snapshot };
    },
  });
  vm.runInContext(SRC.replace("const TicketBoard =", "globalThis.TicketBoard ="), ctx);
  await ctx.TicketBoard.load();
});

describe("ticket board approval binding", () => {
  test("an unrelated request naming the ticket does not replace the current approval", async () => {
    expect(ctx.TicketBoard.onPermission(perm("zzzzz", "allowed", 9))).toBe("reload");
    await settle();
    expect(approvalOf()).toMatchObject({ id: "abcde", status: "pending" });
  });

  test("a late event of a superseded request does not replace the new approval", async () => {
    list = [ticket("fghij", { id: "fghij", status: "pending", resolved_by: null })];
    await ctx.TicketBoard.load();                     // pointer moved to fghij
    ctx.TicketBoard.onPermission(perm("abcde", "allowed", 9));
    await settle();
    expect(approvalOf()).toMatchObject({ id: "fghij", status: "pending" });
    const before = fetches;
    expect(ctx.TicketBoard.onPermission(perm("abcde", "allowed", 10))).toBe("ignored");  // no reload loop
    expect(fetches).toBe(before);
  });

  test("the current request's verdict is applied, and an older version is not", () => {
    expect(ctx.TicketBoard.onPermission(perm("abcde", "allowed", 7))).toBe("applied");
    expect(approvalOf()).toMatchObject({ id: "abcde", status: "allowed", resolved_by: "human" });
    expect(ctx.TicketBoard.onPermission(perm("abcde", "pending", 6))).toBe("ignored");
    expect(approvalOf().status).toBe("allowed");
  });

  test("a ticket event with an older version is ignored", () => {
    ctx.TicketBoard.onTicket({ ticket_id: "t_1", version: 4, snapshot: { ...ticket("abcde", null), status: "queued", version: 4 } });
    expect(ctx.TicketBoard._tickets.get("t_1").status).toBe("in_review");
  });

  test("a delayed list read does not roll back a newer ticket event", async () => {
    const stale = list;                      // list read taken before the event
    ctx.TicketBoard.onTicket({ ticket_id: "t_1", version: 6, snapshot: { ...ticket("abcde", null), status: "done", version: 6 } });
    list = stale;                            // the delayed read now lands
    await ctx.TicketBoard.load();
    expect(ctx.TicketBoard._tickets.get("t_1")).toMatchObject({ status: "done", version: 6 });
  });

  test("a delayed list read does not roll back a newer approval verdict", async () => {
    ctx.TicketBoard.onPermission(perm("abcde", "allowed", 8));
    list = [ticket("abcde", { id: "abcde", status: "pending", resolved_by: null, version: 3 })];
    await ctx.TicketBoard.load();
    expect(approvalOf()).toMatchObject({ id: "abcde", status: "allowed", version: 8 });
  });

  test("a verdict that arrives during the first list read is applied after the read", async () => {
    ctx.TicketBoard._tickets.clear();        // first load: no cached ticket
    let release!: () => void;
    gate = new Promise((r) => { release = r; });
    const loading = ctx.TicketBoard.load();  // reads the pending approval, then waits
    await settle();
    expect(ctx.TicketBoard.onPermission(perm("abcde", "allowed", 8))).toBe("deferred");
    release();
    await loading;
    expect(approvalOf()).toMatchObject({ id: "abcde", status: "allowed", version: 8 });
  });

  test("the create form keeps its input after a failure and resets after success", async () => {
    let resets = 0;
    const field = (value: string) => ({ value });
    const form = {
      title: field("T"), criteria: field("must pass"), radius: field("low"), priority: field("medium"),
      external_ref: field(""), reset: () => { resets++; },
    };
    postOk = false;
    await formSubmit!({ preventDefault: () => {}, target: form });
    expect(resets).toBe(0);
    postOk = true;
    await formSubmit!({ preventDefault: () => {}, target: form });
    expect(resets).toBe(1);
  });

  test("a ticket saved from a column's + is created in that column with ONE call", async () => {
    const form = {
      title: { value: "T" }, criteria: { value: "c" }, radius: { value: "high" }, priority: { value: "medium" },
      external_ref: { value: "" }, reset: () => {},
    };
    for (const [col, status] of [["draft", "draft"], ["queued", "queued"], ["progress", "in_progress"], ["review", "in_review"], ["done", "done"]]) {
      posts = [];
      ctx.TicketBoard.openNew(col);
      await formSubmit!({ preventDefault: () => {}, target: form });
      expect(posts.map((p) => p.path)).toEqual(["/tickets"]);          // no claim, no transition
      expect(posts[0].body.status).toBe(status);
    }
    posts = [];
    ctx.TicketBoard.openNew("queued");
    await Promise.all([                      // a double click on Save creates one ticket
      formSubmit!({ preventDefault: () => {}, target: form }),
      formSubmit!({ preventDefault: () => {}, target: form }),
    ]);
    expect(posts.map((p) => p.path)).toEqual(["/tickets"]);
  });

  test("a pending save keeps its column when another column is opened before the hub answers", async () => {
    let release!: () => void;
    postGate = new Promise((r) => { release = r; });
    ctx.TicketBoard.openNew("done");
    const saving = formSubmit!({ preventDefault: () => {}, target: draft() });
    await settle();
    ctx.TicketBoard.openNew("queued");       // refused while the create is in flight
    release();
    await saving;
    expect(paths()).toEqual([["/tickets", null]]);
    expect(posts[0].body.status).toBe("done");
  });

  test("a refused create (for example done by a non-human) sends nothing more and keeps the draft", async () => {
    postOk = false;
    let resets = 0;
    ctx.TicketBoard.openNew("review");
    await formSubmit!({ preventDefault: () => {}, target: { ...draft(), reset: () => { resets++; } } });
    expect(paths()).toEqual([["/tickets", null]]);
    expect(resets).toBe(0);
  });
});

describe("ticket priority names", () => {
  const mk = (id: string, priority: unknown, created: number) => ({
    ...ticket("", null), id, title: id, priority, created_at_ms: created, status: "queued", blast_radius: "low", approval_request_id: null,
  });

  test("columns sort by rank, then age; an unknown or numeric value reads as Medium", async () => {
    list = [mk("t_low", "low", 1), mk("t_old_med", "medium", 2), mk("t_hi", "highest", 9), mk("t_junk", 0, 3), mk("t_new_med", "medium", 4)];
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
    const order = [...cols.innerHTML.matchAll(/<div class="ticket-title">(\w+)<\/div>/g)].map((m) => m[1]);
    expect(order).toEqual(["t_hi", "t_old_med", "t_junk", "t_new_med", "t_low"]);
    expect(cols.innerHTML).toContain("Highest");
    expect(cols.innerHTML).toContain("Medium");
  });

  test("an inherited key like \"constructor\" reads as Medium and sorts with the medium tickets", async () => {
    list = [mk("t_low", "low", 1), mk("t_ctor", "constructor", 2), mk("t_med", "medium", 3), mk("t_hi", "high", 4)];
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
    const order = [...cols.innerHTML.matchAll(/<div class="ticket-title">(\w+)<\/div>/g)].map((m) => m[1]);
    expect(order).toEqual(["t_hi", "t_ctor", "t_med", "t_low"]);
    expect(cols.innerHTML).toContain("Medium");
  });

  test("the card shows the name, never P<number>", async () => {
    list = [mk("t_a", "high", 1)];
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
    expect(cols.innerHTML).toContain("High");
    expect(cols.innerHTML).not.toMatch(/P\d/);
  });

  test("the create form sends the priority name", async () => {
    const form = {
      title: { value: "T" }, criteria: { value: "c" }, radius: { value: "low" }, priority: { value: "lowest" },
      external_ref: { value: "" }, reset: () => {},
    };
    await formSubmit!({ preventDefault: () => {}, target: form });
    expect(posts.find((p) => p.path === "/tickets")!.body.priority).toBe("lowest");
  });
});

describe("ticket assignee", () => {
  const mk = (id: string, status: string, assignee: string | null) => ({
    ...ticket("", null), id, title: id, status, assignee, blast_radius: "low", approval_request_id: null,
  });
  async function show(...tickets: any[]) {
    list = tickets;
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
    return cols.innerHTML;
  }
  const selectOf = (html: string, id: string) =>
    new RegExp(`<select class="ticket-assign" data-ticket="${id}"[^>]*>(.*?)</select>`).exec(html)?.[1] ?? null;

  test("a queued unassigned card offers Unassigned plus the room's agents, never the human or another room", async () => {
    const sel = selectOf(await show(mk("t_q", "queued", null)), "t_q")!;
    expect(sel).toContain('<option value="" selected>Unassigned</option>');
    expect(sel).toContain('value="alice"');
    expect(sel).toContain('value="bob"');
    expect(sel).not.toContain("human");
    expect(sel).not.toContain("carol");
  });

  test("a queued assigned card marks the assignee selected; Unassigned stays available", async () => {
    const sel = selectOf(await show(mk("t_q", "queued", "alice")), "t_q")!;
    expect(sel).toContain('<option value="alice" selected>alice</option>');
    expect(sel).toContain('<option value="">Unassigned</option>');
  });

  test("a claimed card can be reassigned but not unassigned; a finished card has no select", async () => {
    const html = await show(mk("t_c", "claimed", "alice"), mk("t_d", "done", "alice"), mk("t_x", "cancelled", null));
    const sel = selectOf(html, "t_c")!;
    expect(sel).toContain('<option value="alice" selected>alice</option>');
    expect(sel).not.toContain("Unassigned");
    expect(selectOf(html, "t_d")).toBeNull();
    expect(selectOf(html, "t_x")).toBeNull();
  });

  test("an assignee missing from the roster is still shown", async () => {
    const sel = selectOf(await show(mk("t_c", "in_progress", "dave")), "t_c")!;
    expect(sel).toContain('<option value="dave" selected>dave</option>');
  });

  test("an unassigned card outside Queued has an explicit Unassigned option, selected; no agent looks chosen", async () => {
    const html = await show(mk("t_p", "in_progress", null), mk("t_r", "in_review", null), mk("t_q", "queued", null));
    for (const id of ["t_p", "t_r", "t_q"]) {
      const sel = selectOf(html, id)!;
      expect(sel).toContain('<option value="" selected>Unassigned</option>');
      expect(sel).not.toMatch(/value="(alice|bob)" selected/);
      expect((sel.match(/ selected/g) ?? []).length).toBe(1);
    }
  });

  test("an assigned card outside Queued still has no Unassigned option", async () => {
    const sel = selectOf(await show(mk("t_p", "in_progress", "alice")), "t_p")!;
    expect(sel).not.toContain("Unassigned");
    expect(sel).toContain('<option value="alice" selected>alice</option>');
  });

  test("on an unassigned card Unassigned is the current value (no call); an agent posts the assignment", async () => {
    const s1 = fakeSelect("t_p", "", "");
    cols.querySelectorAll = (q: string) => (q === ".ticket-assign" ? [s1] : []);
    ctx.TicketBoard._tickets.clear();
    list = [mk("t_p", "in_progress", null)];
    await ctx.TicketBoard.load();
    await s1.handlers.change();
    expect(posts).toEqual([]);
    s1.value = "bob";
    await s1.handlers.change();
    expect(posts.at(-1)).toEqual({ path: "/tickets/t_p/assign", body: { by: "human", assignee: "bob" } });
  });

  function fakeSelect(id: string, value: string, current: string) {
    const sel: any = { value, dataset: { ticket: id, current }, handlers: {} as Record<string, () => unknown> };
    sel.addEventListener = (type: string, fn: () => unknown) => { sel.handlers[type] = fn; };
    return sel;
  }
  async function change(sel: any) {
    cols.querySelectorAll = (q: string) => (q === ".ticket-assign" ? [sel] : []);
    ctx.TicketBoard._tickets.clear();
    list = [mk(sel.dataset.ticket, "queued", sel.dataset.current || null)];
    await ctx.TicketBoard.load();
    await sel.handlers.change();
  }

  test("choosing another agent posts the assign verb as the human", async () => {
    await change(fakeSelect("t_q", "bob", "alice"));
    expect(posts.at(-1)).toEqual({ path: "/tickets/t_q/assign", body: { by: "human", assignee: "bob" } });
  });

  test("choosing Unassigned posts a null assignee", async () => {
    await change(fakeSelect("t_q", "", "alice"));
    expect(posts.at(-1)).toEqual({ path: "/tickets/t_q/assign", body: { by: "human", assignee: null } });
  });

  test("choosing the current assignee posts nothing", async () => {
    await change(fakeSelect("t_q", "alice", "alice"));
    expect(posts).toEqual([]);
  });

  test("a refused assignment redraws the board so the select shows the real assignee", async () => {
    postOk = false;
    const before = cols.innerHTML;
    await change(fakeSelect("t_q", "bob", "alice"));
    expect(posts).toHaveLength(1);
    expect(cols.innerHTML).toContain('<option value="alice" selected>alice</option>');   // rebuilt from the ticket
    expect(before).not.toBeUndefined();
  });

  function dialogEls() {
    const pick = { innerHTML: "" };
    const row = { hidden: true };
    els = {
      "ticket-f-assignee": pick,
      "ticket-f-assignee-row": row,
      "ticket-modal": { open: false, style: {}, showModal() { this.open = true; }, close() { this.open = false; } },
      "ticket-modal-title": {}, "ticket-f-title": { focus() {} },
    };
    return { pick, row };
  }

  test("the dialog lists the room's agents in every column", () => {
    for (const col of ["draft", "queued", "progress", "review", "done"]) {
      const { pick } = dialogEls();
      ctx.TicketBoard.openNew(col);
      expect(pick.innerHTML).toContain('<option value="">Unassigned</option>');
      expect(pick.innerHTML).toContain('value="alice"');
      expect(pick.innerHTML).toContain('value="bob"');
      expect(pick.innerHTML).not.toContain("carol");
      expect(pick.innerHTML).not.toContain("human");
    }
  });

  test("a ticket saved with an assignee sends it with the column's status, in one call, from any column", async () => {
    for (const [col, status] of [["draft", "draft"], ["queued", "queued"], ["progress", "in_progress"], ["review", "in_review"], ["done", "done"]]) {
      posts = [];
      dialogEls();
      ctx.TicketBoard.openNew(col);
      await formSubmit!({ preventDefault: () => {}, target: { ...draft(), assignee: { value: "alice" } } });
      expect(posts.map((p) => p.path)).toEqual(["/tickets"]);
      expect(posts[0].body).toMatchObject({ assignee: "alice", status });
    }
  });

  test("a ticket saved without an assignee sends none", async () => {
    dialogEls();
    ctx.TicketBoard.openNew("progress");
    await formSubmit!({ preventDefault: () => {}, target: { ...draft(), assignee: { value: "" } } });
    expect("assignee" in posts[0].body).toBe(false);
    expect(posts.map((p) => p.path)).toEqual(["/tickets"]);
  });
});

describe("room lead", () => {
  let leadOnHub: string | null;
  let leadFetches: number;
  beforeEach(async () => {
    leadOnHub = "alice";
    leadFetches = 0;
    const base = ctx.authedFetch;
    ctx.authedFetch = async (path: string, init?: any) => {
      if (path.startsWith("/rooms/") && !init) { leadFetches++; return { ok: true, json: async () => ({ room: "r", lead: leadOnHub }) }; }
      return base(path, init);
    };
  });
  const sel = () => els["ticket-lead"];

  test("the select lists the room's agents (never the human) with the hub's lead selected", async () => {
    ctx.SELECTED_ROOM = "r2";   // a room change loads the lead
    await ctx.TicketBoard.load();
    await settle();
    expect(leadFetches).toBeGreaterThan(0);
    expect(ctx.TicketBoard._lead()).toBe("alice");
    expect(sel().innerHTML).toContain('<option value="">No lead</option>');
    expect(sel().innerHTML).toContain('value="alice"');
    expect(sel().innerHTML).not.toContain("human");
    expect(sel().value).toBe("alice");
  });

  test("choosing a lead posts it as the human; No lead posts null", async () => {
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    await settle();
    posts = [];
    await ctx.TicketBoard.setLead("bob");
    expect(posts.at(-1)).toEqual({ path: "/rooms/r2/lead", body: { by: "human", agent: "bob" } });
    expect(ctx.TicketBoard._lead()).toBe("bob");
    await ctx.TicketBoard.setLead("");
    expect(posts.at(-1)).toEqual({ path: "/rooms/r2/lead", body: { by: "human", agent: null } });
    expect(ctx.TicketBoard._lead()).toBeNull();
  });

  test("a late lead save for room A does not overwrite the lead shown after a switch to room B", async () => {
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    await settle();
    expect(ctx.TicketBoard._lead()).toBe("alice");
    let release!: () => void;
    postGate = new Promise((r) => { release = r; });
    const saving = ctx.TicketBoard.setLead("bob");                 // in flight for r2
    await settle();
    leadOnHub = "zed";                                              // room r3 has its own lead
    ctx.SELECTED_ROOM = "r3";
    await ctx.TicketBoard.load();
    await settle();
    expect(ctx.TicketBoard._lead()).toBe("zed");
    release();
    await saving;
    expect(ctx.TicketBoard._lead()).toBe("zed");                    // r2's answer is ignored
    expect(sel().value).toBe("zed");
    expect(posts.at(-1).path).toBe("/rooms/r2/lead");               // the save itself went to room A
  });

  test("a late lead save cannot overwrite a newer room.lead event", async () => {
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    await settle();
    let release!: () => void;
    postGate = new Promise((r) => { release = r; });
    const old = ctx.TicketBoard.setLead("alice");
    await settle();
    ctx.TicketBoard.onRoomLead({ room: "r2", lead: "bob" });
    release();
    await old;
    expect(ctx.TicketBoard._lead()).toBe("bob");
    expect(sel().value).toBe("bob");
  });

  test("an older save cannot overwrite a later save", async () => {
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    await settle();
    let release!: () => void;
    postGate = new Promise((r) => { release = r; });
    const first = ctx.TicketBoard.setLead("alice");
    await settle();
    const second = ctx.TicketBoard.setLead("bob");
    release();
    await Promise.all([first, second]);
    expect(ctx.TicketBoard._lead()).toBe("bob");
  });

  test("a save invalidates a read that started before it", async () => {
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    await settle();
    leadOnHub = "old";
    const reading = ctx.TicketBoard.load();
    await ctx.TicketBoard.setLead("bob");
    await reading;
    await settle();
    expect(ctx.TicketBoard._lead()).toBe("bob");
  });

  test("a read started during a pending save does not suppress the confirmed save, and does not overwrite it", async () => {
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    await settle();
    leadOnHub = "alice";                                              // what the hub still says while the save is pending
    let release!: () => void;
    postGate = new Promise((r) => { release = r; });
    const saving = ctx.TicketBoard.setLead("bob");
    await settle();
    ctx.syncTicketBoard();                                            // a GET during the save (the stream reopened)
    await settle();
    release();
    await saving;
    await settle();
    expect(ctx.TicketBoard._lead()).toBe("bob");
    expect(sel().value).toBe("bob");
  });

  test("a stale read that answers after a confirmed save cannot bring the old lead back", async () => {
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    await settle();
    const normal = ctx.authedFetch;
    let answer!: () => void;
    const held = new Promise<void>((r) => { answer = r; });
    ctx.authedFetch = async (path: string, init?: any) => {
      if (path.startsWith("/rooms/") && !init) { await held; return { ok: true, json: async () => ({ room: "r2", lead: "alice" }) }; }
      return normal(path, init);
    };
    let release!: () => void;
    postGate = new Promise((r) => { release = r; });
    const saving = ctx.TicketBoard.setLead("bob");
    await settle();
    ctx.syncTicketBoard();                                            // asked while the save is pending, answered with the old lead
    await settle();
    release();
    await saving;
    expect(ctx.TicketBoard._lead()).toBe("bob");
    answer();
    await settle();
    expect(ctx.TicketBoard._lead()).toBe("bob");
  });

  test("a refused change leaves the lead as it was", async () => {
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    await settle();
    postOk = false;
    await ctx.TicketBoard.setLead("bob");
    expect(ctx.TicketBoard._lead()).toBe("alice");
    expect(sel().value).toBe("alice");
  });

  test("a room without a lead shows No lead", async () => {
    leadOnHub = null;
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    await settle();
    expect(ctx.TicketBoard._lead()).toBeNull();
    expect(sel().value).toBe("");
  });

  test("the select's change handler posts the choice", async () => {
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    await settle();
    posts = [];
    sel().value = "bob";
    await sel().handlers.change({ target: sel() });
    expect(posts.at(-1)).toEqual({ path: "/rooms/r2/lead", body: { by: "human", agent: "bob" } });
  });

  test("the board observes room.* entries with onRoomLead", () => {
    expect(typeof observers.room).toBe("function");
    expect(observers.ticket).toBe(ctx.TicketBoard.onTicket);
  });

  test("a room.lead entry for this room updates the lead and the select", async () => {
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    await settle();
    observers.room({ kind: "room.lead", room: "r2", lead: "bob" });
    expect(ctx.TicketBoard._lead()).toBe("bob");
    expect(sel().value).toBe("bob");
    observers.room({ kind: "room.lead", room: "r2", lead: null });
    expect(ctx.TicketBoard._lead()).toBeNull();
    expect(sel().value).toBe("");
  });

  test("a room.lead entry for another room is ignored", async () => {
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    await settle();
    observers.room({ kind: "room.lead", room: "elsewhere", lead: "bob" });
    expect(ctx.TicketBoard._lead()).toBe("alice");
  });

  test("an entry that arrives while the lead is being read wins over the older read", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const base = ctx.authedFetch;
    ctx.authedFetch = async (path: string, init?: any) => {
      if (path.startsWith("/rooms/") && !init) { await held; return { ok: true, json: async () => ({ room: "r2", lead: "alice" }) }; }
      return base(path, init);
    };
    ctx.SELECTED_ROOM = "r2";
    const loading = ctx.TicketBoard.load();
    observers.room({ kind: "room.lead", room: "r2", lead: "bob" });     // newer than the read in flight
    release();
    await loading;
    await settle();
    expect(ctx.TicketBoard._lead()).toBe("bob");
  });

  test("with no room selected the select is disabled and nothing is read", async () => {
    ctx.SELECTED_ROOM = "__ALL__";
    await ctx.TicketBoard.load();
    await settle();
    expect(sel().disabled).toBe(true);
    await ctx.TicketBoard.setLead("bob");
    expect(posts.filter((p) => p.path.startsWith("/rooms/"))).toEqual([]);
  });
});

describe("board filters", () => {
  const radio = () => ["all", "high", "low"].find((v) => els[`ticket-filter-radius-${v}`].checked);
  const pickRadius = (v: string) => {
    for (const k of ["all", "high", "low"]) els[`ticket-filter-radius-${k}`].checked = k === v;
    els[`ticket-filter-radius-${v}`].handlers.change({ target: els[`ticket-filter-radius-${v}`] });
  };
  const mk = (id: string, status: string, radius: string, priority: unknown) => ({
    ...ticket("", null), id, title: id, status, blast_radius: radius, priority, approval_request_id: null, assignee: null,
  });
  const counts = () => [...cols.innerHTML.matchAll(/<h3>(.*?) <span class="count">(\d+)<\/span>/g)].map((m) => [m[1], Number(m[2])]);
  const titles = () => [...cols.innerHTML.matchAll(/<div class="ticket-title">(\w+)<\/div>/g)].map((m) => m[1]);
  async function show(...tickets: any[]) {
    list = tickets;
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
  }
  const all5 = ["highest", "high", "medium", "low", "lowest"];
  const board = () => [
    mk("a", "queued", "low", "highest"), mk("b", "queued", "high", "medium"),
    mk("c", "claimed", "high", "low"), mk("d", "in_review", "low", "lowest"),
    mk("e", "done", "high", "high"), mk("f", "queued", "low", "constructor"),   // unknown priority reads as medium
  ];

  test("no filter shows every ticket and every count", async () => {
    await show(...board());
    expect(counts()).toEqual([["Draft", 0], ["Queued", 3], ["In progress", 1], ["In review", 1], ["Done", 1]]);
    expect(els["ticket-filter-summary"].textContent).toBe("All 6 tickets");   // the default filter: the count of tickets the board shows
  });

  test("matchesFilter: radius and priority combine; an unknown priority is medium", () => {
    const m = ctx.TicketBoard.matchesFilter;
    const f = (radius: string, priorities: string[], request = "") => ({ radius, request, priorities });
    expect(m(mk("x", "queued", "high", "high"), f("high", all5))).toBe(true);
    expect(m(mk("x", "queued", "low", "high"), f("high", all5))).toBe(false);
    expect(m(mk("x", "queued", "low", "high"), f("all", ["medium"]))).toBe(false);
    expect(m(mk("x", "queued", "low", "high"), f("all", ["high", "low"]))).toBe(true);
    expect(m(mk("x", "queued", "low", "constructor"), f("all", ["medium"]))).toBe(true);
    expect(m(mk("x", "queued", "low", 3), f("all", ["medium"]))).toBe(true);
    expect(m(mk("x", "queued", "low", "high"), f("all", []))).toBe(false);
  });

  test("the request filter shows one request, lists the labels on the board and counts as an active filter", async () => {
    await show(...board().map((t, i) => ({ ...t, request_id: i < 3 ? "r-1" : "r-2" })));
    expect(els["ticket-filter-summary"].textContent).toBe("All 6 tickets");   // the default filter: the count of tickets the board shows
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), request: "r-1" });
    expect(titles().sort()).toEqual(["a", "b", "c"]);
    expect(els["ticket-filters-btn"].textContent).toBe("Filters · 1");
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), request: "" });
    expect(titles().length).toBe(6);
  });

  test("a request labelled \"all\" is a real label: the filter picks it, and \"\" (All requests) shows everything", async () => {
    const t = board().map((x, i) => ({ ...x, request_id: i < 2 ? "all" : i < 4 ? "r-2" : null }));
    await show(...t);
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), request: "all" });
    expect(titles().sort()).toEqual(["a", "b"]);                      // only the tickets labelled "all"
    expect(ctx.TicketBoard.matchesFilter(t[0], { radius: "all", request: "all", priorities: all5 })).toBe(true);
    expect(ctx.TicketBoard.matchesFilter(t[2], { radius: "all", request: "all", priorities: all5 })).toBe(false);
    expect(els["ticket-filters-btn"].textContent).toBe("Filters · 1");   // it counts as an active filter
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), request: "" });
    expect(titles().length).toBe(6);
    expect(els["ticket-filters-btn"].textContent).toBe("Filters");
  });

  test("the request select lists only labels of tickets the board can show; a filter on a gone label resets", async () => {
    els["ticket-filter-request"] = { innerHTML: "", value: "" };
    const t = (id: string, status: string, extra: object) => ({ ...mk(id, status, "low", "medium"), ...extra });
    await show(t("a", "queued", { request_id: "r-live" }), t("b", "cancelled", { request_id: "r-gone" }), t("c", "done", { request_id: "r-old", archived_at_ms: 5 }));
    const opts = () => ((els["ticket-filter-request"].innerHTML as string).match(/value="([^"]*)"/g) ?? []);
    expect(opts()).toEqual(['value=""', 'value="r-live"']);
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), showCancelled: true });
    expect(opts()).toEqual(['value=""', 'value="r-gone"', 'value="r-live"']);
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), request: "r-gone" });
    expect(titles()).toEqual(["b"]);
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), showCancelled: false });   // the label's only ticket is hidden now
    expect(ctx.TicketBoard._filter().request).toBe("");
    expect(titles()).toEqual(["a"]);
    delete els["ticket-filter-request"];
  });

  test("archived toggle: a filter on a label whose only ticket is archived resets when archived tickets hide", async () => {
    els["ticket-filter-request"] = { innerHTML: "", value: "" };
    const arch = { ...mk("z", "done", "low", "medium"), request_id: "r-arch", archived_at_ms: 5 };
    await show(arch, { ...mk("a", "queued", "low", "medium"), request_id: "r-live" });
    const opts = () => ((els["ticket-filter-request"].innerHTML as string).match(/value="([^"]*)"/g) ?? []);
    expect(opts()).toEqual(['value=""', 'value="r-live"']);
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), showArchived: true });
    list = [arch, { ...mk("a", "queued", "low", "medium"), request_id: "r-live" }];
    await ctx.TicketBoard.load();
    expect(opts()).toEqual(['value=""', 'value="r-arch"', 'value="r-live"']);
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), request: "r-arch" });
    expect(titles()).toEqual(["z"]);
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), showArchived: false });
    expect(ctx.TicketBoard._filter().request).toBe("");
    delete els["ticket-filter-request"];
  });

  // A room change makes load() read the stored filter, which is the first load of a room.
  test("6.6 first load: a stored filter on a label no ticket has resets before the first render", async () => {
    store.set("cubilot_board_filter:r9", JSON.stringify({ radius: "all", request: "r-gone", priorities: all5, showArchived: false, showCancelled: false, v: 2 }));
    ctx.SELECTED_ROOM = "r9";
    list = [{ ...mk("a", "queued", "low", "medium"), request_id: "r-live" }];
    await ctx.TicketBoard.load();
    expect(ctx.TicketBoard._filter().request).toBe("");
    expect(titles()).toEqual(["a"]);
    expect(JSON.parse(store.get("cubilot_board_filter:r9")!).request).toBe("");
    ctx.SELECTED_ROOM = "r";
  });

  test("6.6 first load: an empty list with a stored request filter resets it", async () => {
    store.set("cubilot_board_filter:r9", JSON.stringify({ radius: "all", request: "r-gone", priorities: all5, showArchived: false, showCancelled: false, v: 2 }));
    ctx.SELECTED_ROOM = "r9";
    list = [];
    await ctx.TicketBoard.load();
    expect(ctx.TicketBoard._filter().request).toBe("");
    ctx.SELECTED_ROOM = "r";
  });

  test("6.6 a live event that hides the only ticket of the selected label resets the filter", async () => {
    els["ticket-filter-request"] = { innerHTML: "", value: "" };
    await show({ ...mk("a", "queued", "low", "medium"), request_id: "r-1" }, { ...mk("b", "queued", "low", "medium"), request_id: "r-2" });
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), request: "r-1" });
    expect(titles()).toEqual(["a"]);
    ctx.TicketBoard.onTicket({ kind: "ticket.update", version: 99, snapshot: { ...mk("a", "cancelled", "low", "medium"), request_id: "r-1", room: "r", version: 99 } });
    expect(ctx.TicketBoard._filter().request).toBe("");                 // not an empty board behind a select that no longer lists r-1
    expect(titles()).toEqual(["b"]);
    delete els["ticket-filter-request"];
  });

  test("6.7 the board card's Cancel ticket needs a second click (Confirm cancel, 5 s)", async () => {
    await show(mk("a", "queued", "low", "medium"));
    const btn: any = { dataset: { ticket: "a", to: "cancelled" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    const orig = cols.querySelectorAll;
    cols.querySelectorAll = (sel: string) => (sel.includes(".ticket-actions button[data-to]") ? [btn] : []);
    let fire: any = null;
    ctx.setTimeout = (fn: any, ms: number) => { expect(ms).toBe(5000); fire = fn; return 1; };
    ctx.TicketBoard.setFilter(ctx.TicketBoard._filter());              // redraw so the card is wired to the stub
    posts = [];
    btn.handlers.click();
    expect(cols.innerHTML).toContain("Confirm cancel");
    expect(posts).toEqual([]);
    fire();
    expect(cols.innerHTML).not.toContain("Confirm cancel");
    btn.handlers.click();
    btn.handlers.click();
    expect(posts).toEqual([{ path: "/tickets/a/transition", body: { by: "human", to: "cancelled" } }]);
    ctx.setTimeout = setTimeout;
    cols.querySelectorAll = orig;
  });

  test("a stored filter written before format 2 reads request \"all\" as no filter; a format 2 \"all\" stays a label", () => {
    store.set("cubilot_board_filter:r", JSON.stringify({ radius: "all", request: "all", priorities: all5, showArchived: false, showCancelled: false }));
    expect(ctx.TicketBoard.readFilter("r").request).toBe("");
    store.set("cubilot_board_filter:r", JSON.stringify({ radius: "all", request: "all", priorities: all5, showArchived: false, showCancelled: false, v: 2 }));
    expect(ctx.TicketBoard.readFilter("r").request).toBe("all");
    store.set("cubilot_board_filter:r", JSON.stringify({ radius: "all", priorities: all5, showArchived: false, showCancelled: false }));
    expect(ctx.TicketBoard.readFilter("r").request).toBe("");        // a filter saved before the request field existed
  });

  test("the radius filter applies to every column and to the counts", async () => {
    await show(...board());
    ctx.TicketBoard.setFilter({ radius: "high", priorities: all5 });
    expect(counts()).toEqual([["Draft", 0], ["Queued", 1], ["In progress", 1], ["In review", 0], ["Done", 1]]);
    expect(titles().sort()).toEqual(["b", "c", "e"]);
    ctx.TicketBoard.setFilter({ radius: "low", priorities: all5 });
    expect(counts()).toEqual([["Draft", 0], ["Queued", 2], ["In progress", 0], ["In review", 1], ["Done", 0]]);
  });

  test("the priority filter takes any mix of levels and applies to the counts", async () => {
    await show(...board());
    ctx.TicketBoard.setFilter({ radius: "all", priorities: ["highest", "lowest"] });
    expect(titles().sort()).toEqual(["a", "d"]);
    expect(counts()).toEqual([["Draft", 0], ["Queued", 1], ["In progress", 0], ["In review", 1], ["Done", 0]]);
    ctx.TicketBoard.setFilter({ radius: "all", priorities: ["medium"] });
    expect(titles().sort()).toEqual(["b", "f"]);                       // f: unknown priority is medium
  });

  test("radius and priority filters combine, and the summary says how many are shown", async () => {
    await show(...board());
    ctx.TicketBoard.setFilter({ radius: "high", priorities: ["medium", "low"] });
    expect(titles().sort()).toEqual(["b", "c"]);
    expect(els["ticket-filter-summary"].textContent).toBe("Showing 2 of 6 tickets");
  });

  test("with every priority unticked nothing is shown", async () => {
    await show(...board());
    ctx.TicketBoard.setFilter({ radius: "all", priorities: [] });
    expect(titles()).toEqual([]);
    expect(counts().every(([, n]) => n === 0)).toBe(true);
  });

  test("a ticket event that arrives while filtered is held back or shown by the filter", async () => {
    await show(...board());
    ctx.TicketBoard.setFilter({ radius: "high", priorities: all5 });
    ctx.TicketBoard.onTicket({ ticket_id: "n", version: 99, snapshot: { ...mk("n", "queued", "low", "high"), version: 99 } });
    expect(titles()).not.toContain("n");                               // low radius: filtered out
    expect(ctx.TicketBoard._tickets.has("n")).toBe(true);              // but known, for when the filter changes
    ctx.TicketBoard.setFilter({ radius: "all", priorities: all5 });
    expect(titles()).toContain("n");
  });

  test("the controls mirror the filter, and each control writes it", async () => {
    await show(...board());
    ctx.TicketBoard.setFilter({ radius: "low", priorities: ["high", "lowest"] });
    expect(radio()).toBe("low");
    expect(all5.map((k) => els[`ticket-filter-p-${k}`].checked)).toEqual([false, true, false, false, true]);
    // The segmented radius control drives it ...
    pickRadius("high");
    expect(ctx.TicketBoard._filter().radius).toBe("high");
    // ... and so does a checkbox
    els["ticket-filter-p-medium"].checked = true;
    els["ticket-filter-p-medium"].handlers.change();
    expect(ctx.TicketBoard._filter().priorities).toEqual(["high", "medium", "lowest"]);
    // Reset restores everything
    els["ticket-filter-reset"].handlers.click();
    expect(ctx.TicketBoard._filter()).toEqual({ radius: "all", request: "", priorities: all5, showArchived: false, showCancelled: false });
    expect(radio()).toBe("all");
  });

  test("the choice is saved per room and restored on the room's return", async () => {
    await show(...board());
    ctx.TicketBoard.setFilter({ radius: "high", priorities: ["low"] });
    expect(JSON.parse(store.get("cubilot_board_filter:r")!)).toEqual({ radius: "high", request: "", priorities: ["low"], showArchived: false, showCancelled: false, v: 2 });
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    expect(ctx.TicketBoard._filter()).toEqual({ radius: "all", request: "", priorities: all5, showArchived: false, showCancelled: false });   // another room starts clean
    ctx.TicketBoard.setFilter({ radius: "low", priorities: all5 });
    ctx.SELECTED_ROOM = "r";
    await ctx.TicketBoard.load();
    expect(ctx.TicketBoard._filter()).toEqual({ radius: "high", request: "", priorities: ["low"], showArchived: false, showCancelled: false });
    expect(radio()).toBe("high");                                      // the controls follow the room
    expect(JSON.parse(store.get("cubilot_board_filter:r2")!)).toEqual({ radius: "low", request: "", priorities: all5, showArchived: false, showCancelled: false, v: 2 });
  });

  test("damaged storage falls back to no filter; unknown values are dropped", () => {
    store.set("cubilot_board_filter:r", "{not json");
    expect(ctx.TicketBoard.readFilter("r")).toEqual({ radius: "all", request: "", priorities: all5, showArchived: false, showCancelled: false });
    store.set("cubilot_board_filter:r", JSON.stringify({ radius: "extreme", priorities: ["high", "bogus", "constructor"] }));
    expect(ctx.TicketBoard.readFilter("r")).toEqual({ radius: "all", request: "", priorities: ["high"], showArchived: false, showCancelled: false });
    store.set("cubilot_board_filter:r", JSON.stringify({ radius: "low", priorities: "high" }));
    expect(ctx.TicketBoard.readFilter("r")).toEqual({ radius: "low", request: "", priorities: all5, showArchived: false, showCancelled: false });
    expect(ctx.TicketBoard.sanitizeFilter(null)).toEqual({ radius: "all", request: "", priorities: all5, showArchived: false, showCancelled: false });
  });
});

describe("archived tickets", () => {
  // "Archive all done" lives in the Done column's header.
  const doneHeader = () => /<h3>Done .*?<\/h3>/s.exec(cols.innerHTML)?.[0] ?? "";
  const archiveAllBtn = () => />([^<]*)<\/button>/.exec(/<button[^>]*class="ticket-archive-all"[^>]*>[^<]*<\/button>/.exec(doneHeader())?.[0] ?? "")?.[1];
  const archiveAllDisabled = () => /class="ticket-archive-all" disabled/.test(doneHeader());
  const mk = (id: string, status: string, archived: number | null = null, created = 1, extra: object = {}) => ({
    ...ticket("", null), id, title: id, status, archived_at_ms: archived, created_at_ms: created,
    blast_radius: "low", priority: "medium", approval_request_id: null, assignee: null, ...extra,
  });
  const titles = () => [...cols.innerHTML.matchAll(/<div class="ticket-title">(\w+)<\/div>/g)].map((m) => m[1]).sort();
  const headers = () => [...cols.innerHTML.matchAll(/<h3>(.*?) <span/g)].map((m) => m[1]);
  let gets: string[];
  beforeEach(() => {
    gets = [];
    const base = ctx.authedFetch;
    ctx.authedFetch = async (path: string, init?: any) => {
      if (!init) gets.push(path);
      return base(path, init);
    };
  });
  async function show(...tickets: any[]) {
    list = tickets;
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
  }
  const set = (f: object) => ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), ...f });

  test("an archived ticket is hidden by default and listed when Show archived is on", async () => {
    await show(mk("live", "done"), mk("old", "done", 5), mk("q", "queued"));
    expect(titles()).toEqual(["live", "q"]);
    set({ showArchived: true });
    await settle();
    expect(titles()).toEqual(["live", "old", "q"]);
    expect(cols.innerHTML).toContain("ticket-card status-done archived");
  });

  test("turning Show archived on reloads with archived=1; turning it off reloads without", async () => {
    await show(mk("a", "done"));
    gets.length = 0;
    set({ showArchived: true });
    await settle();
    expect(gets.at(-1)).toBe("/tickets?room=r&status=all&archived=1");
    set({ showArchived: false, showCancelled: false });
    await settle();
    expect(gets.at(-1)).toBe("/tickets?room=r&status=all");
    expect(els["ticket-show-archived"].checked).toBe(false);
  });

  test("the Show archived checkbox drives the filter", async () => {
    await show(mk("a", "done"));
    els["ticket-show-archived"].checked = true;
    els["ticket-show-archived"].handlers.change({ target: els["ticket-show-archived"] });
    expect(ctx.TicketBoard._filter().showArchived).toBe(true);
  });

  test("Archive appears on Done and Cancelled cards only; an archived card offers Unarchive", async () => {
    set({ showArchived: true, showCancelled: true });
    await show(mk("d", "done"), mk("c", "cancelled"), mk("q", "queued"), mk("p", "in_progress"), mk("r", "in_review"), mk("x", "done", 9));
    const btn = (id: string) => new RegExp(`class="ticket-archive" data-ticket="${id}" data-archive="(true|false)">(\\w+)</button>`).exec(cols.innerHTML);
    expect(btn("d")!.slice(1)).toEqual(["true", "Archive"]);
    expect(btn("c")!.slice(1)).toEqual(["true", "Archive"]);
    expect(btn("x")!.slice(1)).toEqual(["false", "Unarchive"]);
    for (const id of ["q", "p", "r"]) expect(btn(id)).toBeNull();
  });

  test("clicking Archive or Unarchive posts the verb as the human", async () => {
    await show(mk("d", "done"));
    const fake = (id: string, archive: string) => {
      const b: any = { dataset: { ticket: id, archive }, handlers: {} as Record<string, () => unknown> };
      b.addEventListener = (type: string, fn: () => unknown) => { b.handlers[type] = fn; };
      return b;
    };
    const archive = fake("d", "true"), restore = fake("d", "false");
    cols.querySelectorAll = (q: string) => (q === ".ticket-archive" ? [archive, restore] : []);
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
    await archive.handlers.click();
    expect(posts.at(-1)).toEqual({ path: "/tickets/d/archive", body: { by: "human", archived: true } });
    await restore.handlers.click();
    expect(posts.at(-1)).toEqual({ path: "/tickets/d/archive", body: { by: "human", archived: false } });
  });

  test("the board has five columns; Cancelled appears only with Show cancelled, and has no +", async () => {
    await show(mk("q", "queued"), mk("c", "cancelled"));
    expect(headers()).toEqual(["Draft", "Queued", "In progress", "In review", "Done"]);
    expect(titles()).toEqual(["q"]);                                            // the cancelled ticket is hidden
    set({ showCancelled: true });
    expect(headers()).toEqual(["Draft", "Queued", "In progress", "In review", "Done", "Cancelled"]);
    expect(titles()).toEqual(["c", "q"]);
    expect((cols.innerHTML.match(/class="ticket-add"/g) ?? []).length).toBe(5);      // none on Cancelled
    await show(mk("q", "queued"));                                              // shown even with no cancelled ticket
    expect(headers().at(-1)).toBe("Cancelled");
    set({ showCancelled: false });
    expect(headers()).toEqual(["Draft", "Queued", "In progress", "In review", "Done"]);
  });

  test("an archived cancelled ticket needs both Show cancelled and Show archived", async () => {
    await show(mk("c", "cancelled", 3));
    set({ showCancelled: true });
    expect(titles()).toEqual([]);
    set({ showArchived: true });
    await settle();
    expect(titles()).toEqual(["c"]);
  });

  test("the Show cancelled checkbox drives the filter and is saved per room", async () => {
    await show(mk("c", "cancelled"));
    els["ticket-show-cancelled"].checked = true;
    els["ticket-show-cancelled"].handlers.change({ target: els["ticket-show-cancelled"] });
    expect(ctx.TicketBoard._filter().showCancelled).toBe(true);
    expect(JSON.parse(store.get("cubilot_board_filter:r")!).showCancelled).toBe(true);
    store.set("cubilot_board_filter:r", JSON.stringify({ radius: "all", priorities: ["high"], showCancelled: 1 }));
    expect(ctx.TicketBoard.readFilter("r").showCancelled).toBe(false);          // non-boolean reads as off
  });

  test("hidden cancelled tickets do not count in \"Showing N of M\"", async () => {
    await show(mk("q", "queued"), mk("c", "cancelled"), mk("d", "done"));
    set({ radius: "high" });                                                    // nothing is high: 0 of 2 visible
    expect(els["ticket-filter-summary"].textContent).toBe("Showing 0 of 2 tickets");
  });

  test("a live ticket.archived event hides the ticket, and a restore brings it back", async () => {
    await show(mk("d", "done", null, 1, { version: 5 }));
    ctx.TicketBoard.onTicket({ ticket_id: "d", version: 6, snapshot: { ...mk("d", "done", 77), version: 6 } });
    expect(titles()).toEqual([]);
    ctx.TicketBoard.onTicket({ ticket_id: "d", version: 7, snapshot: { ...mk("d", "done", null), version: 7 } });
    expect(titles()).toEqual(["d"]);
  });

  test("Archive all done archives the done tickets on screen, one call each, in order", async () => {
    await show(mk("a", "done", null, 3), mk("b", "done", null, 1), mk("gone", "done", 9, 2), mk("q", "queued", null, 4), mk("c", "cancelled", null, 5));
    expect(archiveAllBtn()).toBe("Archive all done (2)");
    expect(archiveAllDisabled()).toBe(false);
    posts = [];
    await ctx.TicketBoard.archiveAllDone();
    expect(posts.map((p) => [p.path, p.body.archived])).toEqual([["/tickets/b/archive", true], ["/tickets/a/archive", true]]);
  });

  test("Archive all done respects the filters", async () => {
    await show(mk("hi", "done", null, 1, { blast_radius: "high" }), mk("lo", "done", null, 2));
    set({ radius: "high" });
    expect(archiveAllBtn()).toBe("Archive all done (1)");
    posts = [];
    await ctx.TicketBoard.archiveAllDone();
    expect(posts.map((p) => p.path)).toEqual(["/tickets/hi/archive"]);
  });

  test("Archive all done stops at the first refusal", async () => {
    await show(mk("a", "done", null, 1), mk("b", "done", null, 2), mk("c", "done", null, 3));
    failPath = "/tickets/a/archive";
    posts = [];
    await ctx.TicketBoard.archiveAllDone();
    expect(posts.map((p) => p.path)).toEqual(["/tickets/a/archive"]);
  });

  test("with nothing to archive the button is disabled and a click posts nothing", async () => {
    await show(mk("q", "queued"), mk("old", "done", 5));
    expect(archiveAllBtn()).toBeUndefined();                              // Done shows no ticket: it is a strip with no button
    set({ showArchived: true });                                          // the archived ticket shows: Done has a ticket and nothing to archive
    await settle();
    expect(archiveAllDisabled()).toBe(true);
    expect(archiveAllBtn()).toBe("Archive all done");
    posts = [];
    await ctx.TicketBoard.archiveAllDone();
    expect(posts).toEqual([]);
  });

  test("Show archived is kept per room and a non-boolean stored value reads as off", async () => {
    await show(mk("a", "done"));
    set({ showArchived: true });
    expect(JSON.parse(store.get("cubilot_board_filter:r")!).showArchived).toBe(true);
    store.set("cubilot_board_filter:r", JSON.stringify({ radius: "all", priorities: ["high"], showArchived: "yes" }));
    expect(ctx.TicketBoard.readFilter("r").showArchived).toBe(false);
  });
});

describe("room.lead through the real KindCardRenderer", () => {
  // main.js: `if (KindCardRenderer.dispatch(kind, data)) return;` - an observed kind is never drawn as chat.
  test("dispatch reports an observed room.lead entry as handled and updates the select", async () => {
    const select: any = { innerHTML: "", value: "", disabled: false, addEventListener() {} };
    const calls: string[] = [];
    const real = vm.createContext({
      SELECTED_ROOM: "r", ROOM_ALL: "__ALL__", HUMAN_NAME: "human",
      ROSTER: [{ name: "alice", room: "r" }, { name: "bob", room: "r" }],
      escHtml: String, escAttr: String, addMessage: () => calls.push("chat"), parseErrorBody: async () => "", console,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => (id === "ticket-lead" ? select : null), addEventListener: () => {} },
      authedFetch: async () => ({ ok: true, json: async () => ({ room: "r", lead: null }) }),
    });
    vm.runInContext(readFileSync("ui/kinds/kind-renderer.js", "utf8"), real);
    vm.runInContext(SRC, real);
    await vm.runInContext("TicketBoard.load()", real);
    await settle();
    const handled = vm.runInContext("KindCardRenderer.dispatch('room.lead', { kind: 'room.lead', room: 'r', lead: 'bob', text: '[room lead: bob]' })", real);
    expect(handled).toBe(true);                       // main.js returns here: no chat line
    expect(select.value).toBe("bob");
    expect(calls).toEqual([]);
    // A kind nobody observes is not handled (and so would be drawn as chat).
    expect(vm.runInContext("KindCardRenderer.dispatch('other.thing', {})", real)).toBe(false);
  });
});

describe("ticket view dialog", () => {
  const T = (extra: object = {}) => ({
    ...ticket("", null), id: "t_9", title: "Fix <it>", status: "in_progress", blast_radius: "low", priority: "high",
    creator: "human", assignee: "alice", external_ref: "AUDIT-9", approval_request_id: null, archived_at_ms: null,
    acceptance_criteria: "line one\nline two <b>", created_at_ms: 1791960000000, updated_at_ms: 1791961000000, ...extra,
  });
  const view = () => els["ticket-view"];
  const content = () => els["ticket-view-content"].innerHTML as string;
  const panel = () => els["ticket-view-actions"].innerHTML as string;          // 15.5: the properties panel
  const head = () => els["ticket-view-head-meta"].innerHTML as string;         // 15.5: tag, code, status pill, light and its label
  const actions = () => els["ticket-view-actions"];

  function fakeCard(id: string) {
    const c: any = { dataset: { ticket: id }, isConnected: true, handlers: {} as Record<string, (e: any) => void> };
    c.addEventListener = (type: string, fn: (e: any) => void) => { c.handlers[type] = fn; };
    c.focus = () => { active = c; };
    return c;
  }
  // Show tickets with their cards wired; returns the cards by ticket id.
  async function board(...tickets: any[]) {
    const cards: Record<string, any> = {};
    for (const t of tickets) cards[t.id] = fakeCard(t.id);
    cols.querySelectorAll = (q: string) => (q === ".ticket-card" ? Object.values(cards) : []);
    list = tickets;
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
    return cards;
  }
  const click = (card: any, inside = false) => card.handlers.click({ target: { closest: () => (inside ? {} : null) } });

  // (The harness escHtml/escAttr are String, so these checks read the raw text; the real helpers escape it.)
  // Status light (the human's rules): red = cannot advance without the human (pending approval or human assignee),
  // orange = claimed / in_progress, green = queued and in_review, none when finished.
  test("lightOf: every status, a pending approval or a human assignee wins", () => {
    const light = (status: string, extra: any = {}) => ctx.TicketBoard.lightOf({ status, assignee: "alice", ...extra })?.[0] ?? null;
    for (const s of ["queued", "in_review"]) expect(light(s)).toBe("green");
    for (const s of ["claimed", "in_progress"]) expect(light(s)).toBe("orange");
    for (const s of ["done", "cancelled"]) expect(light(s)).toBeNull();
    for (const s of ["queued", "claimed", "in_progress", "in_review"]) {
      expect(light(s, { approval: { status: "pending" } })).toBe("red");
      expect(light(s, { assignee: "human" })).toBe("red");
    }
    expect(light("in_progress", { approval: { status: "allowed" } })).toBe("orange");
    expect(light("queued", { assignee: null })).toBe("green");
    expect(light("done", { approval: { status: "pending" }, assignee: "human" })).toBeNull();   // finished: no light
  });

  test("parseTitle: tag, code, main and sub", () => {
    const p = (x: string) => ctx.TicketBoard.parseTitle(x);
    expect(p("[code] 8.3a Card actions [backlog]")).toEqual({ tag: "code", code: "8.3a", main: "Card actions", sub: "backlog" });
    expect(p("[Code] 15.1 Pure helpers: parseTitle, x")).toEqual({ tag: "code", code: "15.1", main: "Pure helpers: parseTitle, x", sub: null });
    expect(p("Plain title")).toEqual({ tag: null, code: null, main: "Plain title", sub: null });          // no tag
    expect(p("[code] Fix the bug")).toEqual({ tag: "code", code: null, main: "Fix the bug", sub: null });   // a tag with no code
    expect(p("[code] 12 not a code")).toMatchObject({ code: "12", main: "not a code" });
    expect(p("[code] version 2")).toMatchObject({ code: null, main: "version 2" });
    expect(p("3.2 Numbered, no tag")).toEqual({ tag: null, code: "3.2", main: "Numbered, no tag", sub: null });
    for (const only of ["[code]", "[code] 8.3a", "[code] [x]", "[code] 8.3a [x]"]) {        // nothing left for main
      expect(p(only)).toEqual({ tag: null, code: null, main: only, sub: null });
    }
  });

  test("criteriaProgress counts - [x], - [X] and - [ ] lines only", () => {
    const c = (x: string) => ctx.TicketBoard.criteriaProgress(x);
    expect(c("- [x] a\n- [X] b\n- [ ] c\ntext\n  - [x] nested\n* [x] star\n-[x] none")).toEqual({ done: 2, total: 3 });
    expect(c("")).toEqual({ done: 0, total: 0 });
    expect(c(null)).toEqual({ done: 0, total: 0 });
  });

  test("priorityBars: 4 for Highest down to 0 for Lowest; an unknown priority reads as Medium", () => {
    const b = (priority: any) => ctx.TicketBoard.priorityBars({ priority });
    expect(["highest", "high", "medium", "low", "lowest"].map(b)).toEqual([4, 3, 2, 1, 0]);
    expect(b(undefined)).toBe(2);
    expect(b("bogus")).toBe(2);
  });

  test("statusLine: approval, then the human, then blockers; null otherwise; never disagrees with lightOf", () => {
    const sl = (t: any) => ctx.TicketBoard.statusLine({ status: "queued", assignee: "alice", ...t });
    expect(sl({})).toBeNull();
    expect(sl({ blocked_by: ["x"], open_blockers: ["x"] })).toBe("Blocked by 1 open ticket");
    expect(sl({ blocked_by: ["x", "y"], open_blockers: ["x", "y"] })).toBe("Blocked by 2 open tickets");
    expect(sl({ blocked_by: ["x"], open_blockers: [] })).toBeNull();                                  // blocker is done
    expect(sl({ assignee: "human", blocked_by: ["x"], open_blockers: ["x"] })).toBe("Assigned to you");
    expect(sl({ approval: { status: "pending" }, assignee: "human", open_blockers: ["x"], blocked_by: ["x"] })).toBe("Waiting for your approval");
    for (const status of ["done", "cancelled"]) expect(sl({ status, approval: { status: "pending" }, assignee: "human" })).toBeNull();
    // Whenever the line is the approval or the human line, the light is red.
    for (const status of ["queued", "claimed", "in_progress", "in_review", "done", "cancelled"]) {
      for (const extra of [{}, { assignee: "human" }, { approval: { status: "pending" } }, { blocked_by: ["x"], open_blockers: ["x"] }]) {
        const t = { status, assignee: "alice", ...extra };
        const line = ctx.TicketBoard.statusLine(t);
        if (line === "Waiting for your approval" || line === "Assigned to you") expect(ctx.TicketBoard.lightOf(t)?.[0]).toBe("red");
      }
    }
  });

  test("the light is on the card (actions row) and at the top of the full view, with a title and an aria-label", async () => {
    const lit = (html: string) => [...html.matchAll(/<i class="on light-(\w+)">/g)].map((m) => m[1]);
    const cards = await board(T({ status: "in_progress", blast_radius: "low", approval_request_id: null }));
    expect(lit(cols.innerHTML)).toEqual(["orange"]);
    expect(cols.innerHTML).toMatch(/<div class="ticket-card-foot">.*<span class="ticket-light" role="img" aria-label="Status: [^"]+" title="[^"]+">/s);   // the light ends the card footer
    click(cards.t_9);
    expect(head()).toMatch(/<span class="ticket-view-light"><span class="ticket-light"/);
    expect(head()).toContain('<span class="ticket-view-light-label">an agent is busy with it</span>');
    expect(lit(head())).toEqual(["orange"]);
    els["ticket-view-close"].handlers.click();
    await board(T({ status: "done", blast_radius: "low", approval_request_id: null }));
    expect(cols.innerHTML).not.toContain("ticket-light");
  });

  test("a card is focusable, has a role and an accessible name", async () => {
    await board(T());
    expect(cols.innerHTML).toContain('role="button" tabindex="0" draggable="true" data-ticket="t_9" aria-label="Open ticket: Fix <it>"');
  });

  test("a click on the card opens the dialog with the whole ticket", async () => {
    const cards = await board(T({ blast_radius: "high", approval_request_id: "abcde", approval: { id: "abcde", status: "pending", resolved_by: null, version: 1 } }));
    click(cards.t_9);
    expect(view().open).toBe(true);
    expect(els["ticket-view-title"].textContent).toBe("Fix <it>");
    expect(head()).toContain("In progress");                                  // the status pill
    for (const text of ["t_9", "AUDIT-9", "High", "high", "human", "alice", "Created", "Updated"]) expect(panel()).toContain(text);
    expect(content()).toContain("line one<br>line two <b>");
    expect(panel()).toContain("Copy");                                        // the ID has a copy button
    expect(content()).toContain("Acceptance criteria");
    expect(content()).toContain("Waiting for your approval.");              // the approval banner
    expect(active).toBe(els["ticket-view-x"]);                             // focus moves into the dialog: the header Close, the first control
  });

  test("an unassigned ticket says so; an archived one shows when", async () => {
    const cards = await board(T({ assignee: null, external_ref: null, archived_at_ms: 1791962000000 }));
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), showArchived: true });
    await settle();
    click(cards.t_9);
    expect(panel()).toContain("Unassigned");                                  // the Assignee select's first option
    expect(panel()).toContain("—");
    expect(panel()).toContain("Archived");
  });

  test("a click on a control inside the card (move, archive, reassign, criteria) does not open it", async () => {
    const cards = await board(T());
    click(cards.t_9, true);
    expect(view().open).toBe(false);
  });

  test("Enter and Space on the focused card open it; other keys and keys inside a control do not", async () => {
    const cards = await board(T());
    const key = (k: string, target: any) => { const e = { key: k, target, prevented: false, preventDefault() { this.prevented = true; } }; cards.t_9.handlers.keydown(e); return e; };
    expect(key("a", cards.t_9).prevented).toBe(false);
    expect(view().open).toBe(false);
    expect(key("Enter", { other: true }).prevented).toBe(false);           // from a button inside the card
    expect(view().open).toBe(false);
    expect(key(" ", cards.t_9).prevented).toBe(true);                      // Space must not scroll the page
    expect(view().open).toBe(true);
    view().close();
    expect(key("Enter", cards.t_9).prevented).toBe(true);
    expect(view().open).toBe(true);
  });

  test("the dialog offers the card's actions: moves, archive, reassign", async () => {
    const cards = await board(T({ status: "done" }), T({ id: "t_8", title: "other", status: "in_progress" }));
    click(cards.t_9);
    const html = (els["ticket-view-actions"].innerHTML as string) + (els["ticket-view-row-actions"].innerHTML as string);
    expect(html).toContain('class="ticket-archive" data-ticket="t_9" data-archive="true">Archive</button>');
    expect(html).not.toContain('data-to=');                                // done: no moves
    expect(html).not.toContain("ticket-move");
    view().close();
    click(cards.t_8);
    const html2 = (els["ticket-view-actions"].innerHTML as string) + (els["ticket-view-row-actions"].innerHTML as string);
    expect(els["ticket-view-row-actions"].innerHTML).toContain('data-cancel="1">Cancel ticket</button>');   // in the bottom row, not the content
    expect(els["ticket-view-actions"].innerHTML).not.toContain("Cancel ticket");
    expect(html2).toContain('class="ticket-move" data-ticket="t_8" data-current="in_progress"');
    expect(html2).not.toContain("To review");
    expect(html2).toContain('class="ticket-assign" data-ticket="t_8"');
  });

  test("the dialog's buttons are wired like the card's", async () => {
    const cards = await board(T());
    const move: any = { dataset: { ticket: "t_9", to: "in_review" }, handlers: {} };
    move.addEventListener = (type: string, fn: () => unknown) => { move.handlers[type] = fn; };
    const sel = ".ticket-actions button[data-to], #ticket-view-row-actions button[data-to]";
    els["ticket-view-row-actions"].querySelectorAll = (q: string) => { els["ticket-view-row-actions"].queried.push(q); return q === sel ? [move] : []; };
    click(cards.t_9);
    expect(els["ticket-view-row-actions"].queried).toEqual(expect.arrayContaining([".ticket-archive", sel]));
    expect(actions().queried).toEqual(expect.arrayContaining([".ticket-assign", ".ticket-move"]));
    await move.handlers.click();
    expect(posts.at(-1)).toEqual({ path: "/tickets/t_9/transition", body: { by: "human", to: "in_review" } });
  });

  test("Close, a click on the backdrop, and Escape (the native close) all close it; a click inside does not", async () => {
    const cards = await board(T());
    click(cards.t_9);
    view().handlers.click({ target: { inside: true } });
    expect(view().open).toBe(true);
    els["ticket-view-close"].handlers.click();
    expect(view().open).toBe(false);
    click(cards.t_9);
    view().handlers.click({ target: view() });                              // the backdrop is the dialog itself
    expect(view().open).toBe(false);
    click(cards.t_9);
    view().close();                                                          // what Escape does
    expect(view().open).toBe(false);
  });

  test("closing returns the focus to the card, or to its replacement after a redraw", async () => {
    const cards = await board(T());
    click(cards.t_9);
    els["ticket-view-close"].handlers.click();
    expect(active).toBe(cards.t_9);
    click(cards.t_9);
    cards.t_9.isConnected = false;                                           // a redraw replaced the card
    const replacement = fakeCard("t_9");
    found = (sel: string) => (sel === '.ticket-card[data-ticket="t_9"]' ? replacement : null);
    els["ticket-view-close"].handlers.click();
    expect(active).toBe(replacement);
  });

  test("a live ticket event updates the open dialog", async () => {
    const cards = await board(T({ version: 5 }));
    click(cards.t_9);
    ctx.TicketBoard.onTicket({ ticket_id: "t_9", version: 6, snapshot: T({ version: 6, title: "Renamed", status: "in_review", assignee: "bob" }) });
    expect(els["ticket-view-title"].textContent).toBe("Renamed");
    expect(head()).toContain("In review");
    expect(panel()).toContain("bob");
    expect(view().open).toBe(true);
  });

  test("an approval verdict updates the open dialog", async () => {
    const cards = await board(T({ blast_radius: "high", approval_request_id: "abcde", approval: { id: "abcde", status: "pending", resolved_by: null, version: 1 } }));
    click(cards.t_9);
    expect(content()).toContain("Waiting for your approval.");
    expect(content()).toContain("asks to move this high-radius ticket to Done.");
    expect(content()).toContain('data-approval="deny" data-request="abcde"');
    expect(content()).toContain('data-approval="allow" data-request="abcde"');
    observers.permission({ kind: "permission.resolved", permission_id: "abcde", version: 9, snapshot: { id: "abcde", tool_name: "ticket:done", input_preview: JSON.stringify({ ticket_id: "t_9" }), status: "allowed", resolved_by: "human", version: 9 } });
    expect(content()).toContain("Approved by human · abcde");
    expect(content()).not.toContain("data-approval=");                       // the banner is gone once the request is answered
  });

  test("the keyboard stays on the same control after a live redraw", async () => {
    const cards = await board(T());
    click(cards.t_9);
    const btn: any = { dataset: { to: "in_review" }, focus() { active = btn; } };
    actions().contains = (n: any) => n === btn;
    actions().querySelector = (sel: string) => (sel === 'button[data-to="in_review"]' ? btn : null);
    active = btn;
    ctx.TicketBoard.onTicket({ ticket_id: "t_9", version: 7, snapshot: T({ version: 7, title: "Again" }) });
    expect(active).toBe(btn);
  });

  test("when the board switches room, the dialog closes", async () => {
    const cards = await board(T());
    click(cards.t_9);
    ctx.SELECTED_ROOM = "r2";
    list = [];
    await ctx.TicketBoard.load();
    expect(view().open).toBe(false);
  });

  test("a ticket that is gone closes the dialog", async () => {
    const cards = await board(T());
    click(cards.t_9);
    ctx.TicketBoard._tickets.delete("t_9");
    ctx.TicketBoard.setFilter(ctx.TicketBoard._filter());                    // any redraw
    expect(view().open).toBe(false);
  });
});

describe("reconnect of the UI stream", () => {
  // main.js: es.onopen calls window.syncTicketBoard?.(). Ambient entries are not replayed after a reconnect.
  const reads = (paths: string[]) => paths.filter((p) => p.startsWith("/tickets?") || p.startsWith("/rooms/"));
  let paths: string[];
  beforeEach(() => {
    paths = [];
    const base = ctx.authedFetch;
    ctx.authedFetch = async (path: string, init?: any) => { if (!init) paths.push(path); return base(path, init); };
  });

  test("an open board re-reads its tickets and the room lead", async () => {
    bodyClasses.add("board-open");
    ctx.syncTicketBoard();
    await settle();
    expect(reads(paths)).toEqual(expect.arrayContaining(["/tickets?room=r&status=all", "/rooms/r/lead"]));
  });

  test("a closed board re-reads only the room lead (the top bar shows it); the tickets wait for the board to open", async () => {
    ctx.syncTicketBoard();
    await settle();
    expect(reads(paths)).toEqual(["/rooms/r/lead"]);
  });

  const mkT = (id: string, extra: object = {}) => ({ ...ticket("", null), id, title: id, status: "done", archived_at_ms: null, blast_radius: "low", priority: "medium", approval_request_id: null, assignee: null, ...extra });
  const shown = () => [...cols.innerHTML.matchAll(/<div class="ticket-title">(\w+)<\/div>/g)].map((m) => m[1]).sort();

  test("a ticket archived while the stream was down is hidden after the reconnect read", async () => {
    list = [mkT("keep"), mkT("gone")];
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
    expect(shown()).toEqual(["gone", "keep"]);
    list = [mkT("keep")];                                           // the hub's default list omits the archived one
    bodyClasses.add("board-open");
    ctx.syncTicketBoard();
    await settle();
    expect(shown()).toEqual(["keep"]);
    // ... and Show archived brings it back with the hub's real data.
    list = [mkT("keep"), mkT("gone", { archived_at_ms: 77 })];
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), showArchived: true });
    await settle();
    expect(shown()).toEqual(["gone", "keep"]);
    expect(ctx.TicketBoard._tickets.get("gone").archived_at_ms).toBe(77);
  });

  test("a ticket whose event arrived during the read is not mistaken for an archived one", async () => {
    list = [mkT("keep")];
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
    let release!: () => void;
    gate = new Promise((r) => { release = r; });
    list = [mkT("keep")];                                           // the read was taken before "new" existed
    const loading = ctx.TicketBoard.load();
    await settle();
    ctx.TicketBoard.onTicket({ ticket_id: "new", version: 50, snapshot: { ...mkT("new", { status: "queued" }), version: 50 } });
    release();
    await loading;
    expect(shown()).toEqual(["keep", "new"]);
  });

  test("a list that hit the row limit proves nothing about the tickets it omits", async () => {
    const full = Array.from({ length: 500 }, (_, i) => mkT(`f${String(i).padStart(3, "0")}`));
    list = [...full, mkT("tail")];
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();                                    // 501 known (the stub does not cut)
    list = full;                                                     // the hub's list: exactly the limit, "tail" cut off
    bodyClasses.add("board-open");
    ctx.syncTicketBoard();
    await settle();
    expect(ctx.TicketBoard._tickets.get("tail").archived_at_ms).toBeNull();      // not mistaken for archived
    list = full.slice(0, 499);                                       // shorter than the limit: complete, so f499 is archived
    ctx.TicketBoard._tickets.set("f499", { ...mkT("f499"), version: 1 });
    ctx.syncTicketBoard();
    await settle();
    expect(ctx.TicketBoard._tickets.get("f499").archived_at_ms).toBeTruthy();
  });

  test("with Show archived on, an absent ticket is left alone", async () => {
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), showArchived: true });
    list = [mkT("a"), mkT("b")];
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
    list = [mkT("a")];
    await ctx.TicketBoard.load();
    expect(ctx.TicketBoard._tickets.get("b").archived_at_ms).toBeNull();
  });
});

describe("ticket notes", () => {
  const N = (id: number, author: string, text: string, at = 1791960000000 + id) => ({ id, author, text, created_at_ms: at });
  const T = (id: string, count: number, extra: object = {}) => ({
    ...ticket("", null), id, title: id, status: "in_review", blast_radius: "low", priority: "medium", assignee: "alice",
    approval_request_id: null, archived_at_ms: null, notes_count: count, ...extra,
  });
  // 15.3: the card shows a notes counter; the notes themselves are in the dialog (opened with openView).
  const detailsOf = () => (els["ticket-view-content"].innerHTML + els["ticket-view-notes"].innerHTML) as string;
  const cardNotes = () => /title="Notes">.*?<\/svg>(\d+)<\/span>/s.exec(cols.innerHTML)?.[1];
  const open = (id: string) => ctx.TicketBoard.openView(id);
  async function show(...tickets: any[]) {
    list = tickets;
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
  }

  test("a card shows a notes counter, not a Notes section; a ticket with no notes shows no counter", async () => {
    await show(T("a", 2), T("b", 0));
    expect(cardNotes()).toBe("2");
    expect(cols.innerHTML).not.toContain('class="ticket-notes"');
    expect(cols.innerHTML.match(/title="Notes"/g)?.length).toBe(1);               // b has none
  });

  test("opening the dialog reads the notes once and shows author, time and text", async () => {
    notesOnHub.a = [N(1, "alice", "Built in a.ts"), N(2, "bob", "Tested: 5 pass")];
    await show(T("a", 2));
    expect(notesFetches).toEqual([]);                                             // nothing is read until it is opened
    open("a"); await settle();
    expect(notesFetches).toEqual(["a"]);
    const html = detailsOf();
    for (const text of ["alice", "Built in a.ts", "bob", "Tested: 5 pass", "<time>"]) expect(html).toContain(text);
    els["ticket-view"].close();
    open("a"); await settle();
    expect(notesFetches).toEqual(["a"]);                                          // cached: no second read
  });

  test("an open dialog keeps its notes through a board redraw", async () => {
    notesOnHub.a = [N(1, "alice", "x")];
    await show(T("a", 1));
    open("a"); await settle();
    ctx.TicketBoard.setFilter(ctx.TicketBoard._filter());                          // any redraw
    expect(detailsOf()).toContain('Notes <span class=\"ticket-view-count\">1</span>');
    expect(detailsOf()).toContain("ticket-note-text");
  });

  test("a live note is added to a list that is already read, once, and the count follows", async () => {
    notesOnHub.a = [N(1, "alice", "first")];
    await show(T("a", 1));
    open("a"); await settle();
    const live = { kind: "ticket.noted", ticket_id: "a", room: "r", notes_count: 2, note: N(2, "alice", "second") };
    observers.ticket(live);
    observers.ticket(live);                                                         // a repeat adds nothing
    expect(detailsOf()).toContain('Notes <span class=\"ticket-view-count\">2</span>');
    expect(detailsOf()).toContain("second");
    expect((detailsOf().match(/ticket-note-text/g) ?? []).length).toBe(2);
    expect(cardNotes()).toBe("2");
    expect(notesFetches).toEqual(["a"]);                                            // no re-read needed
  });

  test("a live note for a list not read yet only moves the count", async () => {
    await show(T("a", 1));
    observers.ticket({ kind: "ticket.noted", ticket_id: "a", room: "r", notes_count: 2, note: N(2, "alice", "second") });
    expect(cardNotes()).toBe("2");
    expect(notesFetches).toEqual([]);
  });

  test("a ticket.noted entry is never read as a ticket snapshot", async () => {
    await show(T("a", 1, { version: 9 }));
    observers.ticket({ kind: "ticket.noted", ticket_id: "a", room: "r", version: 4, notes_count: 2, text: "[note on a]", note: N(5, "a", "x") });
    expect(ctx.TicketBoard._tickets.get("a").version).toBe(9);
    expect(ctx.TicketBoard._tickets.size).toBe(1);
  });

  test("a note for another room or an unknown ticket is ignored", async () => {
    await show(T("a", 1));
    observers.ticket({ kind: "ticket.noted", ticket_id: "a", room: "elsewhere", notes_count: 5, note: N(9, "x", "y") });
    observers.ticket({ kind: "ticket.noted", ticket_id: "ghost", room: "r", notes_count: 1, note: N(9, "x", "y") });
    expect(cardNotes()).toBe("1");
    expect(ctx.TicketBoard._tickets.has("ghost")).toBe(false);
  });

  test("a move that carried a note (ticket.update with a higher notes_count) refreshes an open list", async () => {
    notesOnHub.a = [N(1, "alice", "first")];
    await show(T("a", 1, { version: 5 }));
    open("a"); await settle();
    notesOnHub.a = [N(1, "alice", "first"), N(2, "alice", "Built X. Tested Y.")];
    observers.ticket({ kind: "ticket.update", ticket_id: "a", version: 6, notes_count: 2, snapshot: T("a", 0, { version: 6 }) });
    await settle();
    expect(notesFetches).toEqual(["a", "a"]);
    expect(detailsOf()).toContain("Built X. Tested Y.");
    expect(detailsOf()).toContain('Notes <span class=\"ticket-view-count\">2</span>');
  });

  test("an update without notes_count keeps the known count", async () => {
    await show(T("a", 3, { version: 5 }));
    observers.ticket({ kind: "ticket.update", ticket_id: "a", version: 6, snapshot: { ...T("a", 0), notes_count: undefined, version: 6, title: "renamed" } });
    expect(cardNotes()).toBe("3");
  });

  test("the list read carries notes_count into the card", async () => {
    await show(T("a", 4));
    expect(cardNotes()).toBe("4");
  });

  test("author and text are escaped", async () => {
    ctx.escHtml = (s: unknown) => String(s).replace(/</g, "&lt;");
    notesOnHub.a = [N(1, "<b>al", "<script>x</script>")];
    await show(T("a", 1));
    open("a"); await settle();
    expect(detailsOf()).toContain("&lt;b>al");
    expect(detailsOf()).toContain("&lt;script>x");
    expect(detailsOf()).not.toContain("<script>");
  });

  test("the full view shows the notes, reads them when it opens, and follows live notes", async () => {
    notesOnHub.a = [N(1, "alice", "Built in a.ts")];
    const card: any = { dataset: { ticket: "a" }, isConnected: true, handlers: {}, addEventListener(t: string, f: any) { this.handlers[t] = f; }, focus() {} };
    cols.querySelectorAll = (q: string) => (q === ".ticket-card" ? [card] : []);
    await show(T("a", 1));
    card.handlers.click({ target: { closest: () => null } });
    await settle();
    const content = () => (els["ticket-view-content"].innerHTML + els["ticket-view-notes"].innerHTML) as string;
    expect(notesFetches).toEqual(["a"]);
    expect(content()).toContain('Notes <span class=\"ticket-view-count\">1</span>');
    expect(content()).toContain("Built in a.ts");
    observers.ticket({ kind: "ticket.noted", ticket_id: "a", room: "r", notes_count: 2, note: N(2, "alice", "Tested: ok") });
    expect(content()).toContain('Notes <span class=\"ticket-view-count\">2</span>');
    expect(content()).toContain("Tested: ok");
  });

  test("the full view says so when there are no notes", async () => {
    const card: any = { dataset: { ticket: "a" }, isConnected: true, handlers: {}, addEventListener(t: string, f: any) { this.handlers[t] = f; }, focus() {} };
    cols.querySelectorAll = (q: string) => (q === ".ticket-card" ? [card] : []);
    await show(T("a", 0));
    card.handlers.click({ target: { closest: () => null } });
    expect((els["ticket-view-content"].innerHTML + els["ticket-view-notes"].innerHTML)).toContain('Notes <span class=\"ticket-view-count\">0</span>');
    expect((els["ticket-view-content"].innerHTML + els["ticket-view-notes"].innerHTML)).toContain("No notes");
    expect(notesFetches).toEqual([]);
  });

  test("a room change forgets the notes: they are not read again until the dialog opens", async () => {
    notesOnHub.a = [N(1, "alice", "x")];
    await show(T("a", 1));
    open("a"); await settle();
    els["ticket-view"].close();
    ctx.SELECTED_ROOM = "r2";
    list = [T("a", 1, { room: "r2" })];
    await ctx.TicketBoard.load();
    expect(notesFetches).toEqual(["a"]);                                            // not read again until opened
  });
});

describe("ticket notes: races and failures", () => {
  const N = (id: number, text: string) => ({ id, author: "alice", text, created_at_ms: id });
  const T = (id: string, count: number, extra: object = {}) => ({
    ...ticket("", null), id, title: id, status: "in_review", blast_radius: "low", priority: "medium", assignee: "alice",
    approval_request_id: null, archived_at_ms: null, notes_count: count, ...extra,
  });
  const count = (id: string) => ctx.TicketBoard._tickets.get(id).notes_count;
  const viewHtml = () => (els["ticket-view-content"].innerHTML + els["ticket-view-notes"].innerHTML) as string;
  async function show(...tickets: any[]) {
    list = tickets;
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
  }
  // Holds the notes read until released; returns the release function with the answer.
  function holdNotes() {
    let finish!: (r: any) => void;
    const normal = ctx.authedFetch;
    ctx.authedFetch = (path: string, init?: any) => (path.endsWith("/notes") ? new Promise((r) => { finish = r; }) : normal(path, init));
    return { answer: (items: any[]) => finish({ ok: true, json: async () => items }), fail: () => finish({ ok: false }) };
  }

  test("1. a live note that arrived while the read was in flight survives the read (merge by id, never replace)", async () => {
    await show(T("a", 1));
    const held = holdNotes();
    ctx.TicketBoard.openView("a");
    observers.ticket({ kind: "ticket.noted", ticket_id: "a", room: "r", notes_count: 2, note: N(7, "live new note") });
    held.answer([N(6, "old note")]);
    await settle();
    expect(viewHtml()).toContain("live new note");
    expect(viewHtml()).toContain("old note");
    expect(viewHtml().indexOf("live new note")).toBeLessThan(viewHtml().indexOf("old note"));   // newest first
  });

  test("1b. a read that repeats a note the board already has does not duplicate it", async () => {
    await show(T("a", 2));
    const held = holdNotes();
    ctx.TicketBoard.openView("a");
    observers.ticket({ kind: "ticket.noted", ticket_id: "a", room: "r", notes_count: 2, note: N(7, "same") });
    held.answer([N(6, "old"), N(7, "same")]);
    await settle();
    expect((viewHtml().match(/ticket-note-text/g) ?? []).length).toBe(2);
  });

  test("2. a late ticket list cannot lower the note count", async () => {
    await show(T("a", 1));
    let finish!: () => void;
    gate = new Promise<void>((r) => { finish = r; });
    const loading = ctx.TicketBoard.load();                                   // the read was taken at count 1
    observers.ticket({ kind: "ticket.noted", ticket_id: "a", room: "r", notes_count: 2, note: N(7, "new") });
    finish();
    await loading;
    expect(count("a")).toBe(2);
  });

  test("2b. a list with a higher count raises it", async () => {
    await show(T("a", 1));
    list = [T("a", 4)];
    await ctx.TicketBoard.load();
    expect(count("a")).toBe(4);
  });

  test("3. an older ticket.noted entry cannot lower the count", async () => {
    await show(T("a", 1));
    for (const n of [3, 2, 1]) observers.ticket({ kind: "ticket.noted", ticket_id: "a", room: "r", notes_count: n, note: N(10 + n, `n${n}`) });
    expect(count("a")).toBe(3);
  });

  test("3b. an older ticket.update cannot lower the count either", async () => {
    await show(T("a", 3, { version: 5 }));
    observers.ticket({ kind: "ticket.update", ticket_id: "a", version: 6, notes_count: 1, snapshot: T("a", 0, { version: 6 }) });
    expect(count("a")).toBe(3);
  });

  test("4. a failed notes read is not retried by a redraw", async () => {
    await show(T("a", 1));
    let calls = 0;
    const normal = ctx.authedFetch;
    ctx.authedFetch = (path: string, init?: any) => (path.endsWith("/notes") ? (++calls, Promise.resolve({ ok: false })) : normal(path, init));
    ctx.TicketBoard.openView("a");
    await settle();
    expect(calls).toBe(1);
    for (let i = 0; i < 5; i++) ctx.TicketBoard.setFilter(ctx.TicketBoard._filter());     // redraws
    observers.ticket({ kind: "ticket.update", ticket_id: "a", version: 9, snapshot: T("a", 0, { version: 9, title: "x" }) });
    await settle();
    expect(calls).toBe(1);
    expect(viewHtml()).toContain("Could not read the notes");
    expect(viewHtml()).toContain("ticket-notes-retry");
  });

  test("4b. a thrown read failure is not retried by a redraw either", async () => {
    await show(T("a", 1));
    let calls = 0;
    const normal = ctx.authedFetch;
    ctx.authedFetch = (path: string, init?: any) => (path.endsWith("/notes") ? (++calls, Promise.reject(new Error("net"))) : normal(path, init));
    ctx.TicketBoard.openView("a");
    await settle();
    ctx.TicketBoard.setFilter(ctx.TicketBoard._filter());
    await settle();
    expect(calls).toBe(1);
  });

  test("4c. the Retry button, and opening the view again, read again", async () => {
    await show(T("a", 1));
    let calls = 0, ok = false;
    const normal = ctx.authedFetch;
    ctx.authedFetch = (path: string, init?: any) =>
      path.endsWith("/notes") ? (++calls, Promise.resolve(ok ? { ok: true, json: async () => [N(1, "fine")] } : { ok: false })) : normal(path, init);
    const retry: any = { dataset: { ticket: "a" }, handlers: {} as Record<string, () => void> };
    retry.addEventListener = (type: string, fn: () => void) => { retry.handlers[type] = fn; };
    els["ticket-view-notes"].querySelectorAll = (q: string) => (q === ".ticket-notes-retry" ? [retry] : []);
    ctx.TicketBoard.openView("a");
    await settle();
    expect(calls).toBe(1);
    ok = true;
    retry.handlers.click();                                                    // explicit
    await settle();
    expect(calls).toBe(2);
    expect(viewHtml()).toContain("fine");
    // a second failure, then reopening the view (explicit) reads again
    ok = false;
    ctx.TicketBoard._tickets.get("a").notes_count = 2;                         // stale list: needs a read
    ctx.TicketBoard.closeView();
    ctx.TicketBoard.openView("a");
    await settle();
    expect(calls).toBe(3);
    ctx.TicketBoard.closeView();
    ok = true;
    ctx.TicketBoard.openView("a");
    await settle();
    expect(calls).toBe(4);
  });

  test("4e. a redraw that recreates <details open> (its queued toggle) is not an explicit retry", async () => {
    await show(T("a", 1));
    let calls = 0;
    const normal = ctx.authedFetch;
    ctx.authedFetch = (path: string, init?: any) => (path.endsWith("/notes") ? (++calls, Promise.resolve({ ok: false })) : normal(path, init));
    const fresh = () => {
      const d: any = { dataset: { ticket: "a" }, open: false, handlers: {} as Record<string, () => void> };
      d.addEventListener = (type: string, fn: () => void) => { d.handlers[type] = fn; };
      return d;
    };
    let current = fresh();
    cols.querySelectorAll = (q: string) => (q === ".ticket-notes" ? [current] : []);
    ctx.TicketBoard.setFilter(ctx.TicketBoard._filter());                       // draw
    current.open = true; current.handlers.toggle();                              // the human opens it: explicit
    await settle();
    expect(calls).toBe(1);
    for (let i = 0; i < 4; i++) {
      current = fresh();                                                         // a redraw creates a new element ...
      ctx.TicketBoard.setFilter(ctx.TicketBoard._filter());
      current.open = true;                                                       // ... as <details open>, and the browser fires its toggle
      current.handlers.toggle();
      await settle();
    }
    expect(calls).toBe(1);                                                       // never retried by a redraw
    current.open = false; current.handlers.toggle();                             // closing and opening again is explicit
    current.open = true; current.handlers.toggle();
    await settle();
    expect(calls).toBe(2);
  });

  test("4d. opening a card's notes section is an explicit read, even after a failure", async () => {
    await show(T("a", 1));
    let calls = 0;
    const normal = ctx.authedFetch;
    ctx.authedFetch = (path: string, init?: any) => (path.endsWith("/notes") ? (++calls, Promise.resolve({ ok: false })) : normal(path, init));
    const d: any = { dataset: { ticket: "a" }, open: false, handlers: {} as Record<string, () => void> };
    d.addEventListener = (type: string, fn: () => void) => { d.handlers[type] = fn; };
    cols.querySelectorAll = (q: string) => (q === ".ticket-notes" ? [d] : []);
    await show(T("a", 1));
    d.open = true; d.handlers.toggle();
    await settle();
    expect(calls).toBe(1);
    ctx.TicketBoard.setFilter(ctx.TicketBoard._filter());
    await settle();
    expect(calls).toBe(1);                                                      // the redraw did not retry
    d.open = false; d.handlers.toggle();
    d.open = true; d.handlers.toggle();                                         // the human opens it again
    await settle();
    expect(calls).toBe(2);
  });
});

describe("room lead in the top bar", () => {
  const wrap = () => els["ticket-lead-wrap"];
  const sel = () => els["ticket-lead"];
  let leadFetches: string[];
  beforeEach(() => {
    leadFetches = [];
    const base = ctx.authedFetch;
    ctx.authedFetch = async (path: string, init?: any) => {
      if (path.startsWith("/rooms/") && !init) { leadFetches.push(path); return { ok: true, json: async () => ({ room: "r", lead: "alice" }) }; }
      return base(path, init);
    };
  });

  test("it works with the board closed: the lead is shown for the selected room without opening the board", async () => {
    ctx.syncTicketBoard();                                                      // what main.js calls on connect
    await settle();
    expect(bodyClasses.has("board-open")).toBe(false);
    expect(leadFetches).toEqual(["/rooms/r/lead"]);
    expect(wrap().hidden).toBe(false);
    expect(sel().value).toBe("alice");
    expect(ctx.TicketBoard._lead()).toBe("alice");
  });

  test("with All rooms selected the control is hidden and disabled, and nothing is read", async () => {
    ctx.SELECTED_ROOM = "__ALL__";
    leadFetches.length = 0;
    ctx.syncTicketBoard();
    await settle();
    expect(leadFetches).toEqual([]);
    expect(wrap().hidden).toBe(true);
    expect(sel().disabled).toBe(true);
    await ctx.TicketBoard.setLead("bob");                                       // a stray call posts nothing
    expect(posts.filter((p) => p.path.startsWith("/rooms/"))).toEqual([]);
  });

  test("it follows a room change (the room filter event) and shows the new room's lead", async () => {
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();                                               // cubilot:room-filter runs load()
    await settle();
    expect(leadFetches).toContain("/rooms/r2/lead");
    expect(wrap().hidden).toBe(false);
  });

  test("it lists the selected room's agents (never the human), even with the board never loaded for that room", async () => {
    ctx.syncTicketBoard();
    await settle();
    expect(sel().innerHTML).toContain('<option value="">No lead</option>');
    expect(sel().innerHTML).toContain('value="alice"');
    expect(sel().innerHTML).toContain('value="bob"');
    expect(sel().innerHTML).not.toContain("human");
    expect(sel().innerHTML).not.toContain("carol");                            // another room
  });

  test("a roster change redraws the list (roster.js calls refreshRoomLead)", async () => {
    ctx.syncTicketBoard();
    await settle();
    ctx.ROSTER.push({ name: "dave", room: "r" });
    expect(sel().innerHTML).not.toContain("dave");
    ctx.refreshRoomLead();
    expect(sel().innerHTML).toContain('value="dave"');
  });

  test("a live room.lead entry updates it with the board closed; another room's entry is ignored", async () => {
    ctx.syncTicketBoard();
    await settle();
    observers.room({ kind: "room.lead", room: "r", lead: "bob" });
    expect(sel().value).toBe("bob");
    observers.room({ kind: "room.lead", room: "elsewhere", lead: "alice" });
    expect(sel().value).toBe("bob");
  });

  test("choosing a lead posts it as the human for the selected room", async () => {
    ctx.syncTicketBoard();
    await settle();
    posts = [];
    sel().value = "bob";
    await sel().handlers.change({ target: sel() });
    expect(posts.at(-1)).toEqual({ path: "/rooms/r/lead", body: { by: "human", agent: "bob" } });
  });

  test("the control is in the top bar markup, not in the board's filter row", () => {
    const html = readFileSync("ui/index.html", "utf8");
    const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
    expect(header).toContain('id="ticket-lead"');
    expect(header).toContain('id="ticket-lead-wrap"');
    const filters = html.slice(html.indexOf('id="ticket-filters"'), html.indexOf('id="ticket-board-columns"'));
    expect(filters).not.toContain("ticket-lead");
    // it sits after the agent names (legend) and the add button, in the roster row
    const roster = header.slice(header.indexOf('class="roster"'), header.indexOf('class="status-cluster"'));
    expect(roster.indexOf('id="legend"')).toBeLessThan(roster.indexOf('id="ticket-lead"'));
    expect(roster.indexOf('id="add-agent-btn"')).toBeLessThan(roster.indexOf('id="ticket-lead"'));
  });
});

describe("filters panel", () => {
  const btn = () => els["ticket-filters-btn"];
  const panel = () => els["ticket-filter-panel"];
  const fire = (type: string, e: any) => { for (const fn of docListeners[type] ?? []) fn(e); };
  const click = (target: any = {}) => fire("click", { target });
  const key = (k: string) => { const e = { key: k, prevented: false, preventDefault() { this.prevented = true; } }; fire("keydown", e); return e; };
  const set = (f: object) => ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), ...f });
  const all5 = ["highest", "high", "medium", "low", "lowest"];

  test("the button says Filters, and Filters · N with the number of active dimensions", () => {
    expect(btn().textContent).toBe("Filters");
    expect(btn().classes.has("active")).toBe(false);
    set({ radius: "high" });
    expect(btn().textContent).toBe("Filters · 1");
    set({ priorities: ["high", "low"] });
    expect(btn().textContent).toBe("Filters · 2");
    set({ showArchived: true });
    set({ showCancelled: true });
    expect(btn().textContent).toBe("Filters · 4");
    expect(btn().classes.has("active")).toBe(true);
    expect(btn().attrs["aria-label"]).toBe("Filters, 4 active");
    ctx.TicketBoard.setFilter({ radius: "all", priorities: all5 });             // Reset
    expect(btn().textContent).toBe("Filters");
    expect(btn().attrs["aria-label"]).toBe("Filters");
  });

  test("the button opens the panel (aria-expanded, focus on the chosen radius) and toggles it shut", () => {
    expect(panel().hidden).toBe(true);
    btn().handlers.click();
    expect(panel().hidden).toBe(false);
    expect(btn().attrs["aria-expanded"]).toBe("true");
    expect(active).toBe(els["ticket-filter-radius-all"]);
    btn().handlers.click();
    expect(panel().hidden).toBe(true);
    expect(btn().attrs["aria-expanded"]).toBe("false");
    set({ radius: "low" });
    btn().handlers.click();
    expect(active).toBe(els["ticket-filter-radius-low"]);                        // the selected segment gets the focus
  });

  test("Done closes it and returns the focus to the button", () => {
    btn().handlers.click();
    active = els["ticket-filter-done"];
    els["ticket-filter-done"].handlers.click();
    expect(panel().hidden).toBe(true);
    expect(active).toBe(btn());
  });

  test("Escape closes it and returns the focus to the button; Escape with it closed does nothing", () => {
    expect(key("Escape").prevented).toBe(false);
    btn().handlers.click();
    expect(key("a").prevented).toBe(false);
    expect(panel().hidden).toBe(false);
    active = els["ticket-filter-radius-all"];
    expect(key("Escape").prevented).toBe(true);
    expect(panel().hidden).toBe(true);
    expect(active).toBe(btn());
  });

  test("a click outside closes it; a click inside, or on the button, does not", () => {
    btn().handlers.click();
    click({ inPanel: true });
    expect(panel().hidden).toBe(false);
    click(btn());                                                                 // the button's own handler toggles it
    expect(panel().hidden).toBe(false);
    click({ outside: true });
    expect(panel().hidden).toBe(true);
  });

  test("after an outside click the focus returns to the button, unless the click put it on another control", () => {
    btn().handlers.click();
    active = null;                                                                // nothing focusable was clicked
    click({ outside: true });
    expect(active).toBe(btn());
    btn().handlers.click();
    const field = { name: "some field" };
    active = field;                                                               // the click focused a field elsewhere
    click({ outside: true });
    expect(panel().hidden).toBe(true);
    expect(active).toBe(field);
  });

  test("changes apply live while the panel stays open", async () => {
    btn().handlers.click();
    els["ticket-filter-p-low"].checked = false;
    els["ticket-filter-p-low"].handlers.change();
    expect(ctx.TicketBoard._filter().priorities).toEqual(["highest", "high", "medium", "lowest"]);
    els["ticket-show-cancelled"].checked = true;
    els["ticket-show-cancelled"].handlers.change({ target: els["ticket-show-cancelled"] });
    expect(ctx.TicketBoard._filter().showCancelled).toBe(true);
    expect(panel().hidden).toBe(false);
    expect(btn().textContent).toBe("Filters · 2");
  });

  test("the radio buttons drive the radius; only the checked one writes it", () => {
    els["ticket-filter-radius-high"].checked = false;                             // an unchecked change is ignored
    els["ticket-filter-radius-high"].handlers.change({ target: els["ticket-filter-radius-high"] });
    expect(ctx.TicketBoard._filter().radius).toBe("all");
    els["ticket-filter-radius-low"].checked = true;
    els["ticket-filter-radius-low"].handlers.change({ target: els["ticket-filter-radius-low"] });
    expect(ctx.TicketBoard._filter().radius).toBe("low");
  });

  test("a room change closes the panel; closing the board (the terminal takes the pane) does too", async () => {
    btn().handlers.click();
    for (const fn of docListeners["cubilot:room-filter"] ?? []) fn({});
    expect(panel().hidden).toBe(true);
    btn().handlers.click();
    for (const fn of docListeners["cubilot:right-pane"] ?? []) fn({ detail: { pane: "terminal" } });
    expect(panel().hidden).toBe(true);
  });

  test("Showing N of M stays next to the button", async () => {
    list = [{ ...ticket("", null), id: "a", title: "a", status: "queued", blast_radius: "high", priority: "medium", approval_request_id: null, assignee: null },
            { ...ticket("", null), id: "b", title: "b", status: "queued", blast_radius: "low", priority: "medium", approval_request_id: null, assignee: null }];
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
    set({ radius: "high" });
    expect(els["ticket-filter-summary"].textContent).toBe("Showing 1 of 2 tickets");
  });

  test("Archive all done is a button in the Done column header only, and it is wired", async () => {
    const mk = (id: string, status: string) => ({ ...ticket("", null), id, title: id, status, blast_radius: "low", priority: "medium", approval_request_id: null, assignee: null, archived_at_ms: null });
    const clicks: Array<() => unknown> = [];
    cols.querySelectorAll = (q: string) => (q === ".ticket-archive-all" ? [{ addEventListener: (_t: string, fn: () => unknown) => clicks.push(fn) }] : []);
    list = [mk("a", "done"), mk("q", "queued")];
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
    expect((cols.innerHTML.match(/ticket-archive-all/g) ?? []).length).toBe(1);
    const inDone = /<h3>Done .*?<\/h3>/s.exec(cols.innerHTML)![0];
    expect(inDone).toContain("Archive all done (1)");
    posts = [];
    await clicks[0]();
    expect(posts.map((p) => p.path)).toEqual(["/tickets/a/archive"]);
  });

  test("the markup follows the mock-up: Filters button, panel with Blast radius, Priority, Also show, and a Reset and Done footer", () => {
    const html = readFileSync("ui/index.html", "utf8");
    const row = html.slice(html.indexOf('id="ticket-filters"'), html.indexOf('id="ticket-board-columns"'));
    const order = ["ticket-filters-btn", "ticket-filter-panel", "Blast radius", "ticket-filter-radius-all", "ticket-filter-radius-high", "ticket-filter-radius-low",
      "Priority", "ticket-filter-p-highest", "ticket-filter-p-lowest", "Also show", "ticket-show-archived", "ticket-show-cancelled", "ticket-filter-reset", "ticket-filter-done"];
    const at = order.map((k) => row.indexOf(k));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);                            // in this order
    expect(row).toContain('id="ticket-filter-panel" role="group" aria-label="Board filters" hidden');
    expect(row).toContain('aria-haspopup="true" aria-expanded="false" aria-controls="ticket-filter-panel"');
    expect(row).not.toContain('<select id="ticket-filter-radius"');                                          // the radius select is gone
    expect(row).not.toContain("ticket-archive-all");                              // Archive all moved to the Done header
    expect((row.match(/type="checkbox"/g) ?? []).length).toBe(7);                 // 5 priorities + Archived + Cancelled
    expect((row.match(/type="radio"/g) ?? []).length).toBe(3);
  });
});

describe("ticket attachments", () => {
  const F = (name: string, size = 100) => ({ name, size });
  const A = (id: number, name: string, url: string, author = "alice") => ({ id, author, name, url, created_at_ms: 1791960000000 + id });
  const T = (id: string, count: number, extra: object = {}) => ({
    ...ticket("", null), id, title: id, status: "in_progress", blast_radius: "low", priority: "medium", assignee: "alice",
    approval_request_id: null, archived_at_ms: null, notes_count: 0, attachments_count: count, ...extra,
  });
  const view = () => (els["ticket-view-content"].innerHTML + els["ticket-view-notes"].innerHTML) as string;
  async function show(...tickets: any[]) {
    list = tickets;
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
  }
  const open = (id: string) => ctx.TicketBoard.openView(id);
  const pick = async (input: any, files: any[]) => { input.files = files; await input.handlers.change(); await settle(); };

  test("a type outside the six, a file with no extension, and a file over 8 MiB are refused with a message", async () => {
    await show(T("a", 0));
    open("a");
    await pick(els["ticket-view-file"], [F("run.exe"), F("README"), F("big.pdf", 8 * 1024 * 1024 + 1), F("logo.svg"), F("noext.")]);
    expect(uploads).toEqual([]);
    expect(messages.map((m) => m.text)).toEqual([
      "Attach failed: run.exe: only pdf, md, txt, png, jpg, jpeg can be attached",
      "Attach failed: README: only pdf, md, txt, png, jpg, jpeg can be attached",
      "Attach failed: big.pdf: larger than 8 MiB",
      "Attach failed: logo.svg: only pdf, md, txt, png, jpg, jpeg can be attached",
      "Attach failed: noext.: only pdf, md, txt, png, jpg, jpeg can be attached",
    ]);
  });

  test("all six types are accepted, in any case, up to exactly 8 MiB", async () => {
    await show(T("a", 0));
    open("a");
    const names = ["a.pdf", "b.md", "c.txt", "d.png", "e.jpg", "f.jpeg", "G.PDF", "h.Jpg"];
    await pick(els["ticket-view-file"], [...names.map((n) => F(n)), F("max.pdf", 8 * 1024 * 1024)]);
    expect(uploads).toEqual([...names, "max.pdf"]);
    expect(messages).toEqual([]);
  });

  test("the view's Attach button opens the file picker", async () => {
    await show(T("a", 0));
    els["ticket-view-attach-btn"].handlers.click();
    expect(els["ticket-view-file"].clicks).toBe(1);
  });

  test("attaching in the view uploads each file, then links it as the human, one at a time and in order", async () => {
    await show(T("a", 0));
    open("a");
    posts = [];
    await pick(els["ticket-view-file"], [F("one.pdf"), F("two.png")]);
    expect(uploads).toEqual(["one.pdf", "two.png"]);
    expect(posts.map((p) => [p.path, p.body])).toEqual([
      ["/tickets/a/attachments", { by: "human", url: "/image/u1.pdf", name: "one.pdf" }],
      ["/tickets/a/attachments", { by: "human", url: "/image/u2.png", name: "two.png" }],
    ]);
    expect(els["ticket-view-attach-status"].textContent).toBe("2 files saved");
    expect(els["ticket-view-file"].value).toBe("");                              // the picker is cleared: the same file can be chosen again
  });

  test("a 250-character file name is cut to 200 characters (extension kept) before it is linked", async () => {
    await show(T("a", 0));
    open("a");
    posts = [];
    await pick(els["ticket-view-file"], [F(`${"y".repeat(246)}.pdf`), F("  two\nlines\u202e.md  ")]);
    expect(posts[0].body.name).toHaveLength(200);
    expect(posts[0].body.name.endsWith(".pdf")).toBe(true);
    expect(posts[1].body.name).toBe("two lines .md");                      // the bidi override became one space
    expect(uploads).toHaveLength(2);
  });

  test("a failed upload or link is reported and the other files still go", async () => {
    await show(T("a", 0));
    open("a");
    uploadFails = true;
    await pick(els["ticket-view-file"], [F("one.pdf")]);
    expect(messages.at(-1).text).toBe("Attach failed: one.pdf: upload refused");
    expect(els["ticket-view-attach-status"].textContent).toBe("");
    uploadFails = false;
    failPath = "/tickets/a/attachments";
    posts = [];
    await pick(els["ticket-view-file"], [F("two.md")]);
    expect(posts.map((p) => p.path)).toEqual(["/tickets/a/attachments"]);
    expect(els["ticket-view-attach-status"].textContent).toBe("");
    expect(messages.some((m) => /Ticket attach failed/.test(m.text))).toBe(true);
  });

  test("the view shows Attachments (N) with name, author, time and a link; No attachments at zero", async () => {
    attachmentsOnHub.a = [A(1, "report.pdf", "/image/x1.pdf"), A(2, "notes.md", "/image/x2.md", "bob")];
    await show(T("a", 2), T("b", 0));
    open("a");
    await settle();
    expect(attachFetches).toEqual(["a"]);
    expect(view()).toContain('Attachments <span class=\"ticket-view-count\">2</span>');
    expect(view()).toContain('href="http://hub/image/x1.pdf?token=T"');
    for (const x of ["report.pdf", "notes.md", "alice", "bob", "<time", ">PDF<", ">MD<"].filter((v) => v !== "<time")) expect(view()).toContain(x);
    ctx.TicketBoard.closeView();
    open("b");
    expect(view()).toContain('Attachments <span class=\"ticket-view-count\">0</span>');
    expect(view()).toContain("No attachments");
    expect(attachFetches).toEqual(["a"]);                                         // none to read
  });

  test("an image is shown as a thumbnail that links to the file; other types get an extension badge", async () => {
    attachmentsOnHub.a = [A(1, "shot.png", "/image/p1.png"), A(2, "photo.jpg", "/image/p2.jpg"), A(3, "doc.txt", "/image/p3.txt")];
    await show(T("a", 3));
    open("a");
    await settle();
    expect((view().match(/class="ticket-attach-thumb"/g) ?? []).length).toBe(2);
    expect(view()).toContain('src="http://hub/image/p1.png?token=T" alt="shot.png"');
    expect(view()).toContain(">TXT<");
    expect(view()).not.toContain('alt="doc.txt"');
  });

  test("names are escaped", async () => {
    ctx.escHtml = (x: unknown) => String(x).replace(/</g, "&lt;");
    ctx.escAttr = (x: unknown) => String(x).replace(/"/g, "&quot;").replace(/</g, "&lt;");
    attachmentsOnHub.a = [A(1, '<img onerror=x>"q".pdf', "/image/e1.pdf", "<b>me")];
    await show(T("a", 1));
    open("a");
    await settle();
    expect(view()).toContain("&lt;img onerror=x>");
    expect(view()).toContain("&lt;b>me");
    expect(view()).not.toContain("<img onerror");
  });

  test("11: each file has Replace and Remove on an open ticket, not on a finished one", async () => {
    attachmentsOnHub.a = [A(1, "one.pdf", "/image/o1.pdf")];
    attachmentsOnHub.b = [A(2, "two.pdf", "/image/o2.pdf")];
    await show(T("a", 1), T("b", 1, { status: "done" }));
    open("a"); await settle();
    expect(view()).toContain('class="ticket-file-replace" data-ticket="a" data-attachment="1"');
    expect(view()).toContain('class="ticket-file-remove" data-ticket="a" data-attachment="1"');
    els["ticket-view"].close();
    open("b"); await settle();
    expect(view()).not.toContain("ticket-file-replace");
    expect(view()).not.toContain("ticket-file-remove");
  });

  test("11: Remove needs a second click and acts at once", async () => {
    attachmentsOnHub.a = [A(1, "one.pdf", "/image/o1.pdf")];
    await show(T("a", 1));
    const btn: any = { dataset: { ticket: "a", attachment: "1" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-file-remove" ? [btn] : []);
    let fire: any = null;
    ctx.setTimeout = (fn: any, ms: number) => { expect(ms).toBe(5000); fire = fn; return 1; };
    posts = [];
    open("a"); await settle();
    btn.handlers.click();
    expect(view()).toContain("Confirm remove");
    expect(posts).toEqual([]);
    fire();
    expect(view()).not.toContain("Confirm remove");
    btn.handlers.click();
    btn.handlers.click();
    expect(posts).toEqual([{ path: "/tickets/a/attachments/1/remove", body: { by: "human" } }]);
    ctx.setTimeout = setTimeout;
    delete els["ticket-view-content"].querySelectorAll;
  });

  test("11: Replace attaches the new file first, then removes the old one; a failed attach removes nothing", async () => {
    attachmentsOnHub.a = [A(1, "one.pdf", "/image/o1.pdf")];
    await show(T("a", 1));
    const btn: any = { dataset: { ticket: "a", attachment: "1" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-file-replace" ? [btn] : []);
    posts = [];
    open("a"); await settle();
    const input = els["ticket-view-replace"];
    btn.handlers.click();
    expect(input.clicks).toBeGreaterThan(0);                                                // the picker opens
    await pick(input, [F("new.pdf")]);
    expect(posts.map((p) => p.path)).toEqual(["/tickets/a/attachments", "/tickets/a/attachments/1/remove"]);   // attach, then remove
    posts = []; uploadFails = true;
    btn.handlers.click();
    await pick(input, [F("newer.pdf")]);
    expect(posts).toEqual([]);                                                              // nothing attached, nothing removed
    expect(els["ticket-view-notice"].innerHTML).toContain("Not saved:");
    uploadFails = false;
    delete els["ticket-view-content"].querySelectorAll;
  });

  test("11: after Attach, Remove and Replace a line says the file was saved; closing clears it", async () => {
    attachmentsOnHub.a = [A(1, "one.pdf", "/image/o1.pdf")];
    await show(T("a", 1));
    const status = () => els["ticket-view-attach-status"].textContent as string;
    const btn: any = { dataset: { ticket: "a", attachment: "1" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-file-replace" ? [btn] : []);
    open("a"); await settle();
    await pick(els["ticket-view-file"], [F("one.pdf")]);
    expect(status()).toBe("File saved");                                       // Attach
    btn.handlers.click();
    await pick(els["ticket-view-replace"], [F("new.pdf")]);
    expect(status()).toBe("File replaced");                                    // Replace: attached, then the old file removed
    els["ticket-view"].close();
    expect(status()).toBe("");
    delete els["ticket-view-content"].querySelectorAll;
  });

  test("11: after a confirmed Remove the line says the file was removed", async () => {
    attachmentsOnHub.a = [A(1, "one.pdf", "/image/o1.pdf")];
    await show(T("a", 1));
    const btn: any = { dataset: { ticket: "a", attachment: "1" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-file-remove" ? [btn] : []);
    ctx.setTimeout = () => 1;
    open("a"); await settle();
    btn.handlers.click(); btn.handlers.click();
    await settle();
    expect(els["ticket-view-attach-status"].textContent).toBe("File removed");
    ctx.setTimeout = setTimeout;
    delete els["ticket-view-content"].querySelectorAll;
  });

  // A file action answers late: its message belongs to the dialog that started it.
  function holdRemoves() {
    const normal = ctx.authedFetch;
    const held: Array<() => void> = [];
    ctx.authedFetch = (path: string, init?: any) =>
      path.endsWith("/remove") ? new Promise((r) => { held.push(() => r(normal(path, init))); }) : normal(path, init);
    return { release: async () => { held.splice(0).forEach((f) => f()); await settle(); }, restore: () => { ctx.authedFetch = normal; } };
  }

  test("11: a late Remove answer shows no message in another ticket's dialog", async () => {
    attachmentsOnHub.a = [A(1, "one.pdf", "/image/o1.pdf")];
    attachmentsOnHub.b = [A(2, "two.pdf", "/image/o2.pdf")];
    await show(T("a", 1), T("b", 1));
    const btn: any = { dataset: { ticket: "a", attachment: "1" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-file-remove" ? [btn] : []);
    ctx.setTimeout = () => 1;
    const h = holdRemoves();
    open("a"); await settle();
    btn.handlers.click(); btn.handlers.click();                                // Remove on A starts; its answer is held
    els["ticket-view"].close();
    open("b"); await settle();
    await h.release();                                                         // the answer for A arrives while B is open
    expect(els["ticket-view-attach-status"].textContent).toBe("");
    els["ticket-view"].close();                                                // the same ticket reopened is a new dialog instance too
    h.restore(); ctx.setTimeout = setTimeout;
    delete els["ticket-view-content"].querySelectorAll;
  });

  test("11: a late Remove answer shows nothing when the same ticket was closed and reopened", async () => {
    attachmentsOnHub.a = [A(1, "one.pdf", "/image/o1.pdf")];
    await show(T("a", 1));
    const btn: any = { dataset: { ticket: "a", attachment: "1" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-file-remove" ? [btn] : []);
    ctx.setTimeout = () => 1;
    const h = holdRemoves();
    open("a"); await settle();
    btn.handlers.click(); btn.handlers.click();
    els["ticket-view"].close();
    open("a"); await settle();
    await h.release();
    expect(els["ticket-view-attach-status"].textContent).toBe("");
    h.restore(); ctx.setTimeout = setTimeout;
    delete els["ticket-view-content"].querySelectorAll;
  });

  test("11: a late Replace failure shows no notice in another ticket's dialog", async () => {
    attachmentsOnHub.a = [A(1, "one.pdf", "/image/o1.pdf")];
    await show(T("a", 1), T("b", 0));
    const btn: any = { dataset: { ticket: "a", attachment: "1" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-file-replace" ? [btn] : []);
    const h = holdRemoves();
    open("a"); await settle();
    failPath = "/tickets/a/attachments/1/remove";
    btn.handlers.click();
    const picking = pick(els["ticket-view-replace"], [F("new.pdf")]);          // attach goes through; the remove is held
    await settle();
    els["ticket-view"].close();
    open("b"); await settle();
    await h.release();
    await picking;
    expect(els["ticket-view-notice"].innerHTML).toBe("");
    expect(els["ticket-view-attach-status"].textContent).toBe("");
    els["ticket-view"].close();
    h.restore(); delete els["ticket-view-content"].querySelectorAll;
  });

  test("11: closing the dialog resets an armed Remove", async () => {
    attachmentsOnHub.a = [A(1, "one.pdf", "/image/o1.pdf")];
    await show(T("a", 1));
    const btn: any = { dataset: { ticket: "a", attachment: "1" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-file-remove" ? [btn] : []);
    ctx.setTimeout = () => 1;
    posts = [];
    open("a"); await settle();
    btn.handlers.click();
    expect(view()).toContain("Confirm remove");
    els["ticket-view"].close();
    open("a"); await settle();
    expect(view()).not.toContain("Confirm remove");                       // the armed state did not survive the close
    btn.handlers.click();
    expect(posts).toEqual([]);                                            // the first click after reopening only arms
    ctx.setTimeout = setTimeout;
    delete els["ticket-view-content"].querySelectorAll;
  });

  test("11: when the remove fails after the attach, the notice names the new and the old file", async () => {
    attachmentsOnHub.a = [A(1, "report.pdf", "/image/o1.pdf")];
    await show(T("a", 1));
    const btn: any = { dataset: { ticket: "a", attachment: "1" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-file-replace" ? [btn] : []);
    open("a"); await settle();
    failPath = "/tickets/a/attachments/1/remove";
    btn.handlers.click();
    await pick(els["ticket-view-replace"], [F("report.pdf")]);               // a replacement with the same file name
    const n = els["ticket-view-notice"].innerHTML as string;
    expect(n).toContain('The new file "report.pdf" is attached');
    expect(n).toContain('the old file "report.pdf" was not removed');
    expect(n).toContain("Remove the old file by hand");
    delete els["ticket-view-content"].querySelectorAll;
  });

  test("11: when the hub answers the attach with the attachment being replaced, nothing is removed", async () => {
    attachmentsOnHub.a = [A(1, "report.pdf", "/image/o1.pdf")];
    await show(T("a", 1));
    const btn: any = { dataset: { ticket: "a", attachment: "1" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-file-replace" ? [btn] : []);
    open("a"); await settle();
    attachReplyId = 1;                                                      // the same file: the hub's attach is idempotent
    posts = [];
    btn.handlers.click();
    await pick(els["ticket-view-replace"], [F("report.pdf")]);
    expect(posts.map((p) => p.path)).toEqual(["/tickets/a/attachments"]);   // no remove: it would delete the only copy
    expect(els["ticket-view-notice"].innerHTML).toContain("Nothing was replaced");
    delete els["ticket-view-content"].querySelectorAll;
  });

  test("11: a ticket.detached event lowers the count and drops the file from the open list", async () => {
    attachmentsOnHub.a = [A(1, "one.pdf", "/image/o1.pdf"), A(2, "two.pdf", "/image/o2.pdf")];
    await show(T("a", 2));
    open("a"); await settle();
    expect(view()).toContain('Attachments <span class=\"ticket-view-count\">2</span>');
    observers["ticket"]({ kind: "ticket.detached", ticket_id: "a", room: "r", attachments_count: 1, attachment_id: 1, version: 9 });
    expect(view()).toContain('Attachments <span class=\"ticket-view-count\">1</span>');
    expect(view()).not.toContain("one.pdf");
    expect(view()).toContain("two.pdf");
  });

  test("a live ticket.attached entry is merged into a list already read, once, and the count follows", async () => {
    attachmentsOnHub.a = [A(1, "first.pdf", "/image/l1.pdf")];
    await show(T("a", 1));
    open("a");
    await settle();
    const live = { kind: "ticket.attached", ticket_id: "a", room: "r", attachments_count: 2, attachment: A(2, "second.md", "/image/l2.md") };
    observers.ticket(live);
    observers.ticket(live);
    expect(view()).toContain('Attachments <span class=\"ticket-view-count\">2</span>');
    expect((view().match(/ticket-attach-name/g) ?? []).length).toBe(2);
    expect(attachFetches).toEqual(["a"]);                                         // no re-read needed
  });

  test("a reload that finds a higher count rereads the open attachment list and keeps both files", async () => {
    attachmentsOnHub.a = [A(1, "first.pdf", "/image/l1.pdf")];
    await show(T("a", 1));
    open("a");
    await settle();
    expect(view()).toContain("first.pdf");
    attachmentsOnHub.a.push(A(2, "second.pdf", "/image/l2.pdf"));          // its live event was missed
    list = [T("a", 2)];
    await ctx.TicketBoard.load();
    await settle();
    expect(view()).toContain("first.pdf");
    expect(view()).toContain("second.pdf");
    expect(attachFetches).toEqual(["a", "a"]);
  });

  test("a higher count on a closed view does not read; the next open does", async () => {
    attachmentsOnHub.a = [A(1, "first.pdf", "/image/l1.pdf")];
    await show(T("a", 1));
    open("a");
    await settle();
    els["ticket-view"].close();
    attachmentsOnHub.a.push(A(2, "second.pdf", "/image/l2.pdf"));
    list = [T("a", 2)];
    await ctx.TicketBoard.load();
    await settle();
    expect(attachFetches).toEqual(["a"]);
    open("a");
    await settle();
    expect(view()).toContain("second.pdf");
  });

  test("a ticket.attached entry never reads as a ticket snapshot, and another room's is ignored", async () => {
    await show(T("a", 1, { version: 9 }));
    observers.ticket({ kind: "ticket.attached", ticket_id: "a", room: "r", version: 3, attachments_count: 2, text: "[attachment on a]", attachment: A(3, "x.pdf", "/image/z.pdf") });
    expect(ctx.TicketBoard._tickets.get("a").version).toBe(9);
    expect(ctx.TicketBoard._tickets.get("a").attachments_count).toBe(2);
    observers.ticket({ kind: "ticket.attached", ticket_id: "a", room: "elsewhere", attachments_count: 7, attachment: A(9, "y.pdf", "/image/y.pdf") });
    expect(ctx.TicketBoard._tickets.get("a").attachments_count).toBe(2);
  });

  test("the count follows the newest word from the hub, up or down: a detach, a later list and a ticket.update lower it", async () => {
    await show(T("a", 1));
    for (const n of [3, 2]) observers.ticket({ kind: "ticket.attached", ticket_id: "a", room: "r", attachments_count: n, attachment: A(10 + n, `n${n}.pdf`, `/image/n${n}.pdf`) });
    expect(ctx.TicketBoard._tickets.get("a").attachments_count).toBe(2);
    observers.ticket({ kind: "ticket.detached", ticket_id: "a", room: "r", attachments_count: 1, attachment_id: 12, version: 50 });
    expect(ctx.TicketBoard._tickets.get("a").attachments_count).toBe(1);
    list = [T("a", 0)];
    await ctx.TicketBoard.load();                                                 // a later list at count 0
    expect(ctx.TicketBoard._tickets.get("a").attachments_count).toBe(0);
    observers.ticket({ kind: "ticket.update", ticket_id: "a", version: 99, snapshot: { ...T("a", 0), version: 99 } });
    expect(ctx.TicketBoard._tickets.get("a").attachments_count).toBe(0);          // an entry with no count keeps it
  });

  test("a late list replaces the cached list: a file removed while the read was in flight does not come back", async () => {
    await show(T("a", 2));
    let finish!: (r: any) => void;
    const normal = ctx.authedFetch;
    ctx.authedFetch = (path: string, init?: any) => (path.endsWith("/attachments") && !init ? new Promise((r) => { finish = r; }) : normal(path, init));
    open("a");
    finish({ ok: true, json: async () => [A(1, "keep.pdf", "/image/k.pdf")] });   // the hub's answer after the removal
    await settle();
    ctx.authedFetch = normal;
    expect(view()).toContain("keep.pdf");
    expect(view()).not.toContain("gone.pdf");
  });

  test("a read that started before a real ticket.detached cannot write the removed file back", async () => {
    attachmentsOnHub.a = [A(1, "keep.pdf", "/image/k.pdf"), A(2, "gone.pdf", "/image/g.pdf")];
    await show(T("a", 2));
    const normal = ctx.authedFetch;
    const pending: Array<(r: any) => void> = [];
    ctx.authedFetch = (path: string, init?: any) => (path.endsWith("/attachments") && !init ? new Promise((r) => { pending.push(r); }) : normal(path, init));
    open("a");                                                                    // read 1 starts: it will answer with both files
    expect(pending.length).toBe(1);
    attachmentsOnHub.a = [A(1, "keep.pdf", "/image/k.pdf")];                      // the hub removes gone.pdf ...
    observers.ticket({ kind: "ticket.detached", ticket_id: "a", room: "r", attachments_count: 1, attachment_id: 2, version: 60 });   // ... and the entry arrives
    pending[0]({ ok: true, json: async () => [A(1, "keep.pdf", "/image/k.pdf"), A(2, "gone.pdf", "/image/g.pdf")] });   // the old answer comes back late
    await settle();
    expect(pending.length).toBe(2);                                               // the stale answer was discarded and the list read again
    pending[1]({ ok: true, json: async () => [A(1, "keep.pdf", "/image/k.pdf")] });
    await settle();
    ctx.authedFetch = normal;
    expect(view()).toContain("keep.pdf");
    expect(view()).not.toContain("gone.pdf");
    expect(ctx.TicketBoard._tickets.get("a").attachments_count).toBe(1);
  });

  test("a missed ticket.detached: a lower count rereads the open list and the removed file leaves it", async () => {
    attachmentsOnHub.a = [A(1, "one.pdf", "/image/o1.pdf"), A(2, "two.pdf", "/image/o2.pdf")];
    await show(T("a", 2));
    open("a"); await settle();
    expect(view()).toContain("two.pdf");
    attachmentsOnHub.a = [A(1, "one.pdf", "/image/o1.pdf")];                       // removed elsewhere; its entry was missed
    list = [T("a", 1)];
    await ctx.TicketBoard.load();
    await settle();
    expect(view()).toContain("one.pdf");
    expect(view()).not.toContain("two.pdf");
    expect(attachFetches).toEqual(["a", "a"]);
  });

  test("a reconnect resets the attachment lists: the open list is read again", async () => {
    attachmentsOnHub.a = [A(1, "one.pdf", "/image/o1.pdf")];
    await show(T("a", 1));
    open("a"); await settle();
    attachmentsOnHub.a = [A(3, "three.pdf", "/image/o3.pdf")];                     // same count, different file: only a reset sees it
    ctx.syncTicketBoard();
    await settle();
    expect(view()).toContain("three.pdf");
    expect(view()).not.toContain("one.pdf");
  });

  test("a failed read is not retried by a redraw; Retry and opening the view again read it", async () => {
    await show(T("a", 1));
    let calls = 0, ok = false;
    const normal = ctx.authedFetch;
    ctx.authedFetch = (path: string, init?: any) =>
      path.endsWith("/attachments") && !init ? (++calls, Promise.resolve(ok ? { ok: true, json: async () => [A(1, "fine.pdf", "/image/f.pdf")] } : { ok: false })) : normal(path, init);
    const retry: any = { dataset: { ticket: "a" }, handlers: {} as Record<string, () => void> };
    retry.addEventListener = (type: string, fn: () => void) => { retry.handlers[type] = fn; };
    els["ticket-view-content"].querySelectorAll = (q: string) => (q === ".ticket-files-retry" ? [retry] : []);
    open("a");
    await settle();
    for (let i = 0; i < 4; i++) ctx.TicketBoard.setFilter(ctx.TicketBoard._filter());
    await settle();
    expect(calls).toBe(1);
    expect(view()).toContain("Could not read the attachments");
    ok = true;
    retry.handlers.click();
    await settle();
    expect(calls).toBe(2);
    expect(view()).toContain("fine.pdf");
  });

  test("the list read carries attachments_count and a room change forgets the files", async () => {
    attachmentsOnHub.a = [A(1, "x.pdf", "/image/x.pdf")];
    await show(T("a", 4));
    expect(ctx.TicketBoard._tickets.get("a").attachments_count).toBe(4);
    open("a");
    await settle();
    ctx.SELECTED_ROOM = "r2";
    list = [];
    await ctx.TicketBoard.load();
    expect(els["ticket-view"].open).toBe(false);
  });

  describe("in the new-ticket popup", () => {
    const form = () => ({
      title: { value: "T" }, criteria: { value: "c" }, radius: { value: "low" }, priority: { value: "medium" },
      external_ref: { value: "" }, assignee: { value: "" }, reset: () => {},
    });
    const listHtml = () => els["ticket-f-file-list"].innerHTML as string;
    beforeEach(() => {
      // The popup dialog itself: openNew needs it (and the title and first field it focuses).
      els["ticket-modal"] = { open: false, style: {}, showModal() { this.open = true; }, close() { this.open = false; } };
      els["ticket-modal-title"] = {};
      els["ticket-f-title"] = { focus() {} };
      els["ticket-f-assignee"] = { innerHTML: "" };
    });

    test("Attach files opens the picker; chosen files are listed with a remove button; invalid ones are refused", async () => {
      ctx.TicketBoard.openNew("queued");
      els["ticket-f-attach-btn"].handlers.click();
      expect(els["ticket-f-files"].clicks).toBe(1);
      await pick(els["ticket-f-files"], [F("spec.pdf"), F("bad.exe"), F("pic.png")]);
      expect(listHtml()).toContain("spec.pdf");
      expect(listHtml()).toContain("pic.png");
      expect(listHtml()).not.toContain("bad.exe");
      expect(messages.map((m) => m.text)).toEqual(["Attach failed: bad.exe: only pdf, md, txt, png, jpg, jpeg can be attached"]);
      expect(els["ticket-f-files"].value).toBe("");
    });

    test("the same file chosen twice is listed once, and × removes one", async () => {
      ctx.TicketBoard.openNew("queued");
      await pick(els["ticket-f-files"], [F("a.pdf"), F("a.pdf"), F("b.md")]);
      expect((listHtml().match(/ticket-f-file-name/g) ?? []).length).toBe(2);
      const remove: any = { dataset: { index: "0" } };
      els["ticket-f-file-list"].handlers.click({ target: { closest: (q: string) => (q === ".ticket-f-file-remove" ? remove : null) } });
      expect(listHtml()).not.toContain("a.pdf");
      expect(listHtml()).toContain("b.md");
      els["ticket-f-file-list"].handlers.click({ target: { closest: () => null } });          // a click elsewhere in the list does nothing
      expect(listHtml()).toContain("b.md");
    });

    test("Save creates the ticket first, then uploads and links each chosen file to the new ticket", async () => {
      ctx.TicketBoard.openNew("queued");
      await pick(els["ticket-f-files"], [F("spec.pdf"), F("pic.png")]);
      posts = [];
      await formSubmit!({ preventDefault: () => {}, target: form() });
      expect(posts.map((p) => p.path)).toEqual(["/tickets", "/tickets/t_new/attachments", "/tickets/t_new/attachments"]);
      expect(uploads).toEqual(["spec.pdf", "pic.png"]);
      expect(posts[1].body).toEqual({ by: "human", url: "/image/u1.pdf", name: "spec.pdf" });
      expect(posts[2].body).toEqual({ by: "human", url: "/image/u2.png", name: "pic.png" });
      expect(listHtml()).toBe("");                                                  // the list is cleared
    });

    test("a failed create keeps the chosen files and attaches nothing", async () => {
      ctx.TicketBoard.openNew("queued");
      await pick(els["ticket-f-files"], [F("spec.pdf")]);
      postOk = false;
      posts = [];
      await formSubmit!({ preventDefault: () => {}, target: form() });
      expect(uploads).toEqual([]);
      expect(listHtml()).toContain("spec.pdf");
    });

    test("with no files, Save makes no upload and no link; opening the popup again starts with an empty list", async () => {
      ctx.TicketBoard.openNew("queued");
      posts = [];
      await formSubmit!({ preventDefault: () => {}, target: form() });
      expect(posts.map((p) => p.path)).toEqual(["/tickets"]);
      expect(uploads).toEqual([]);
      ctx.TicketBoard.openNew("queued");
      await pick(els["ticket-f-files"], [F("left.pdf")]);
      expect(listHtml()).toContain("left.pdf");
      ctx.TicketBoard.openNew("queued");                                            // reopened without saving
      expect(listHtml()).toBe("");
    });

    test("a double Save attaches the files once", async () => {
      ctx.TicketBoard.openNew("queued");
      await pick(els["ticket-f-files"], [F("once.pdf")]);
      await Promise.all([formSubmit!({ preventDefault: () => {}, target: form() }), formSubmit!({ preventDefault: () => {}, target: form() })]);
      expect(uploads).toEqual(["once.pdf"]);
    });
  });

  test("the markup: an Attach control in the view and in the popup, accepting exactly the six types", () => {
    const html = readFileSync("ui/index.html", "utf8");
    const accept = '.pdf,.md,.txt,.png,.jpg,.jpeg';
    const viewHtml = html.slice(html.indexOf('id="ticket-view"'), html.indexOf("</dialog>", html.indexOf('id="ticket-view"')));
    const popup = html.slice(html.indexOf('id="ticket-modal"'), html.indexOf("</dialog>", html.indexOf('id="ticket-modal"')));
    for (const part of [viewHtml, popup]) {
      expect(part).toContain(`type="file"`);
      expect(part).toContain(`accept="${accept}"`);
      expect(part).toContain("multiple");
    }
    expect(viewHtml).toContain('id="ticket-view-attach-btn"');
    expect(viewHtml).toContain('id="ticket-view-attach-status" aria-live="polite"');
    expect(popup).toContain('id="ticket-f-attach-btn"');
    expect(popup).toContain('id="ticket-f-file-list"');
    // the attach control sits before the popup's Save row
    expect(popup.indexOf("ticket-f-attach-btn")).toBeLessThan(popup.indexOf('type="submit"'));
  });
});

describe("acceptance criteria editor and Markdown", () => {
  const real = (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const act = (v: string, s: number, e: number, a: string) => ctx.TicketBoard.applyMarkdownAction(v, s, e, a);
  const md = (text: string) => { ctx.escHtml = real; return ctx.TicketBoard.mdHtml(text); };

  test("a list action with the caret at zero on an empty first line prefixes that line only", () => {
    for (const [action, prefix] of [["bullet", "- "], ["checklist", "- [ ] "]]) {
      const out = act("\nalpha", 0, 0, action);
      expect(out.value).toBe(`${prefix}\nalpha`);
      expect(out.start).toBe(prefix.length);
      expect(out.end).toBe(prefix.length);
    }
  });

  describe("insert actions", () => {
    test("bold wraps the selection and keeps it selected; with no selection it opens ** ** around the caret", () => {
      expect(act("make it fast", 8, 12, "bold")).toEqual({ value: "make it **fast**", start: 10, end: 14 });
      expect(act("ab", 1, 1, "bold")).toEqual({ value: "a****b", start: 3, end: 3 });
      expect(act("", 0, 0, "bold")).toEqual({ value: "****", start: 2, end: 2 });
    });

    test("inline code wraps with backticks the same way", () => {
      expect(act("run bun test now", 4, 12, "code")).toEqual({ value: "run `bun test` now", start: 5, end: 13 });
      expect(act("x", 1, 1, "code")).toEqual({ value: "x``", start: 2, end: 2 });
    });

    test("bold and code toggle off: marks around the selection, or inside it", () => {
      const on = act("make it fast", 8, 12, "bold");
      expect(act(on.value, on.start, on.end, "bold")).toEqual({ value: "make it fast", start: 8, end: 12 });
      expect(act("a **b** c", 2, 7, "bold")).toEqual({ value: "a b c", start: 2, end: 3 });
      const code = act("x y", 2, 3, "code");
      expect(act(code.value, code.start, code.end, "code").value).toBe("x y");
      expect(act("a ****", 4, 4, "bold")).toEqual({ value: "a ", start: 2, end: 2 });          // bold pressed twice in a row removes the empty marks
    });

    test("a bulleted list prefixes the caret's line, or every line the selection touches", () => {
      expect(act("one", 1, 1, "bullet")).toEqual({ value: "- one", start: 3, end: 3 });
      expect(act("a\nb\nc", 0, 5, "bullet")).toEqual({ value: "- a\n- b\n- c", start: 0, end: 11 });
      expect(act("a\nb\nc", 2, 3, "bullet").value).toBe("a\n- b\nc");                      // only the middle line
      expect(act("", 0, 0, "bullet")).toEqual({ value: "- ", start: 2, end: 2 });          // an empty field gets a bullet
    });

    test("blank lines in a selection stay blank, and a selection ending after a newline does not take the next line", () => {
      expect(act("a\n\nb", 0, 4, "bullet").value).toBe("- a\n\n- b");
      expect(act("a\nb\n", 0, 2, "bullet").value).toBe("- a\nb\n");                         // ends right after "a\n"
    });

    test("a checklist item prefixes with - [ ], converts a bullet, and toggles off", () => {
      expect(act("task", 2, 2, "checklist")).toEqual({ value: "- [ ] task", start: 8, end: 8 });
      expect(act("- task", 3, 3, "checklist").value).toBe("- [ ] task");                    // a bullet becomes a checklist item
      const on = act("a\nb", 0, 3, "checklist");
      expect(on.value).toBe("- [ ] a\n- [ ] b");
      expect(act(on.value, on.start, on.end, "checklist").value).toBe("a\nb");             // again: off
      expect(act("- [x] done", 5, 5, "checklist").value).toBe("done");                     // a ticked item toggles off too
    });

    test("a bullet toggles off, a checklist item becomes a plain bullet, and mixed lines are all made bullets", () => {
      const on = act("a\nb", 0, 3, "bullet");
      expect(act(on.value, on.start, on.end, "bullet").value).toBe("a\nb");
      expect(act("- [ ] a", 2, 2, "bullet").value).toBe("- a");                           // checklist -> bullet
      expect(act("- a\nb", 0, 5, "bullet").value).toBe("- a\n- b");                       // mixed: all on
    });

    test("an unknown action changes nothing; a caret keeps its place relative to the text", () => {
      expect(act("abc", 1, 2, "nope")).toEqual({ value: "abc", start: 1, end: 2 });
      expect(act("hello", 5, 5, "bullet")).toEqual({ value: "- hello", start: 7, end: 7 });
      expect(act("hello", 0, 0, "bullet")).toEqual({ value: "- hello", start: 2, end: 2 });   // never before the prefix
    });
  });

  describe("the editor in the dialog", () => {
    const field = (value: string, s: number, e: number) => {
      const events: string[] = [];
      const ta: any = { value, selectionStart: s, selectionEnd: e, focused: 0, handlers: {} as Record<string, (e: any) => void>,
        setSelectionRange(a: number, b: number) { this.selectionStart = a; this.selectionEnd = b; },
        focus() { this.focused++; }, addEventListener(t: string, f: (e: any) => void) { this.handlers[t] = f; },
        dispatchEvent(ev: any) { events.push(ev.type); return true; }, events };
      els["ticket-f-criteria"] = ta;
      return ta;
    };

    test("a toolbar action edits the field, selects the result, refocuses the field and fires input", () => {
      ctx.Event = class { constructor(public type: string) {} };
      const ta = field("make it fast", 8, 12);
      ctx.TicketBoard.applyToCriteria("bold");
      expect(ta.value).toBe("make it **fast**");
      expect([ta.selectionStart, ta.selectionEnd]).toEqual([10, 14]);
      expect(ta.focused).toBe(1);
      expect(ta.events).toEqual(["input"]);
    });

    const key = (_ta: any, init: object) => { const e: any = { key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...init }; ctx.TicketBoard.onCriteriaKeydown(e); return e; };

    test("Cmd or Ctrl with B, E, Shift+8, Shift+9 run the actions; the browser default is prevented", () => {
      ctx.Event = undefined;
      const cases: Array<[object, string]> = [
        [{ key: "b", metaKey: true }, "**x**"], [{ key: "B", ctrlKey: true }, "**x**"],
        [{ key: "e", metaKey: true }, "`x`"],
        [{ key: "*", code: "Digit8", metaKey: true, shiftKey: true }, "- x"],
        [{ key: "(", code: "Digit9", ctrlKey: true, shiftKey: true }, "- [ ] x"],
      ];
      for (const [init, expected] of cases) {
        const ta = field("x", 0, 1);
        const e = key(ta, init);
        expect(e.prevented).toBe(true);
        expect(ta.value).toBe(expected);
      }
    });

    test("other keys, a plain B, Alt combinations and unknown Shift digits are left alone", () => {
      for (const init of [{ key: "b" }, { key: "b", metaKey: true, altKey: true }, { key: "k", metaKey: true }, { key: "7", code: "Digit7", metaKey: true, shiftKey: true }, { key: "Enter" }]) {
        const ta = field("x", 0, 1);
        const e = key(ta, init);
        expect([JSON.stringify(init), e.prevented, ta.value]).toEqual([JSON.stringify(init), false, "x"]);
      }
    });

    test("the field listens for the shortcuts, and each toolbar button runs its action on the field", () => {
      expect(els["ticket-f-criteria"].handlers.keydown).toBe(ctx.TicketBoard.onCriteriaKeydown);
      ctx.Event = undefined;
      for (const [i, expected] of ["**x**", "- x", "- [ ] x", "`x`"].entries()) {
        const ta = field("x", 0, 1);
        mdButtons[i].handlers.click();
        expect([mdButtons[i].dataset.md, ta.value]).toEqual([mdButtons[i].dataset.md, expected]);
      }
      const html = readFileSync("ui/index.html", "utf8");
      const bar = html.slice(html.indexOf('class="md-toolbar"'), html.indexOf('id="ticket-f-criteria"'));
      expect(bar).toContain('role="toolbar"');
      expect(bar).toContain('aria-label="Format the acceptance criteria"');
      expect(bar).toContain('aria-controls="ticket-f-criteria"');
      for (const [action, label, keys] of [["bold", "Bold", "Meta+B Control+B"], ["bullet", "Bulleted list", "Meta+Shift+8 Control+Shift+8"],
        ["checklist", "Checklist item", "Meta+Shift+9 Control+Shift+9"], ["code", "Inline code", "Meta+E Control+E"]]) {
        expect(bar).toContain(`data-md="${action}" aria-label="${label}" aria-keyshortcuts="${keys}"`);
      }
      expect((bar.match(/type="button"/g) ?? []).length).toBe(4);                      // buttons, not submit
      expect(html.indexOf("md-toolbar")).toBeLessThan(html.indexOf('id="ticket-f-criteria"'));   // above the field
    });
  });

  describe("safe Markdown rendering", () => {
    test("paragraphs, line breaks, **strong**, `code`", () => {
      expect(md("first line\nsecond line\n\nnew paragraph")).toBe("<p>first line<br>second line</p><p>new paragraph</p>");
      expect(md("a **bold** and `code` here")).toBe("<p>a <strong>bold</strong> and <code>code</code> here</p>");
      expect(md("**one** **two**")).toBe("<p><strong>one</strong> <strong>two</strong></p>");
    });

    test("bullet lists and checklists, including ticked items and a switch between the two", () => {
      expect(md("- a\n- b")).toBe('<ul class="md-list"><li>a</li><li>b</li></ul>');
      expect(md("- [ ] todo\n- [x] done\n- [X] also done")).toBe(
        '<ul class="md-checklist"><li><input type="checkbox" disabled aria-label="to do"> todo</li>'
        + '<li><input type="checkbox" disabled checked aria-label="done"> done</li>'
        + '<li><input type="checkbox" disabled checked aria-label="done"> also done</li></ul>');
      expect(md("- a\n- [ ] b")).toBe('<ul class="md-list"><li>a</li></ul><ul class="md-checklist"><li><input type="checkbox" disabled aria-label="to do"> b</li></ul>');
      expect(md("intro\n- a\noutro")).toBe('<p>intro</p><ul class="md-list"><li>a</li></ul><p>outro</p>');
    });

    test("inline marks work inside list items; code content is literal", () => {
      expect(md("- **hot** `x`")).toBe('<ul class="md-list"><li><strong>hot</strong> <code>x</code></li></ul>');
      expect(md("`**not bold**` and **bold**")).toBe("<p><code>**not bold**</code> and <strong>bold</strong></p>");
    });

    test("HTML is escaped before anything else: no tag, attribute or script can come out of the text", () => {
      const attacks = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '"><svg onload=alert(1)>',
        "'; DROP", "- <b>x</b>", "- [ ] <iframe src=//evil>", "**<u>x</u>**", "`<b>`", "&lt;script&gt;", "<!-- c -->"];
      for (const a of attacks) {
        const out = md(a);
        expect(out).not.toMatch(/<(script|img|a |svg|iframe|b>|u>|!--)/i);
        expect(out).not.toContain("onerror=alert(1)>");
        expect(out.replace(/<\/?(p|br|strong|code|ul|li)( class="[a-z-]+")?>/g, "").replace(/<input type="checkbox" disabled( checked)? aria-label="[a-z ]+">/g, "")).not.toMatch(/<[^>]*>/);   // only the fixed tags remain
      }
      expect(md("<b>x</b>")).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>");
      expect(md('say "hi" & \'bye\'')).toBe("<p>say &quot;hi&quot; &amp; &#39;bye&#39;</p>");
      expect(md("&lt;script&gt;")).toBe("<p>&amp;lt;script&amp;gt;</p>");              // an entity typed by hand is shown as typed
    });

    test("no links are made: a URL or a javascript: link stays text", () => {
      expect(md("[x](javascript:alert(1)) https://example.com")).toBe("<p>[x](javascript:alert(1)) https://example.com</p>");
    });

    test("unclosed marks, stray markers, odd line endings and empty input do not break it", () => {
      expect(md("**open")).toBe("<p>**open</p>");
      expect(md("`open")).toBe("<p>`open</p>");
      expect(md("a\r\nb\rc")).toBe("<p>a<br>b<br>c</p>");
      expect(md("-not a list")).toBe("<p>-not a list</p>");
      expect(md("- ")).toBe('<ul class="md-list"><li></li></ul>');
      expect(md("")).toBe("");
      expect(md(null as any)).toBe("");
      expect(md("   \n\n  ")).toBe("");
    });

    test("it is the output of applyMarkdownAction that renders: the editor and the renderer agree", () => {
      const a = act("run the tests", 4, 13, "code");
      expect(md(a.value)).toBe("<p>run `the tests`</p>".replace("`the tests`", "<code>the tests</code>"));
      const l = act("one\ntwo", 0, 7, "checklist");
      expect(md(l.value)).toContain('<ul class="md-checklist">');
      expect((md(l.value).match(/<li>/g) ?? []).length).toBe(2);
    });
  });

  describe("on the card and in the full view", () => {
    const T = (criteria: string) => ({
      ...ticket("", null), id: "t_md", title: "md", status: "in_progress", blast_radius: "low", priority: "medium", assignee: "alice",
      approval_request_id: null, archived_at_ms: null, notes_count: 0, attachments_count: 0, acceptance_criteria: criteria,
    });
    async function show(t: any) { list = [t]; ctx.TicketBoard._tickets.clear(); await ctx.TicketBoard.load(); }

    // 15.3: the card no longer holds the criteria; it shows the checklist progress and the dialog renders the Markdown.
    test("the card shows the checklist progress; the dialog renders the criteria as Markdown", async () => {
      ctx.escHtml = real;
      await show(T("- [x] one\n- [ ] **two**"));
      expect(cols.innerHTML).not.toContain('<details class="ticket-criteria">');
      expect(cols.innerHTML).toMatch(/title="Criteria checked">.*?<\/svg>1\/2<\/span>/s);
      ctx.TicketBoard.openView("t_md");
      const html = (els["ticket-view-content"].innerHTML + els["ticket-view-notes"].innerHTML) as string;
      expect(html).toContain('<div class="ticket-view-criteria md"><ul class="md-checklist">');
      expect(html).toContain("<strong>two</strong>");
    });

    test("the dialog escapes hostile criteria and the card shows none of it", async () => {
      ctx.escHtml = real;
      await show(T('<img src=x onerror=alert(1)> **b**'));
      expect(cols.innerHTML).not.toContain("<img");
      ctx.TicketBoard.openView("t_md");
      const html = (els["ticket-view-content"].innerHTML + els["ticket-view-notes"].innerHTML) as string;
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; <strong>b</strong>");
    });

    test("the full view renders it too", async () => {
      ctx.escHtml = real;
      await show(T("run `bun test`\n\n- a"));
      ctx.TicketBoard.openView("t_md");
      const html = (els["ticket-view-content"].innerHTML + els["ticket-view-notes"].innerHTML) as string;
      expect(html).toContain('<div class="ticket-view-criteria md"><p>run <code>bun test</code></p><ul class="md-list"><li>a</li></ul></div>');
    });

    test("plain criteria (no Markdown) still read as before, line breaks kept", async () => {
      ctx.escHtml = real;
      await show(T("line one\nline two"));
      ctx.TicketBoard.openView("t_md");
      expect((els["ticket-view-content"].innerHTML + els["ticket-view-notes"].innerHTML)).toContain("<p>line one<br>line two</p>");
    });
  });
});

describe("moving tickets: the Move to select and drag and drop", () => {
  const T = (id: string, status: string, extra: object = {}) => ({
    id, room: "r", title: `T ${id}`, acceptance_criteria: "c", blast_radius: "low", priority: "medium",
    creator: "a", assignee: "alice", approval_request_id: null, external_ref: null, status,
    created_at_ms: 1, updated_at_ms: 1, version: 1, archived_at_ms: null, notes_count: 0, attachments_count: 0, ...extra,
  });
  const el = () => {
    const n: any = { handlers: {} as Record<string, (e: any) => void>, cls: new Set<string>(), dataset: {} };
    n.addEventListener = (t: string, fn: (e: any) => void) => { n.handlers[t] = fn; };
    n.classList = { add: (...c: string[]) => c.forEach((x) => n.cls.add(x)), remove: (...c: string[]) => c.forEach((x) => n.cls.delete(x)) };
    n.contains = (x: any) => x === n;
    return n;
  };
  let selects: Record<string, any>;
  let cards: Record<string, any>;
  let columns: Record<string, any>;
  const ev = (extra: object = {}) => ({ prevented: false, preventDefault() { this.prevented = true; }, dataTransfer: { setData() {} }, target: { closest: () => null }, ...extra });
  async function show(...tickets: any[]) {
    selects = {}; cards = {}; columns = {};
    for (const t of tickets) {
      selects[t.id] = Object.assign(el(), { dataset: { ticket: t.id }, value: "" });
      cards[t.id] = Object.assign(el(), { dataset: { ticket: t.id } });
    }
    for (const k of ["queued", "in_progress", "in_review", "done", ""]) columns[k] = Object.assign(el(), { dataset: { status: k } });
    cols.querySelectorAll = (q: string) =>
      q === ".ticket-move" ? Object.values(selects)
      : q === '.ticket-card[draggable="true"]' ? tickets.filter((t) => t.status !== "done" && t.status !== "cancelled").map((t) => cards[t.id])
      : q === ".ticket-col" ? Object.values(columns)
      : q === ".dragging, .drop-target" ? [...Object.values(cards), ...Object.values(columns)] : [];
    list = tickets;
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
  }
  const optionsOf = (id: string) => {
    const m = new RegExp(`<select class="ticket-move" data-ticket="${id}"[^>]*>(.*?)</select>`).exec(cols.innerHTML);
    return m ? [...m[1].matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)</g)].map((o) => [o[1], o[3], /disabled/.test(o[2])]) : null;
  };

  test("an open card has a Move to select with the five columns; its own column is shown and disabled", async () => {
    await show(T("a", "queued"), T("b", "claimed"), T("c", "in_review"));
    expect(optionsOf("a")).toEqual([["draft", "Draft", false], ["queued", "Queued", true], ["in_progress", "In progress", false], ["in_review", "In review", false], ["done", "Done", false]]);
    expect(optionsOf("b")!.map((o) => o[2])).toEqual([false, false, true, false, false]);   // claimed sits in In progress
    expect(optionsOf("c")!.map((o) => o[2])).toEqual([false, false, false, true, false]);
    expect(cols.innerHTML).toContain("Move to");
  });

  test("15.4 the Assignee select is in the footer in place of the name, Move to is in the controls row with the Cancel icon; both have aria-labels", async () => {
    await show(T("a", "queued"));
    const html = cols.innerHTML as string;
    const foot = /<div class="ticket-card-foot">(.*?)<div class="ticket-card-controls">/s.exec(html)![1];
    expect(foot).toContain('<span class="ticket-who-name">alice</span>');
    expect(foot).toContain('aria-label="Assignee of T a"');
    const row = /<div class="ticket-card-controls">(.*?)<\/div>\s*<\/div>\s*<\/div>/s.exec(html)![1];
    expect(row).toContain('aria-label="Move T a to column"');
    expect(row).toContain('aria-label="Cancel ticket T a"');
    expect(row).not.toContain("ticket-assign");
    expect(row.indexOf("ticket-move")).toBeLessThan(row.indexOf("ticket-cancel-icon"));
    // Keyboard order: the Assignee (footer) comes first, then Move, then Cancel.
    expect(html.indexOf("ticket-assign")).toBeLessThan(html.indexOf("ticket-move"));
    expect(html.indexOf("ticket-move")).toBeLessThan(html.indexOf("ticket-cancel-icon"));
  });

  test("done and cancelled cards have no select and are not draggable; the per-status move buttons are gone", async () => {
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), showCancelled: true });
    await show(T("d", "done"), T("x", "cancelled"), T("q", "queued"));
    expect(optionsOf("d")).toBeNull();
    expect(optionsOf("x")).toBeNull();
    expect(cols.innerHTML.match(/draggable="true"/g)?.length).toBe(1);
    for (const gone of ["Claim<", "Start<", "To review<", "Rework<"]) expect(cols.innerHTML).not.toContain(gone);
    expect(cols.innerHTML).toContain('data-to="cancelled" aria-label="Cancel ticket T q">');
  });

  test("choosing a column sends the human move; choosing nothing new sends nothing", async () => {
    await show(T("a", "queued"));
    selects.a.value = "in_review";
    await selects.a.handlers.change();
    expect(posts.at(-1)).toEqual({ path: "/tickets/a/transition", body: { by: "human", to: "in_review" } });
    const n = posts.length;
    selects.a.value = "queued";                                   // its own column
    await selects.a.handlers.change();
    expect(posts.length).toBe(n);
  });

  test("15.2 an empty column is a collapsed strip with count, label and +, still a drop target; a column with tickets has + in its header", async () => {
    await show(T("a", "draft"), T("d", "done"));
    const html = cols.innerHTML as string;
    for (const [status, label] of [["queued", "Queued"], ["in_progress", "In progress"], ["in_review", "In review"]]) {
      expect(html).toContain(`<section class="ticket-col collapsed" data-status="${status}"><h3>${label} <span class="count">0</span></h3><button type="button" class="ticket-add" data-col=`);
    }
    // Draft has a ticket: a full column, "+" at the right of its header, no strip.
    expect(html).toMatch(/<section class="ticket-col" data-status="draft"><h3>Draft <span class="count">1<\/span><button type="button" class="ticket-add" data-col="draft"[^>]*>\+<\/button><\/h3>/);
    // Done has a ticket: "Archive all done" stays in its header, before "+".
    expect(html).toMatch(/<section class="ticket-col" data-status="done"><h3>Done <span class="count">1<\/span><button[^>]*class="ticket-archive-all"[^>]*>[^<]*<\/button><button type="button" class="ticket-add" data-col="done"/);
    expect(html.match(/class="ticket-add"/g)?.length).toBe(5);                  // every column keeps its +
  });

  test("15.2 widths: tickets take the free space, a strip is 40 px; one Draft ticket gets at least 550 px of 770 px", () => {
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toContain(".ticket-col { flex: 1 1 210px; min-width: 200px; }");
    expect(css).toMatch(/\.ticket-col\.collapsed \{\s*flex: 0 0 40px; min-width: 40px;/);
    expect(css).toMatch(/\.ticket-board-columns \{[^}]*display: flex;[^}]*overflow: auto/);               // scrolls sideways when columns do not fit
    expect(css).toMatch(/\.ticket-col\.collapsed h3 \{[^}]*writing-mode: vertical-rl/);
    const pane = 770, padding = 2 * 8, gap = 8, strips = 4;                      // four empty columns, five columns, four gaps
    expect(pane - padding - strips * 40 - strips * gap).toBeGreaterThanOrEqual(550);
  });

  test("15.2 the toolbar has 'All N tickets' after Filters and a primary '+ New ticket' that opens the dialog for Queued", async () => {
    const html = readFileSync("ui/index.html", "utf8");
    const at = (x: string) => html.indexOf(x);
    expect(at('id="ticket-filters-btn"')).toBeLessThan(at('id="ticket-filter-summary"'));
    expect(at('id="ticket-filter-summary"')).toBeLessThan(at('id="ticket-new-btn"'));
    expect(html).toContain('<button type="button" class="ticket-new-btn" id="ticket-new-btn">+ New ticket</button>');
    await show(T("a", "queued"));
    expect(els["ticket-filter-summary"].textContent).toBe("All 1 ticket");
    await show(T("a", "queued"), T("b", "draft"));
    expect(els["ticket-filter-summary"].textContent).toBe("All 2 tickets");
    els["ticket-modal"] = { open: false, style: {}, showModal() { this.open = true; }, close() { this.open = false; } };
    els["ticket-modal-title"] = { textContent: "" };
    els["ticket-new-btn"].handlers.click();
    expect(els["ticket-modal-title"].textContent).toBe("New ticket — Queued");
    expect(els["ticket-modal"].open).toBe(true);
    delete els["ticket-modal-title"]; delete els["ticket-modal"];
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toMatch(/\.ticket-new-btn \{ margin-left: auto; background: var\(--orange\); color: var\(--bg-inset\);/);
    expect(css).toContain('[data-theme="rose-pine-dawn"] .ticket-new-btn, [data-theme="rose-pine-dawn"] .ticket-new-btn:hover { background: var(--text); color: var(--bg-inset); }');
  });

  test("a drop on another column sends the same move; a drop on its own column or on Cancelled does nothing", async () => {
    await show(T("a", "queued"));
    cards.a.handlers.dragstart(ev());
    const over = ev();
    columns.in_progress.handlers.dragover(over);
    expect(over.prevented).toBe(true);
    expect(columns.in_progress.cls.has("drop-target")).toBe(true);
    const own = ev();
    columns.queued.handlers.dragover(own);
    expect(own.prevented).toBe(false);                             // no highlight on its own column
    const cancelled = ev();
    columns[""].handlers.dragover(cancelled);
    expect(cancelled.prevented).toBe(false);
    columns.queued.handlers.drop(ev());
    columns[""].handlers.drop(ev());
    expect(posts.filter((p) => p.path.endsWith("/transition"))).toEqual([]);
    columns.in_progress.handlers.drop(ev());
    await settle();
    expect(posts.at(-1)).toEqual({ path: "/tickets/a/transition", body: { by: "human", to: "in_progress" } });
    expect(columns.in_progress.cls.has("drop-target")).toBe(false);
  });

  test("leaving a column removes its highlight", async () => {
    await show(T("a", "queued"));
    cards.a.handlers.dragstart(ev());
    columns.done.handlers.dragover(ev());
    columns.done.handlers.dragleave({ relatedTarget: {} });
    expect(columns.done.cls.has("drop-target")).toBe(false);
  });

  test("a refused move shows the hub error and redraws the board in the real column", async () => {
    await show(T("a", "queued"));
    postOk = false;
    cols.innerHTML = "";                                           // proves the redraw
    selects.a.value = "done";
    await selects.a.handlers.change();
    expect(messages.at(-1).text).toBe("Ticket move to done failed: upload refused");
    expect(cols.innerHTML).toContain('data-current="queued"');
    expect(ctx.TicketBoard._tickets.get("a").status).toBe("queued");
  });

  test("a second move for the same ticket waits for the first answer", async () => {
    await show(T("a", "queued"));
    const normal = ctx.authedFetch;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    ctx.authedFetch = async (path: string, init?: any) => { if (path.endsWith("/transition")) await held; return normal(path, init); };
    selects.a.value = "in_progress";
    const first = selects.a.handlers.change();
    selects.a.value = "done";
    const second = selects.a.handlers.change();
    cards.a.handlers.dragstart(ev());                              // a drag cannot start either
    columns.done.handlers.drop(ev());
    release();
    await Promise.all([first, second]);
    await settle();
    expect(posts.filter((p) => p.path.endsWith("/transition")).length).toBe(1);
  });

  test("a live event during a drag does not redraw until the drag ends", async () => {
    await show(T("a", "queued"));
    cards.a.handlers.dragstart(ev());
    cols.innerHTML = "STALE";
    ctx.TicketBoard.onTicket({ ticket_id: "a", version: 5, snapshot: T("a", "claimed", { version: 5 }) });
    expect(cols.innerHTML).toBe("STALE");                          // the dragged card was not replaced
    cards.a.handlers.dragend();
    expect(cols.innerHTML).not.toBe("STALE");
    expect(optionsOf("a")!.map((o) => o[2])).toEqual([false, false, true, false, false]);
  });

  test("a drag that starts on a control does not start", async () => {
    await show(T("a", "queued"));
    const e = ev({ target: { closest: () => ({}) } });
    cards.a.handlers.dragstart(e);
    expect(e.prevented).toBe(true);
    const over = ev();
    columns.in_progress.handlers.dragover(over);
    expect(over.prevented).toBe(false);                            // nothing is being dragged
  });
});

describe("request label and blockers (6.2, 6.3)", () => {
  const mk = (id: string, status: string, extra: object = {}) => ({
    ...ticket("", null), id, title: `title-${id}`, status, blast_radius: "low", priority: "medium", approval_request_id: null, assignee: null,
    request_id: null, blocked_by: [], open_blockers: [], ...extra,
  });
  const card = (id: string) => (cols.innerHTML.match(new RegExp(`<div class="ticket-card [^>]*data-ticket="${id}"[\\s\\S]*?(?=<div class="ticket-card |</section>)`)) ?? [""])[0];
  // 15.3: the blocker count is in the card's status line ("Blocked by N open tickets").
  const lock = (id: string) => /ticket-status-line is-blocked">.*?<\/svg>Blocked by (\d+) open/s.exec(card(id))?.[1] ?? null;
  async function show(...tickets: any[]) {
    list = tickets;
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
  }
  const ev = (t: any, version: number) => observers.ticket({ kind: "ticket.update", ticket_id: t.id, room: "r", version, snapshot: { ...t, version } });

  test("a card shows its request label, and a lock with the open-blocker count only when it has some", async () => {
    await show(mk("a", "queued", { request_id: "r-1", blocked_by: ["b", "c"], open_blockers: ["b", "c"] }), mk("b", "queued"), mk("c", "queued"));
    expect(card("a")).toContain("r-1");
    expect(lock("a")).toBe("2");
    expect(lock("b")).toBeNull();
  });

  test("a blocker that moves to done lowers the count by one; cancelled does not; an older event is discarded", async () => {
    await show(mk("a", "queued", { version: 1, blocked_by: ["b", "c"], open_blockers: ["b", "c"] }), mk("b", "queued", { version: 1 }), mk("c", "queued", { version: 1 }));
    ev(mk("b", "done"), 5);
    expect(lock("a")).toBe("1");
    ev(mk("c", "cancelled"), 5);
    expect(lock("a")).toBe("1");                         // a cancelled blocker still blocks
    ev(mk("b", "queued"), 3);                            // older than version 5: discarded
    expect(lock("a")).toBe("1");
    ev(mk("b", "queued"), 6);                            // the human reopens it
    expect(lock("a")).toBe("2");
  });

  test("a blocker the board does not hold keeps the server's result; absence never counts as done", async () => {
    await show(mk("a", "queued", { blocked_by: ["x", "y"], open_blockers: ["x"] }));
    expect(lock("a")).toBe("1");                         // x open on the server, y done on the server
  });

  test("lightOf is unchanged by a blocker: a blocked queued ticket still shows green", async () => {
    await show(mk("a", "queued", { blocked_by: ["b"], open_blockers: ["b"] }), mk("b", "queued"));
    expect(card("a")).toContain("no one is working on it");
  });

  // ---- 15.3: the new card ----
  const cardOf = (extra: object, id = "a") => { return mk(id, "queued", extra); };

  test("15.3 top row: the tag chip, the code and the priority bars with their label; the title is the parsed main text, then the sub", async () => {
    await show(cardOf({ title: "[code] 8.3a Hot reload: link [idle at once]", priority: "high" }));
    const c = card("a");
    expect(c).toContain('<span class="ticket-tag tag-code">code</span><span class="ticket-code">8.3a</span>');
    expect(c).toContain('<span class="ticket-bars" aria-hidden="true"><i class="on"></i><i class="on"></i><i class="on"></i><i></i></span>High</span>');
    expect(c).toContain('<div class="ticket-title">Hot reload: link</div>');
    expect(c).toContain('<div class="ticket-sub">idle at once</div>');
    await show(cardOf({ title: "plain title", priority: "lowest" }));
    expect(card("a")).not.toContain("ticket-tag");
    expect(card("a")).not.toContain("ticket-sub");
    expect(card("a")).toContain("<i></i><i></i><i></i><i></i></span>Lowest");                  // no bars on
  });

  test("15.3 chips: request, external ref and High radius; no meta line; a chip is one nowrap block", async () => {
    await show(cardOf({ request_id: "r-1", external_ref: "GH-142", blast_radius: "high" }), mk("b", "queued"));
    const c = card("a");
    expect(c).toContain('<span class="ticket-request-label">r-1</span>');
    expect(c).toContain('<span class="ticket-chip">GH-142</span>');
    expect(c).toContain('<span class="ticket-chip ticket-radius">High radius</span>');
    expect(cols.innerHTML).not.toContain("ticket-meta");
    expect(card("b")).not.toContain("ticket-chips");                                           // no chips: no row
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toMatch(/\.ticket-chip \{[^}]*white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/);
  });

  test("15.3 the status line: blockers, the human, the approval; none otherwise", async () => {
    await show(
      cardOf({ blocked_by: ["x"], open_blockers: ["x"] }),
      mk("h", "queued", { assignee: "human" }),
      mk("p", "in_review", { assignee: "alice", blast_radius: "high", approval_request_id: "req1", approval: { id: "req1", status: "pending", version: 1 } }),
      mk("n", "queued"),
    );
    expect(card("a")).toMatch(/ticket-status-line is-blocked">.*Blocked by 1 open ticket<\/div>/s);
    expect(card("h")).toMatch(/ticket-status-line is-human">.*Assigned to you<\/div>/s);
    expect(card("p")).toMatch(/ticket-status-line is-approval">.*Waiting for your approval<\/div>/s);
    expect(card("n")).not.toContain("ticket-status-line");
  });

  test("15.3 footer: the assignee circle and name or Unassigned; progress, attachments and notes only above 0; the light is last", async () => {
    await show(
      cardOf({ assignee: "alice", acceptance_criteria: "- [x] a\n- [ ] b\n- [ ] c", attachments_count: 2, notes_count: 4 }),
      mk("b", "queued"),
    );
    const a = card("a");
    expect(a).toContain('<span class="ticket-avatar" aria-hidden="true">A</span><span class="ticket-who-name">alice</span>');
    expect(a).toMatch(/title="Criteria checked">.*?<\/svg>1\/3<\/span>/s);
    expect(a).toMatch(/title="Attachments">.*?<\/svg>2<\/span>/s);
    expect(a).toMatch(/title="Notes">.*?<\/svg>4<\/span>/s);
    expect(a.indexOf("ticket-counts")).toBeLessThan(a.indexOf("ticket-light"));
    const foot = /<div class="ticket-card-foot">(.*?)<div class="ticket-card-controls">/s.exec(a)![1];
    expect(foot.trimEnd().endsWith("</div>")).toBe(true);
    expect(foot).toMatch(/<span class="ticket-light"[^>]*>.*<\/span><\/div>\s*$/s);              // the light ends the footer
    const b = card("b");
    expect(b).toMatch(/<span class="ticket-who ticket-unassigned"><span class="ticket-who-name">Unassigned<\/span>/);
    for (const t of ["Criteria checked", "Attachments", 'title="Notes"']) expect(b).not.toContain(t);
  });

  test("15.3 the card has no details, no always-visible controls and no orange border; the hooks stay", async () => {
    await show(cardOf({ acceptance_criteria: "c", notes_count: 3 }));
    const c = card("a");
    expect(c).not.toContain("<details");
    expect(c).toContain('role="button" tabindex="0" draggable="true" data-ticket="a" aria-label="Open ticket: title-a"');
    expect(c).toMatch(/<div class="ticket-card-controls">.*class="ticket-move".*data-to="cancelled"/s);
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toMatch(/\.ticket-card-controls \{ visibility: hidden; height: 0;/);            // hidden until hover or focus, not display: none
    expect(css).toContain(".ticket-card:hover .ticket-card-controls, .ticket-card:focus-within .ticket-card-controls { visibility: visible; height: auto;");
    expect(css).not.toContain(".ticket-card.radius-high");
    expect(c).not.toContain("radius-high");
  });

  // ---- 15.4: card actions on hover and keyboard focus ----
  test("15.4 hover and focus: the name swaps for the Assignee select (max 104 px); the controls row shows; hidden by visibility and height 0, not display: none", () => {
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toMatch(/\.ticket-card-controls \{ visibility: hidden; height: 0; overflow: hidden; \}/);
    expect(css).toContain(".ticket-card:hover .ticket-card-controls, .ticket-card:focus-within .ticket-card-controls { visibility: visible; height: auto; overflow: visible; }");
    expect(css).toContain(".ticket-card:hover .ticket-who:has(.ticket-assign-label) .ticket-who-name, .ticket-card:focus-within .ticket-who:has(.ticket-assign-label) .ticket-who-name { display: none; }");
    expect(css).toMatch(/\.ticket-who \.ticket-assign-label \{[^}]*visibility: hidden;/);                // out of the tab order until hover or focus
    expect(css).toContain(".ticket-who .ticket-assign { width: 104px; max-width: 104px; }");
    expect(css).toMatch(/\.ticket-card-controls \.ticket-move \{ width: 100%; \}/);                       // "In review" has the card's full width
    expect(css).toMatch(/\.ticket-cancel-icon \{[^}]*min-width: 26px; height: 26px;/);
    const hidden = css.split("}").filter((b) => /\.ticket-card-controls \{ visibility: hidden/.test(b) || /\.ticket-who \.ticket-assign-label \{/.test(b));
    for (const b of hidden) expect(b).not.toContain("display: none");
  });

  test("15.4 the card's Cancel is an icon button with an aria-label; the first click arms it and shows Confirm, the second cancels", async () => {
    await show(mk("a", "queued"));
    expect(card("a")).toContain('<button type="button" class="ticket-cancel-icon" data-ticket="a" data-to="cancelled" aria-label="Cancel ticket title-a"><svg');
    expect(card("a")).not.toContain("Confirm");
    const btn: any = { dataset: { ticket: "a", to: "cancelled" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    const orig = cols.querySelectorAll;
    cols.querySelectorAll = (sel: string) => (sel.includes(".ticket-actions button[data-to]") ? [btn] : []);
    ctx.setTimeout = () => 1;
    ctx.TicketBoard.setFilter(ctx.TicketBoard._filter());
    posts = [];
    btn.handlers.click();
    expect(card("a")).toContain('class="ticket-cancel-icon armed"');
    expect(card("a")).toContain('aria-label="Confirm cancel ticket title-a"');
    expect(card("a")).toContain("<span>Confirm</span>");
    expect(posts).toEqual([]);
    btn.handlers.click();
    expect(posts).toEqual([{ path: "/tickets/a/transition", body: { by: "human", to: "cancelled" } }]);
    ctx.setTimeout = setTimeout;
    cols.querySelectorAll = orig;
  });

  test("15.4 an unassigned ticket in a room with no agents keeps its label (no select to swap in); finished cards have no controls", async () => {
    await show(mk("a", "queued"), mk("d", "done"));
    const roster = ctx.ROSTER;
    ctx.ROSTER = [];                                                                         // no agents in the room
    ctx.TicketBoard.setFilter(ctx.TicketBoard._filter());
    expect(card("a")).not.toContain("ticket-assign");
    expect(card("a")).toContain('<span class="ticket-who-name">Unassigned</span>');
    ctx.ROSTER = roster;
    expect(card("d")).not.toContain("ticket-move");
    expect(card("d")).not.toContain("ticket-cancel-icon");
  });

  // ---- 15.5: the dialog shell ----
  const headMeta = () => els["ticket-view-head-meta"].innerHTML as string;
  const panelHtml = () => els["ticket-view-actions"].innerHTML as string;

  test("15.5 the page has a header, a body and a footer; only the body scrolls; Close, Cancel and Save sit in the footer", () => {
    const html = readFileSync("ui/index.html", "utf8");
    const dlg = html.slice(html.indexOf('id="ticket-view"'), html.indexOf("</dialog>", html.indexOf('id="ticket-view"')));
    const at = (x: string) => dlg.indexOf(x);
    const order = [at('class="ticket-view-head"'), at('id="ticket-view-head-meta"'), at('id="ticket-view-x"'), at('id="ticket-view-title"'), at('id="ticket-view-sub"'),
      at('id="ticket-view-body"'), at('id="ticket-view-content"'), at('id="ticket-view-attach-btn"'), at('id="ticket-view-actions"'),
      at('id="ticket-view-foot"'), at('id="ticket-view-row-actions"'), at('id="ticket-view-close"'), at('id="ticket-view-save"')];
    expect(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1]))).toBe(true);
    expect(dlg).toContain('<button type="button" class="ticket-view-x" id="ticket-view-x" aria-label="Close">');
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toMatch(/#ticket-view \.modal\.ticket-view \{[^}]*overflow: hidden; display: flex; flex-direction: column;/);   // the shell does not scroll
    expect(css).toMatch(/\.ticket-view-body \{[^}]*overflow: auto;/);                                                          // the body does
    expect(css).toMatch(/#ticket-view \.ticket-view-foot \{ position: static; flex: none;/);                                    // the footer stays
  });

  test("15.5 the body wraps: content left, panel right; in a narrow pane the panel goes above (container query), nothing scrolls sideways", () => {
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toMatch(/\.ticket-view-body \{[^}]*display: flex; flex-wrap: wrap;[^}]*container-type: inline-size;/);
    expect(css).toContain(".ticket-view-main { flex: 999 1 380px; min-width: 0; }");
    expect(css).toContain(".ticket-view-panel { flex: 1 1 264px; min-width: 264px;");   // 20 % wider than 220 px (15.12)
    expect(css).toContain("@container (max-width: 600px) { .ticket-view-panel { order: -1; flex-basis: 100%; } }");
  });

  test("15.5 the header: tag chip and code, status pill, the light with its label; the title once and the subtitle", async () => {
    await show(mk("a", "in_review", { title: "[code] 8.3b Hot reload: briefing [idle at once]", assignee: "alice" }));
    ctx.TicketBoard.openView("a");
    expect(headMeta()).toContain('<span class="ticket-tag tag-code">code</span><span class="ticket-code">8.3b</span>');
    expect(headMeta()).toContain('<span class="ticket-pill pill-in_review">In review</span>');
    expect(headMeta()).toContain('<span class="ticket-view-light"><span class="ticket-light"');
    expect(headMeta()).toContain('<span class="ticket-view-light-label">no one is working on it</span>');
    expect(els["ticket-view-title"].textContent).toBe("Hot reload: briefing");
    expect(els["ticket-view-sub"].textContent).toBe("idle at once");
    expect(els["ticket-view-sub"].hidden).toBe(false);
    // The title is not repeated in the content or the panel.
    const visible = (h: string) => h.replace(/<[^>]*>/g, "");                              // text only: an aria-label is not shown
    expect(visible(els["ticket-view-content"].innerHTML)).not.toContain("Hot reload: briefing");
    expect(visible(panelHtml())).not.toContain("Hot reload: briefing");
    await show(mk("b", "claimed"), mk("d", "done"));
    ctx.TicketBoard.openView("b");
    expect(headMeta()).toContain('pill-in_progress">In progress</span>');                 // claimed reads as In progress
    ctx.TicketBoard.openView("d");
    expect(headMeta()).toContain('pill-done">Done</span>');
    expect(headMeta()).not.toContain("ticket-view-light");                                 // a finished ticket has no light
    expect(els["ticket-view-sub"].hidden).toBe(true);
  });

  test("15.5 the pill colours follow the status: Draft dashed, Queued blue, In progress amber, In review purple, Done green, Cancelled red", () => {
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toContain(".ticket-pill.pill-draft { border: 1px dashed var(--line-hover); }");
    for (const [pill, token] of [["queued", "blue"], ["in_progress", "amber"], ["in_review", "purple"], ["done", "green"], ["cancelled", "red"]]) {
      expect(css).toContain(`.ticket-pill.pill-${pill} { background: color-mix(in srgb, var(--${token}) 20%, transparent); }`);
    }
  });

  test("15.5 the panel: Status, Assignee, Priority, Blast radius, Request, External ref, a rule, Created by, Updated only when different, Archived, ID with Copy", async () => {
    await show(mk("a", "in_review", { assignee: "alice", priority: "high", blast_radius: "high", request_id: "r-9", external_ref: "GH-1", creator: "carol", created_at_ms: 1000, updated_at_ms: 5000, archived_at_ms: 9000 }));
    ctx.TicketBoard.openView("a");
    const p = panelHtml();
    const order = ["ticket-move", "<dt>Assignee</dt>", "<dt>Priority</dt>", "<dt>Blast radius</dt>", '<dt class="dt-strong">Request</dt>', "<dt>External ref</dt>", "ticket-view-rule", "<dt>Created</dt>", "<dt>Updated</dt>", "<dt>Archived</dt>", "<dt>ID</dt>"].map((x) => p.indexOf(x));
    expect(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1]))).toBe(true);
    expect(p).toContain("by carol");
    expect(p).toContain('aria-label="Copy ticket ID"');
    expect(p).toContain(">Status <select");                                                  // the Move control is labelled Status
    await show(mk("b", "queued", { created_at_ms: 1000, updated_at_ms: 1000 }));
    ctx.TicketBoard.openView("b");
    expect(panelHtml()).not.toContain("<dt>Updated</dt>");                                   // same as Created
    expect(panelHtml()).not.toContain("<dt>Archived</dt>");
  });

  test("15.5 section headings are sentence case in the sans font with no uppercase mono label", () => {
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toMatch(/\.ticket-view-h \{[^}]*font-size: var\(--fs-xl\); font-weight: 600;[^}]*text-transform: none;[^}]*font-family: var\(--sans\)/);
  });

  test("15.5 the header Close button asks first when there are changes, like the footer Close and Escape", async () => {
    await show(draftT());
    const m = mount(draftVals);
    ctx.TicketBoard.openView("a");
    els["ticket-view-x"].handlers.click();
    expect(els["ticket-view"].open).toBe(false);                                             // no changes: closes
    ctx.TicketBoard.openView("a");
    m.type("title", "changed");
    els["ticket-view-x"].handlers.click();
    expect(els["ticket-view"].open).toBe(true);
    expect(els["ticket-view-notice"].innerHTML).toContain("Unsaved changes");
    unmount();
  });

  // ---- 15.11: fixes from the browser check ----
  test("15.11 after the picker adds or removes a blocker, Save is enabled and the count is 1", async () => {
    await show(mk("a", "queued", { title: "[code] 9.1 Main", blocked_by: ["d"], open_blockers: [] }), mk("d", "done", { title: "[code] 8.2 Done" }), mk("c", "queued", { title: "[code] 8.4 Candidate" }));
    startEdit("a");
    const add: any = { handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { add.handlers[t] = fn; } };
    const search: any = { value: "", handlers: {} as Record<string, any>, setAttribute() {}, addEventListener(t: string, fn: any) { search.handlers[t] = fn; } };
    const rm: any = { dataset: { id: "d" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { rm.handlers[t] = fn; } };
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-blocker-remove" ? [rm] : []);
    els["ticket-view-content"].querySelector = (sel: string) => (sel === "#ticket-blocker-add" ? add : sel === "#ticket-edit-blockers-search" ? search : null);
    ctx.TicketBoard.openView("a");
    expect(els["ticket-view-save"].disabled).toBe(true);
    expect(els["ticket-view-dirty"].hidden).toBe(true);
    add.handlers.click();
    ctx.TicketBoard.openView("a");
    search.handlers.keydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });   // add the candidate
    expect(els["ticket-view-save"].disabled).toBe(false);
    expect(els["ticket-view-dirty"].textContent).toBe("1 unsaved change");
    expect(els["ticket-view-dirty"].hidden).toBe(false);
    ctx.TicketBoard.openView("a");                                                          // a redraw keeps them
    rm.handlers.click();                                                                    // remove the done blocker: 2 changes against the ticket? no: the list is d,c minus d = c
    expect(els["ticket-view-save"].disabled).toBe(false);
    expect(els["ticket-view-dirty"].textContent).toBe("1 unsaved change");                  // one field (blocked_by) differs
    delete els["ticket-view-content"].querySelectorAll; delete els["ticket-view-content"].querySelector;
  });

  test("15.11 the picker leaves out cancelled tickets; done ones stay, after the open ones", async () => {
    await show(mk("a", "queued", { title: "[code] 9.1 Main" }), mk("x", "cancelled", { title: "[code] 8.1 Cancelled" }),
      mk("d", "done", { title: "[code] 8.2 Done" }), mk("o", "queued", { title: "[code] 8.3 Open" }));
    startEdit("a");
    const add: any = { handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { add.handlers[t] = fn; } };
    els["ticket-view-content"].querySelector = (sel: string) => (sel === "#ticket-blocker-add" ? add : null);
    ctx.TicketBoard.openView("a");
    add.handlers.click();
    const ids = [...content().matchAll(/<li role="option" id="ticket-blocker-opt-\d+"[^>]*data-id="(\w+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["o", "d"]);
    delete els["ticket-view-content"].querySelector;
  });

  test("15.11 the approval line after an answer: Approved by human · id, Denied by human · id; another resolver keeps the old text", async () => {
    const hi = (a: object) => mk("a", "in_review", { blast_radius: "high", approval_request_id: "req1", approval: { id: "req1", version: 1, ...a } });
    await show(hi({ status: "denied", resolved_by: "human" }));
    ctx.TicketBoard.openView("a");
    expect(content()).toContain("Denied by human · req1");
    expect(content()).not.toContain("not your approval");
    await show(hi({ status: "allowed", resolved_by: "human" }));
    ctx.TicketBoard.openView("a");
    expect(content()).toContain("Approved by human · req1");
    await show(hi({ status: "allowed", resolved_by: "Worker1" }));
    ctx.TicketBoard.openView("a");
    expect(content()).toContain("request allowed by Worker1 — not your approval");
  });

  test("15.11 layout: the dialog fills the board pane; the panel is at least 220 px; labels sit above their fields; long values wrap", () => {
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toMatch(/#ticket-view \.modal\.ticket-view \{[^}]*width: calc\(100% - 32px\); max-width: none;/);
    expect(css).toContain(".ticket-view-panel { flex: 1 1 264px; min-width: 264px;");   // 20 % wider than 220 px (15.12)
    expect(css).toContain(".ticket-view-panel .ticket-view-fields:first-of-type { grid-template-columns: minmax(0, 1fr);");
    expect(css).toContain(".ticket-view-panel dd { overflow-wrap: anywhere; }");
  });

  test("15.11 in a draft Status is the Move select; the hint shows only in the edit mode of another ticket", async () => {
    await show(mk("d", "draft"), mk("q", "queued"));
    ctx.TicketBoard.openView("d");
    expect(els["ticket-view-actions"].innerHTML).toContain('<label class="ticket-move-label">Status <select class="ticket-move"');
    expect(els["ticket-view-actions"].innerHTML).not.toContain("Move the ticket after you save.");
    els["ticket-view"].close();
    startEdit("q");
    expect(els["ticket-view-actions"].innerHTML).not.toContain("ticket-move");
    expect(els["ticket-view-actions"].innerHTML).toContain("Move the ticket after you save.");
  });

  test("15.11 the criteria heading: the count on the same line, the Write and Preview tabs at its right", async () => {
    await show(mk("d", "draft", { acceptance_criteria: "- [x] a\n- [ ] b" }));
    ctx.TicketBoard.openView("d");
    expect(content()).toMatch(/<div class="ticket-crit-head"><label for="ticket-edit-criteria">Acceptance criteria <span class="ticket-view-count" id="ticket-edit-progress">1 of 2 checked<\/span><\/label><div class="ticket-tabs" role="tablist"/);
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toContain(".ticket-crit-head { display: flex; align-items: baseline; justify-content: space-between;");
    expect(css).toContain(".ticket-request-form .ticket-crit-head label { display: inline;");
  });

  test("15.3 the traffic light is the same as before for every status", async () => {
    const lit = (id: string) => /<i class="on light-(\w+)">/.exec(card(id))?.[1] ?? null;
    await show(mk("q", "queued"), mk("c", "claimed", { assignee: "alice" }), mk("i", "in_progress", { assignee: "alice" }), mk("r", "in_review", { assignee: "alice" }),
      mk("d", "done"), mk("h", "queued", { assignee: "human" }));
    expect([lit("q"), lit("c"), lit("i"), lit("r"), lit("d"), lit("h")]).toEqual(["green", "orange", "orange", "green", null, "red"]);
  });

  test("the open dialog lists the blockers with title and status and updates when a blocker changes", async () => {
    await show(mk("a", "queued", { request_id: "r-1", blocked_by: ["b", "x"], open_blockers: ["b", "x"] }), mk("b", "in_progress", { version: 1 }));
    ctx.TicketBoard.openView("a");
    let html = els["ticket-view-content"].innerHTML as string;
    expect(html).toContain('<span class="ticket-blocker-title" title="title-b">title-b</span>');
    expect(html).toContain('<span class="ticket-pill ticket-blocker-state is-open">In progress</span>');
    expect(html).toContain('<span class="ticket-blocker-title" title="x">x</span>');                      // not on the board: its id
    expect(html).toContain('<span class="ticket-pill ticket-blocker-state is-open">Open</span>');          // the server says open
    expect(els["ticket-view-actions"].innerHTML).toContain("r-1");                     // read mode: the Request row
    els["ticket-view-edit"].handlers.click();                                           // Edit: the fields
    expect(els["ticket-view-actions"].innerHTML).toContain('id="ticket-edit-request" value="r-1"');
    expect(els["ticket-view-content"].innerHTML).toContain('id="ticket-edit-blockers" class="ticket-blocker-edit" role="group" aria-label="Blockers" tabindex="-1" data-ids="b,x"');
    ev(mk("b", "done"), 5);
    html = els["ticket-view-content"].innerHTML as string;
    expect(html).toContain('<span class="ticket-pill ticket-blocker-state is-done">Done</span>');
  });

  test("the human saves the request and blockers through POST /tickets/:id/edit; only changed fields are sent; an empty label sends null", async () => {
    await show(mk("a", "queued", { request_id: "r-1", blocked_by: ["b"], open_blockers: ["b"] }), mk("b", "queued"));
    const req = { value: "r-1", addEventListener() {} }, blk = { value: "b", addEventListener() {} };
    let submit: any;
    const form = { addEventListener: (t: string, fn: any) => { if (t === "submit") submit = fn; } };
    els["ticket-view-content"].querySelector = (sel: string) => ({ "#ticket-request-form": form, "#ticket-edit-request": req, "#ticket-edit-blockers": blk } as any)[sel] ?? null;
    posts = [];
    ctx.TicketBoard.openView("a");
    els["ticket-view-edit"].handlers.click();                                   // a queued ticket opens in read mode: Edit unlocks the fields
    await submit({ preventDefault() {} });
    expect(posts).toEqual([]);                                   // nothing changed: no request
    req.value = "  r-2 ";
    ctx.TicketBoard._commitBlockers(["b", "c"]);                 // the picker's path: the list is a model, not a typed value
    await submit({ preventDefault() {} });
    expect(posts).toEqual([{ path: "/tickets/a/edit", body: { by: "human", request_id: "r-2", blocked_by: ["b", "c"] } }]);
    req.value = "r-1";
    ctx.TicketBoard.openView("a");
    req.value = "";
    ctx.TicketBoard._commitBlockers(["b"]);
    await submit({ preventDefault() {} });
    expect(posts[1].body).toEqual({ by: "human", request_id: null });
    delete els["ticket-view-content"].querySelector;
  });

  // ---- 6.7: the editor in the ticket dialog ----
  const stub = (v = "") => { const h: Record<string, any[]> = {}; return { value: v, handlers: h, addEventListener(t: string, fn: any) { (h[t] ??= []).push(fn); }, focus() {}, setSelectionRange() {} }; };
  // Fake the form controls of the open dialog; returns them with `type` (sets a value and fires input) and `submit`.
  function mount(values: Record<string, string>) {
    const f: any = {};
    for (const k of Object.keys(values)) f[k] = stub(values[k]);
    let submit: any;
    const form = { addEventListener: (t: string, fn: any) => { if (t === "submit") submit = fn; } };
    els["ticket-view-content"].querySelector = (sel: string) => {
      if (sel === "#ticket-request-form") return form;
      const m = /#ticket-edit-(\w+)/.exec(sel);
      return m ? f[m[1]] ?? null : null;
    };
    return {
      f,
      submit: () => submit({ preventDefault() {} }),
      type: (k: string, v: string) => { f[k].value = v; for (const fn of f[k].handlers.input ?? []) fn(); },
    };
  }
  const unmount = () => { delete els["ticket-view-content"].querySelector; };
  const draftVals = { title: "title-a", criteria: "crit", radius: "low", priority: "medium", assignee: "", ref: "", request: "", blockers: "" };
  const draftT = (extra: object = {}) => mk("a", "draft", { acceptance_criteria: "crit", ...extra });

  test("1: a draft opens in edit mode with no Edit button: the title in the header, the criteria and blockers in the content, the other fields in the panel", async () => {
    await show(draftT());
    ctx.TicketBoard.openView("a");
    const html = els["ticket-view-content"].innerHTML as string;
    const panel = els["ticket-view-actions"].innerHTML as string;
    const order = (h: string, ids: string[]) => ids.map((x) => h.indexOf(x));
    const ok = (n: number[]) => n.every((v, i) => v >= 0 && (i === 0 || v > n[i - 1]));
    expect(ok(order(html, ['data-edit-md="bold"', 'id="ticket-edit-criteria"', 'id="ticket-edit-blockers"']))).toBe(true);
    expect(ok(order(panel, ['id="ticket-edit-assignee"', 'id="ticket-edit-priority"', 'id="ticket-edit-radius"', 'id="ticket-edit-request"', 'id="ticket-edit-ref"']))).toBe(true);
    expect(els["ticket-view-title"].innerHTML).toContain('id="ticket-edit-title"');       // the one title: an input in the header
    for (const gone of ['id="ticket-edit-title"', 'id="ticket-edit-assignee"', 'id="ticket-edit-priority"', 'id="ticket-edit-request"', 'id="ticket-edit-ref"']) expect(html).not.toContain(gone);
    expect(panel).toContain('<option value="alice">alice</option>');
    expect(panel).toContain('<input type="radio" name="ticket-edit-radius" value="low" checked />');   // the Low and High radio pair
    expect(panel).toContain('role="radiogroup"');
    expect(panel).toContain("ticket-move");                                              // a draft's Status is the Move select (15.11)
    expect(panel).not.toContain("Move the ticket after you save.");                      // the hint is for the edit mode of other tickets
    expect(els["ticket-view-edit"].hidden).toBe(true);                                   // no Edit button on a draft
    expect(els["ticket-view-save"].hidden).toBe(false);
  });

  test("15.7: edit mode has Write and Preview tabs; Preview renders the current text; the count follows the checklist lines", async () => {
    await show(draftT({ acceptance_criteria: "- [x] a\n- [ ] b" }));
    ctx.TicketBoard.openView("a");
    const html = els["ticket-view-content"].innerHTML as string;
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="ticket-tab-write" aria-controls="ticket-pane-write" aria-selected="true" tabindex="0"');
    expect(html).toContain('id="ticket-tab-preview" aria-controls="ticket-pane-preview" aria-selected="false" tabindex="-1"');
    expect(html.indexOf('data-edit-md="bold"')).toBeGreaterThan(html.indexOf('id="ticket-pane-write"'));   // the toolbar and the field are in Write
    expect(html.indexOf('id="ticket-edit-criteria"')).toBeLessThan(html.indexOf('id="ticket-pane-preview"'));
    expect(html).toMatch(/id="ticket-pane-preview"[^>]* hidden>.*md-checklist/s);                        // Preview holds mdHtml() of the text
    expect(html).toContain("1 of 2 checked");
  });


  test("2: queued, claimed, in progress and in review open in read mode with an Edit button; Edit unlocks the fields; done and cancelled have none", async () => {
    await show(mk("a", "queued"), mk("c", "in_progress"), mk("r", "in_review"), mk("d", "done"), mk("x", "cancelled"));
    for (const id of ["a", "c", "r"]) {
      ctx.TicketBoard.openView(id);
      expect([id, els["ticket-view-edit"].hidden]).toEqual([id, false]);
      expect([id, (els["ticket-view-content"].innerHTML as string).includes("ticket-edit-")]).toEqual([id, false]);   // read mode: no fields
      expect([id, els["ticket-view-save"].hidden]).toEqual([id, true]);
      els["ticket-view"].close();
    }
    ctx.TicketBoard.openView("r");
    els["ticket-view-edit"].handlers.click();
    expect(els["ticket-view-edit"].hidden).toBe(true);                                   // in edit mode the button is gone
    expect(els["ticket-view-head-meta"].innerHTML).toContain('<span class="ticket-pill pill-editing">Editing</span>');
    const html = els["ticket-view-content"].innerHTML as string, panel = els["ticket-view-actions"].innerHTML as string;
    for (const id of ["criteria", "blockers"]) expect(html).toContain(`id="ticket-edit-${id}"`);
    for (const id of ["assignee", "priority", "radius", "request", "ref"]) expect(panel).toContain(`id="ticket-edit-${id}"`);
    expect(els["ticket-view-title"].innerHTML).toContain('id="ticket-edit-title"');
    expect(els["ticket-view-save"].hidden).toBe(false);
    els["ticket-view"].close();
    for (const id of ["d", "x"]) {
      ctx.TicketBoard.openView(id);
      expect([id, els["ticket-view-edit"].hidden]).toEqual([id, true]);                  // finished: the hub refuses edits
      expect([id, els["ticket-view-save"].hidden]).toEqual([id, true]);
      els["ticket-view"].close();
    }
  });

  test("5: Save changes is disabled until a field differs; it sends only the changed fields, then assign when the assignee changed", async () => {
    await show(draftT());
    const m = mount(draftVals);
    posts = [];
    ctx.TicketBoard.openView("a");
    expect(els["ticket-view-save"].hidden).toBe(false);
    expect(els["ticket-view-save"].disabled).toBe(true);
    m.type("title", "new title");
    expect(els["ticket-view-save"].disabled).toBe(false);
    m.type("title", "title-a");
    expect(els["ticket-view-save"].disabled).toBe(true);                       // back to the ticket's value
    m.type("title", "new title"); m.type("priority", "highest"); m.type("ref", " AUD-1 "); m.type("assignee", "alice");
    await m.submit();
    expect(posts).toEqual([
      { path: "/tickets/a/edit", body: { by: "human", title: "new title", priority: "highest", external_ref: "AUD-1" } },
      { path: "/tickets/a/assign", body: { by: "human", assignee: "alice" } },
    ]);
    unmount();
  });

  test("5: with nothing changed, Save sends nothing", async () => {
    await show(draftT());
    const m = mount(draftVals);
    posts = [];
    ctx.TicketBoard.openView("a");
    await m.submit();
    expect(posts).toEqual([]);
    unmount();
  });

  test("8: a refused edit shows the hub error above the action row and the fields keep the typed values", async () => {
    await show(draftT());
    const m = mount(draftVals);
    ctx.TicketBoard.openView("a");
    m.type("title", "typed");
    failPath = "/tickets/a/edit";
    await m.submit();
    expect(els["ticket-view-notice"].innerHTML).toContain("Not saved: upload refused");   // the harness's parseErrorBody text
    expect(m.f.title.value).toBe("typed");
    expect(els["ticket-view-title"].innerHTML).toContain('id="ticket-edit-title" class="ticket-title-input" aria-label="Title" value="title-a"');
    ctx.TicketBoard.openView("a");                                                          // a redraw restores what was typed
    expect(els["ticket-view-title"].innerHTML).toContain('value="typed"');
    expect(els["ticket-view-save"].disabled).toBe(false);
    m.type("title", "typed again");                                                         // typing clears the error
    expect(els["ticket-view-notice"].innerHTML).toBe("");
    failPath = null;
    unmount();
  });

  // ---- 6.8: a refused Save shows its message where the human looks ----
  test("6.8 a refused Blocked by shows a red field error under it, aria-invalid, role alert; typed values stay", async () => {
    await show(mk("a", "queued"));
    const m = mount({ request: "", blockers: "" });
    els["ticket-edit-blockers"] = m.f.blockers;                             // the field exists in the page, so the error can focus it
    ctx.TicketBoard.openView("a");
    els["ticket-view-edit"].handlers.click();                                   // a queued ticket opens in read mode: Edit unlocks the fields
    ctx.TicketBoard._commitBlockers(["Blocker"]);
    refuseText = "invalid blocker id: Blocker";
    failPath = "/tickets/a/edit";
    await m.submit();
    const html = els["ticket-view-content"].innerHTML as string;
    expect(html).toContain('aria-invalid="true" aria-describedby="ticket-edit-blockers-error"');                         // on the blockers group
    expect(html).toContain('<div class="ticket-field-error" id="ticket-edit-blockers-error" role="alert">Not saved: invalid blocker id: Blocker</div>');
    expect(html.indexOf("ticket-edit-blockers-error")).toBeGreaterThan(html.indexOf('id="ticket-edit-blockers"'));   // under the list
    expect(els["ticket-view-notice"].innerHTML).toBe("");                   // not also above the action row
    expect(els["ticket-view-save"].disabled).toBe(false);                   // the typed value stays and can be fixed
    delete els["ticket-edit-blockers"]; failPath = null; unmount();
  });

  test("6.8 editing the refused field clears the red border and the message; editing another field does not", async () => {
    await show(mk("a", "queued"));
    const m = mount({ request: "", blockers: "" });
    const attrs: Record<string, Set<string>> = { blockers: new Set(["aria-invalid", "aria-describedby"]) };
    m.f.blockers.removeAttribute = (a: string) => attrs.blockers.delete(a);
    let errorEl = true;
    const base = els["ticket-view-content"].querySelector;
    els["ticket-view-content"].querySelector = (sel: string) => (sel === "#ticket-edit-blockers-error" ? (errorEl ? { remove: () => { errorEl = false; } } : null) : base(sel));
    els["ticket-edit-blockers"] = m.f.blockers;
    ctx.TicketBoard.openView("a");
    els["ticket-view-edit"].handlers.click();                                   // a queued ticket opens in read mode: Edit unlocks the fields
    ctx.TicketBoard._commitBlockers(["Blocker"]);
    refuseText = "invalid blocker id: Blocker";
    failPath = "/tickets/a/edit";
    await m.submit();
    m.type("request", "r-1");                                              // another field: the error stays
    expect(errorEl).toBe(true);
    expect(attrs.blockers.has("aria-invalid")).toBe(true);
    ctx.TicketBoard._commitBlockers(["t_0123456789abcdef"]);               // the refused list is changed: the error goes with the redraw
    ctx.TicketBoard.openView("a");
    expect(els["ticket-view-content"].innerHTML).not.toContain("ticket-field-error");
    delete els["ticket-edit-blockers"]; failPath = null; unmount();
  });

  test("6.8 a refused Request shows its error under Request; any other refusal shows above the action row, in --text with a red bar", async () => {
    await show(mk("a", "queued"));
    const m = mount({ request: "", blockers: "" });
    els["ticket-edit-request"] = m.f.request;
    ctx.TicketBoard.openView("a");
    els["ticket-view-edit"].handlers.click();                                   // a queued ticket opens in read mode: Edit unlocks the fields
    m.type("request", "bad label");
    refuseText = "invalid request_id";
    failPath = "/tickets/a/edit";
    await m.submit();
    expect(els["ticket-view-actions"].innerHTML).toContain('id="ticket-edit-request-error" role="alert">Not saved: invalid request_id</div>');   // under the Request input, in the panel
    delete els["ticket-edit-request"];
    m.type("request", "r-2");
    refuseText = "ticket already cancelled";                                // no field fits
    await m.submit();
    expect(els["ticket-view-notice"].innerHTML).toContain('class="ticket-view-notice-text ticket-view-notice-error">Not saved: ticket already cancelled');
    ctx.TicketBoard.openView("a");                                         // a redraw: no field error is drawn for it
    expect(els["ticket-view-content"].innerHTML).not.toContain("ticket-field-error");
    m.type("request", "r-3");                                              // any edit clears a message with no field
    expect(els["ticket-view-notice"].innerHTML).toBe("");
    failPath = null; unmount();
  });

  test("6.8 the error line and the action row sit in one sticky footer with the dialog background", () => {
    const html = readFileSync("ui/index.html", "utf8");
    const foot = html.slice(html.indexOf('id="ticket-view-foot"'), html.indexOf("</dialog>", html.indexOf('id="ticket-view-foot"')));
    for (const id of ['id="ticket-view-notice"', 'id="ticket-view-bottom"', 'id="ticket-view-close"', 'id="ticket-view-save"']) expect(foot).toContain(id);
    expect(html).toContain('<div class="ticket-view-foot" id="ticket-view-foot">');
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toContain(".ticket-view-foot { position: sticky; bottom: 0; background: var(--bg-raised);");
    expect(css).toMatch(/\.ticket-dialog \.modal \{[^}]*overflow: auto/);                // the dialog is the scroll container the footer sticks in
  });

  test("6.8 a refused assignee change shows its error under the Assignee select; every key setViewError gets has a field that renders it", async () => {
    await show(draftT({ assignee: "alice" }));
    const m = mount({ ...draftVals, assignee: "alice" });
    els["ticket-edit-assignee"] = m.f.assignee;
    ctx.TicketBoard.openView("a");
    m.type("assignee", "bob");
    refuseText = "ticket already claimed";
    failPath = "/tickets/a/assign";
    await m.submit();
    const html = els["ticket-view-actions"].innerHTML as string;                       // the Assignee select is in the panel
    expect(html).toContain('<select id="ticket-edit-assignee" aria-invalid="true" aria-describedby="ticket-edit-assignee-error">');
    expect(html).toContain('id="ticket-edit-assignee-error" role="alert">Not saved: ticket already claimed</div>');
    expect(els["ticket-view-notice"].innerHTML).toBe("");                   // shown once, under the field
    m.type("assignee", "alice");                                            // editing the field clears it
    ctx.TicketBoard.openView("a");                                          // (the fake DOM keeps the old string until a redraw)
    expect(els["ticket-view-actions"].innerHTML).not.toContain("assignee-error");
    // Every field key a refusal can name renders its error and attributes on a draft.
    for (const [key, text] of [["title", "invalid title"], ["criteria", "invalid acceptance_criteria"], ["radius", "invalid blast_radius"], ["priority", "invalid priority"],
      ["ref", "invalid external_ref"], ["request", "invalid request_id"], ["blockers", "invalid blocker id: x"], ["assignee", "cannot assign"]] as const) {
      refuseText = text;
      els[`ticket-edit-${key}`] = m.f[key];
      if (key === "blockers") ctx.TicketBoard._commitBlockers(["x"]); else m.type(key, key === "assignee" ? "bob" : "x");
      failPath = key === "assignee" ? "/tickets/a/assign" : "/tickets/a/edit";
      await m.submit();
      const where = key === "title" ? "ticket-view-title" : ["criteria", "blockers"].includes(key) ? "ticket-view-content" : "ticket-view-actions";   // header, content or panel
      const h = els[where].innerHTML as string;
      expect([key, h.includes(`id="ticket-edit-${key}-error" role="alert"`)]).toEqual([key, true]);
      expect([key, h.includes(`id="ticket-edit-${key}" `) && /aria-invalid="true"/.test(h)]).toEqual([key, true]);
      delete els[`ticket-edit-${key}`];
      ctx.TicketBoard.openView("a");
      if (key === "blockers") ctx.TicketBoard._commitBlockers([]); else m.type(key, key === "assignee" ? "alice" : key === "title" ? "title-a" : key === "criteria" ? "crit" : key === "radius" ? "low" : key === "priority" ? "medium" : "");
    }
    delete els["ticket-edit-assignee"]; failPath = null; unmount();
  });

  test("6.8 the error text is --text with the red as a border (no red token reaches 4.5:1 on all three themes)", () => {
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toContain(".ticket-field-error, .ticket-view-notice-error { color: var(--text);");
    // The invalid border must win over ".modal input:focus" and ":hover" (specificity 0,2,1), also while the refused field has focus.
    expect(css).toContain('#ticket-view .ticket-request-form [aria-invalid="true"], #ticket-view .ticket-request-form [aria-invalid="true"]:focus, #ticket-view .ticket-request-form [aria-invalid="true"]:hover { border-color: var(--red);');
    expect(css).toMatch(/\.ticket-field-error \{[^}]*border-left: 3px solid var\(--red\); padding-left/);   // the field message has the same red bar as the generic notice
    expect(css).toContain(".ticket-view-notice-error { display: inline-block; border-left: 3px solid var(--red);");
  });

  test("6: Cancel ticket needs a second click: the first arms it for 5 seconds", async () => {
    await show(draftT());
    const row = els["ticket-view-row-actions"];
    const btn: any = { dataset: { ticket: "a", cancel: "1" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    row.querySelectorAll = (sel: string) => (sel === ".ticket-cancel-btn" ? [btn] : []);
    let fire: any = null;
    ctx.setTimeout = (fn: any, ms: number) => { expect(ms).toBe(5000); fire = fn; return 1; };
    posts = [];
    ctx.TicketBoard.openView("a");
    expect(row.innerHTML).toContain(">Cancel ticket</button>");
    btn.handlers.click();
    expect(row.innerHTML).toContain(">Confirm cancel</button>");
    expect(posts).toEqual([]);                                                              // nothing cancelled yet
    fire();                                                                                 // 5 seconds pass
    expect(row.innerHTML).toContain(">Cancel ticket</button>");
    btn.handlers.click();
    btn.handlers.click();                                                                   // second click within 5 seconds
    expect(posts).toEqual([{ path: "/tickets/a/transition", body: { by: "human", to: "cancelled" } }]);
    ctx.setTimeout = setTimeout;
    row.querySelectorAll = function (this: any, sel: string) { this.queried.push(sel); return []; };
  });

  test("7: Close, the backdrop and Escape ask first when there are changes; Keep editing stays, Discard closes", async () => {
    await show(draftT());
    const m = mount(draftVals);
    ctx.TicketBoard.openView("a");
    els["ticket-view-close"].handlers.click();                                              // no changes: closes
    expect(els["ticket-view"].open).toBe(false);
    ctx.TicketBoard.openView("a");
    m.type("title", "changed");
    els["ticket-view-close"].handlers.click();
    expect(els["ticket-view"].open).toBe(true);
    expect(els["ticket-view-notice"].innerHTML).toContain("Unsaved changes");
    expect(els["ticket-view-notice"].innerHTML).toContain(">Discard</button>");
    expect(els["ticket-view-notice"].innerHTML).toContain(">Keep editing</button>");
    els["ticket-view-notice"].querySelector("#ticket-view-keep").handlers.click();
    expect(els["ticket-view-notice"].innerHTML).toBe("");
    expect(els["ticket-view"].open).toBe(true);
    let prevented = 0;
    els["ticket-view"].handlers.cancel({ preventDefault() { prevented++; } });              // Escape
    expect(prevented).toBe(1);
    expect(els["ticket-view-notice"].innerHTML).toContain("Unsaved changes");
    els["ticket-view"].handlers.click({ target: els["ticket-view"] });                      // the backdrop
    expect(els["ticket-view"].open).toBe(true);
    els["ticket-view-notice"].querySelector("#ticket-view-discard").handlers.click();
    expect(els["ticket-view"].open).toBe(false);
    unmount();
  });

  test("5: saving Unassigned on a draft goes through the assign route with a null assignee", async () => {
    await show(draftT({ assignee: "alice" }));
    const m = mount({ ...draftVals, assignee: "alice" });
    posts = [];
    ctx.TicketBoard.openView("a");
    m.type("assignee", "");
    expect(els["ticket-view-save"].disabled).toBe(false);
    await m.submit();
    expect(posts).toEqual([{ path: "/tickets/a/assign", body: { by: "human", assignee: null } }]);
    unmount();
  });

  test("contrast: the new dialog labels and buttons use --text, not --text-dim or --text-muted", () => {
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toContain("#ticket-view .ticket-view-attach button, #ticket-view .ticket-view-bottom button, #ticket-view #ticket-view-notice button { color: var(--text); }");
    expect(css).toContain('#ticket-new-form label[for="ticket-f-request"], #ticket-new-form label[for="ticket-f-blockers"] { color: var(--text); }');
  });

  // ---- 15.6: read mode, edit mode, the Edit button ----
  const editVals = { title: "title-r", criteria: "crit", radius: "low", priority: "medium", assignee: "alice", ref: "", request: "", blockers: "" };
  const inReview = (extra: object = {}) => mk("r", "in_review", { assignee: "alice", acceptance_criteria: "crit", ...extra });
  const startEdit = (id = "r") => { ctx.TicketBoard.openView(id); els["ticket-view-edit"].handlers.click(); };

  test("15.6 the human edits the title and priority of an in-review ticket; one edit with only those fields; edit mode ends and the card shows the new values", async () => {
    await show(inReview());
    const m = mount(editVals);
    posts = [];
    startEdit();
    m.type("title", "new title"); m.type("priority", "highest");
    await m.submit();
    expect(posts).toEqual([{ path: "/tickets/r/edit", body: { by: "human", title: "new title", priority: "highest" } }]);
    expect(els["ticket-view-edit"].hidden).toBe(false);                                  // back in read mode
    expect(els["ticket-view-save"].hidden).toBe(true);
    ev(inReview({ title: "new title", priority: "highest" }), 9);                        // the hub's event
    expect(card("r")).toContain('<div class="ticket-title">new title</div>');
    expect(card("r")).toContain("Highest");
    unmount();
  });

  test("15.6 edit mode: Editing pill; N unsaved changes next to Save; Discard changes at the left leaves edit mode and drops what was typed", async () => {
    await show(inReview());
    const m = mount(editVals);
    startEdit();
    expect(els["ticket-view-actions"].innerHTML).toContain("Move the ticket after you save.");
    expect(els["ticket-view-row-actions"].innerHTML).toContain('id="ticket-discard-btn">Discard changes</button>');
    expect(els["ticket-view-row-actions"].innerHTML).not.toContain("Cancel ticket");     // Discard replaces Cancel ticket in edit mode
    expect(els["ticket-view-dirty"].hidden).toBe(true);
    m.type("title", "x");
    expect(els["ticket-view-dirty"].textContent).toBe("1 unsaved change");
    m.type("priority", "high");
    expect(els["ticket-view-dirty"].textContent).toBe("2 unsaved changes");
    const discard: any = { handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { discard.handlers[t] = fn; } };
    els["ticket-view-row-actions"].querySelector = (sel: string) => (sel === "#ticket-discard-btn" ? discard : null);
    ctx.TicketBoard.openView("r");                                                       // a redraw wires the button
    discard.handlers.click();
    expect(els["ticket-view-edit"].hidden).toBe(false);                                  // read mode again
    expect(els["ticket-view-content"].innerHTML).not.toContain("ticket-edit-");
    expect(els["ticket-view-dirty"].hidden).toBe(true);
    els["ticket-view-edit"].handlers.click();                                            // edit again: the typed values are gone
    expect(els["ticket-view-title"].innerHTML).toContain('value="title-r"');
    unmount();
  });

  test("15.6 Close in edit mode with changes asks first; Save is the only primary button in edit mode", async () => {
    await show(inReview());
    const m = mount(editVals);
    startEdit();
    els["ticket-view-close"].handlers.click();
    expect(els["ticket-view"].open).toBe(false);                                         // no changes: closes
    startEdit();
    m.type("title", "changed");
    els["ticket-view-close"].handlers.click();
    expect(els["ticket-view"].open).toBe(true);
    expect(els["ticket-view-notice"].innerHTML).toContain("Unsaved changes");
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toContain(".ticket-view-bottom #ticket-view-save:not([hidden]), .ticket-view-bottom:has(#ticket-view-save[hidden]) #ticket-view-close {");   // Close is primary only when Save is hidden
    unmount();
  });

  test("15.6 with a pending approval, edit mode shows the warning; without one it does not", async () => {
    await show(inReview({ blast_radius: "high", approval_request_id: "req1", approval: { id: "req1", status: "pending", version: 1 } }), mk("n", "in_review", { assignee: "alice" }));
    startEdit("r");
    expect(els["ticket-view-content"].innerHTML).toContain("This ticket waits for your approval. If you save new acceptance criteria or set the blast radius to low, alice&#39;s approval request is cancelled.".replace("&#39;", "'"));
    els["ticket-view"].close();
    ctx.TicketBoard.openView("r");
    expect(els["ticket-view-content"].innerHTML).not.toContain("waits for your approval. If you save");   // read mode: no warning
    els["ticket-view"].close();
    startEdit("n");
    expect(els["ticket-view-content"].innerHTML).not.toContain("ticket-edit-warning");
  });

  test("15.6 saving new criteria on a ticket with a pending approval: the hub clears the pointer, and the card light is no longer red", async () => {
    await show(inReview({ blast_radius: "high", approval_request_id: "req1", approval: { id: "req1", status: "pending", version: 1 }, version: 1 }));
    expect(card("r")).toContain("Waiting for your approval");
    expect(card("r")).toContain("light-red");
    const m = mount({ ...editVals, radius: "high" });
    posts = [];
    startEdit();
    m.type("criteria", "new criteria");
    await m.submit();
    expect(posts[0].body).toEqual({ by: "human", acceptance_criteria: "new criteria" });
    ev(inReview({ blast_radius: "high", approval_request_id: null, acceptance_criteria: "new criteria" }), 9);   // the hub's event: pointer cleared
    expect(card("r")).not.toContain("Waiting for your approval");
    expect(card("r")).not.toContain("light-red");
    unmount();
  });

  test("15.6 the blast radius is a Low and High radio pair; the checked radio is what Save sends", async () => {
    await show(inReview());
    const m = mount({ ...editVals, radius: "ignored" });
    m.f.radius.value = undefined;
    m.f.radius.querySelector = (sel: string) => (sel === "input:checked" ? { value: "high" } : null);   // the group element, as in the page
    posts = [];
    startEdit();
    m.type("radius", "x");                                                               // fires the change handler
    await m.submit();
    expect(posts[0].body).toEqual({ by: "human", blast_radius: "high" });
    unmount();
  });

  test("15.6 typed values survive a redraw in edit mode, and a refused edit shows under its field", async () => {
    await show(inReview());
    const m = mount(editVals);
    startEdit();
    m.type("title", "typed");
    ev(inReview({ version: 7 }), 7);                                                     // a ticket event redraws the dialog
    expect(els["ticket-view-title"].innerHTML).toContain('value="typed"');
    expect(els["ticket-view-edit"].hidden).toBe(true);                                   // still in edit mode
    failPath = "/tickets/r/edit"; refuseText = "invalid title";
    els["ticket-edit-title"] = m.f.title;                                                // the field exists in the page, so the error can focus it
    await m.submit();
    expect(els["ticket-view-title"].innerHTML).toContain('id="ticket-edit-title-error" role="alert">Not saved: invalid title</div>');
    delete els["ticket-edit-title"]; failPath = null;
    unmount();
  });

  test("15.6 the editor stays closed for a ticket that becomes done while the dialog is open", async () => {
    await show(inReview());
    startEdit();
    expect(els["ticket-view-save"].hidden).toBe(false);
    ev(mk("r", "done"), 9);
    expect(els["ticket-view-save"].hidden).toBe(true);
    expect(els["ticket-view-edit"].hidden).toBe(true);
  });

  test("15.6 order of the content: criteria, Blocked by, attachments, then notes; headings carry their count in --text-meta; labels are sentence case", async () => {
    await show(mk("a", "in_review", { blocked_by: ["b"], open_blockers: ["b"], acceptance_criteria: "- [x] one\n- [ ] two", attachments_count: 1, notes_count: 2 }), mk("b", "queued"));
    ctx.TicketBoard.openView("a");
    const html = (els["ticket-view-content"].innerHTML as string) + (els["ticket-view-notes"].innerHTML as string);
    const order = ["Acceptance criteria", "Blocked by", "Attachments", "Notes"].map((x) => html.indexOf(x));
    expect(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1]))).toBe(true);
    expect(html).toContain('Acceptance criteria <span class="ticket-view-count">1 of 2 checked</span>');
    expect(html).toContain('Blocked by <span class="ticket-view-count">1 open</span>');
    expect(html).toContain('Notes <span class="ticket-view-count">2</span>');
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toContain(".ticket-view-count { font-family: var(--sans); font-weight: 400; font-size: var(--fs-sm); color: var(--text-meta); }");
    expect(css).toMatch(/#ticket-view label, #ticket-view \.ticket-field-label, #ticket-view \.ticket-view-panel dt \{[^}]*text-transform: none;/);
    const page = readFileSync("ui/index.html", "utf8");
    expect(page.indexOf('id="ticket-view-attach-btn"')).toBeLessThan(page.indexOf('id="ticket-view-notes"'));   // the Attach button is under the attachments, above the notes
  });

  // ---- 15.8: blocker rows and the picker ----
  const bt = (id: string, status: string, title: string, extra: object = {}) => mk(id, status, { title, ...extra });
  const content = () => els["ticket-view-content"].innerHTML as string;
  const chain = () => [
    mk("a", "queued", { title: "[code] 9.1 Main ticket", blocked_by: ["d", "x"], open_blockers: ["x"] }),
    bt("d", "done", "[code] 8.2 Done blocker"),
    bt("o", "in_review", "[code] 8.3a Open one"),
    bt("c", "queued", "[code] 8.4 Candidate"),
    bt("l", "queued", "[code] 8.5 Waits on a", { blocked_by: ["a"], open_blockers: ["a"] }),   // would close a loop
    bt("g", "queued", "[code] 8.6 Waits on l", { blocked_by: ["l"], open_blockers: ["l"] }),   // a loop through l
  ];

  test("15.8 each blocker is a row: status icon, code, title with ellipsis, status pill; no strikethrough; unknown ones from open_blockers", async () => {
    await show(...chain());
    ctx.TicketBoard.openView("a");
    const rows = content().match(/<li class="ticket-blocker-row[^>]*>.*?<\/li>/gs) ?? [];
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain("blocker-done");
    expect(rows[0]).toContain('<span class="ticket-code">8.2</span><span class="ticket-blocker-title" title="Done blocker">Done blocker</span>');
    expect(rows[0]).toContain('is-done">Done</span>');
    expect(rows[1]).toContain("blocker-open");
    expect(rows[1]).toContain('title="x">x</span><span class="ticket-pill ticket-blocker-state is-open">Open</span>');
    expect(content()).not.toContain("ticket-blocker-remove");                           // read mode: no remove button
    expect(content()).not.toContain("ticket-blocker-add");
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).not.toContain("text-decoration: line-through");
    expect(css).toMatch(/\.ticket-blocker-title \{[^}]*text-overflow: ellipsis;/);
  });

  test("15.8 edit mode: each row has a Remove button named by the code or title; Remove drops it from the list that Save sends", async () => {
    await show(...chain());
    const m = mount({ request: "", blockers: "" });
    posts = [];
    startEdit("a");
    expect(content()).toContain('aria-label="Remove blocker 8.2"');
    expect(content()).toContain('aria-label="Remove blocker x"');                       // no code: the title (here the id)
    const rm: any = { dataset: { id: "d" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { rm.handlers[t] = fn; } };
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-blocker-remove" ? [rm] : []);
    els["ticket-view-content"].querySelector = (sel: string) => (sel === "#ticket-request-form" ? { addEventListener() {} } : null);
    ctx.TicketBoard.openView("a");                                                      // a redraw wires the button
    rm.handlers.click();
    expect(content()).not.toContain('aria-label="Remove blocker 8.2"');
    expect(els["ticket-view-save"].disabled).toBe(false);                               // the list differs from the ticket's
    expect(content()).toContain('data-ids="x"');
    delete els["ticket-view-content"].querySelectorAll; unmount();
  });

  test("15.8 the picker lists the room's tickets without the ticket, its blockers and loop makers; open first; text matches code and title", async () => {
    await show(...chain(), bt("z", "done", "[code] 1.0 Old and done"));
    startEdit("a");
    els["ticket-view-content"].querySelector = () => null;
    const add: any = { handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { add.handlers[t] = fn; } };
    els["ticket-view-content"].querySelector = (sel: string) => (sel === "#ticket-blocker-add" ? add : null);
    ctx.TicketBoard.openView("a");
    add.handlers.click();                                                               // opens the search
    const html = content();
    expect(html).toContain('role="combobox" aria-expanded="true" aria-controls="ticket-blocker-listbox" aria-autocomplete="list"');
    expect(html).toContain('aria-activedescendant="ticket-blocker-opt-0"');
    expect(html).toContain('<ul id="ticket-blocker-listbox" role="listbox"');
    const opts = [...html.matchAll(/<li role="option" id="ticket-blocker-opt-(\d+)"[^>]*data-id="(\w+)"/g)].map((m) => m[2]);
    expect(opts).toEqual(["o", "c", "z"]);                  // not a (itself), d (a blocker), l (waits on a) or g (waits on l); open ones first, a done one last
    expect(opts).not.toContain("l");
    expect(html).toContain("tickets that would make a loop are left out");
    delete els["ticket-view-content"].querySelector; unmount();
  });

  test("15.8 keyboard only: Up and Down move, Enter adds the highlighted ticket, Escape closes; Enter does not submit the form", async () => {
    await show(...chain());
    startEdit("a");
    const add: any = { handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { add.handlers[t] = fn; } };
    const search: any = { value: "", handlers: {} as Record<string, any>, setAttribute() {}, addEventListener(t: string, fn: any) { search.handlers[t] = fn; } };
    const pick = (sel: string) => (sel === "#ticket-blocker-add" ? add : sel === "#ticket-edit-blockers-search" ? search : null);
    els["ticket-view-content"].querySelector = pick;
    ctx.TicketBoard.openView("a");
    add.handlers.click();
    ctx.TicketBoard.openView("a");                                                      // the redraw wires the search
    const key = (k: string) => { const e: any = { key: k, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; search.handlers.keydown(e); return e; };
    const active = () => /ticket-blocker-opt-(\d+)"[^>]*aria-selected="true"/.exec(content())?.[1];
    expect(key("ArrowDown").prevented).toBe(true);
    expect(search.handlers.input).toBeDefined();
    const opts = () => [...content().matchAll(/class="ticket-blocker-opt( active)?" data-id="(\w+)"/g)];
    key("ArrowUp");                                                                      // wraps to the last option
    posts = [];
    const enter = key("Enter");
    expect(enter.prevented).toBe(true);                                                  // does not submit
    expect(enter.stopped).toBe(true);
    expect(posts).toEqual([]);
    expect(content()).toMatch(/data-ids="d,x,(o|c)"/);                                   // added: a new id at the end
    expect(els["ticket-view-save"].disabled).toBe(false);
    void active; void opts;
    // Escape closes the picker.
    add.handlers.click();
    ctx.TicketBoard.openView("a");
    const esc = key("Escape");
    expect(esc.prevented).toBe(true);
    expect(content()).not.toContain('role="combobox"');
    delete els["ticket-view-content"].querySelector; unmount();
  });

  test("15.8 typing in the search filters by code and title", async () => {
    await show(...chain());
    startEdit("a");
    const add: any = { handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { add.handlers[t] = fn; } };
    const listbox: any = { innerHTML: "", querySelectorAll: () => [] };
    const search: any = { value: "", handlers: {} as Record<string, any>, setAttribute() {}, addEventListener(t: string, fn: any) { search.handlers[t] = fn; } };
    els["ticket-view-content"].querySelector = (sel: string) => (sel === "#ticket-blocker-add" ? add : sel === "#ticket-edit-blockers-search" ? search : sel === "#ticket-blocker-listbox" ? listbox : null);
    ctx.TicketBoard.openView("a");
    add.handlers.click();
    ctx.TicketBoard.openView("a");
    search.value = "8.3"; search.handlers.input();
    expect([...listbox.innerHTML.matchAll(/data-id="(\w+)"/g)].map((m: any) => m[1])).toEqual(["o"]);
    search.value = "candid"; search.handlers.input();
    expect([...listbox.innerHTML.matchAll(/data-id="(\w+)"/g)].map((m: any) => m[1])).toEqual(["c"]);
    search.value = "zzz"; search.handlers.input();
    expect(listbox.innerHTML).toContain("No ticket matches");
    delete els["ticket-view-content"].querySelector; unmount();
  });

  test("15.8 Save sends the ids; a loop the hub refuses shows its message under the list", async () => {
    await show(...chain());
    const m = mount({ request: "", blockers: "" });
    els["ticket-edit-blockers"] = m.f.blockers;
    posts = [];
    startEdit("a");
    ctx.TicketBoard._commitBlockers(["d", "x", "c"]);
    refuseText = "blocker would create a cycle: c";
    failPath = "/tickets/a/edit";
    await m.submit();
    expect(posts[0].body).toEqual({ by: "human", blocked_by: ["d", "x", "c"] });
    expect(content()).toContain('id="ticket-edit-blockers-error" role="alert">Not saved: blocker would create a cycle: c</div>');
    expect(content().indexOf('id="ticket-edit-blockers-error"')).toBeGreaterThan(content().indexOf('id="ticket-blocker-add"'));   // under the list
    delete els["ticket-edit-blockers"]; failPath = null; unmount();
  });

  // ---- 15.10: files and notes ----
  test("15.10 a file row: a 44 px thumbnail or the extension, the name link, author and date, and 30 px icon buttons with aria-labels", async () => {
    attachmentsOnHub.a = [{ id: 1, author: "alice", name: "doc.pdf", url: "/image/d1.pdf", created_at_ms: 1791960000001 }];
    await show(mk("a", "in_progress", { attachments_count: 1 }));
    ctx.TicketBoard.openView("a"); await settle();
    const html = content();
    expect(html).toContain('<span class="ticket-attach-ext">PDF</span>');
    expect(html).toContain('class="ticket-attach-name"');
    expect(html).toContain('class="ticket-file-replace" data-ticket="a" data-attachment="1" aria-label="Replace doc.pdf"><svg');
    expect(html).toContain('class="ticket-file-remove" data-ticket="a" data-attachment="1" aria-label="Remove doc.pdf"><svg');
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toContain(".ticket-attach-thumb { width: 44px; height: 44px; }");
    expect(css).toMatch(/\.ticket-attach-actions button \{ width: 30px; height: 30px;/);
  });

  test("15.10 Remove keeps arm-then-confirm: the armed button shows Confirm remove next to the icon", async () => {
    attachmentsOnHub.a = [{ id: 1, author: "alice", name: "doc.pdf", url: "/image/d1.pdf", created_at_ms: 1791960000001 }];
    await show(mk("a", "in_progress", { attachments_count: 1 }));
    const btn: any = { dataset: { ticket: "a", attachment: "1" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-file-remove" ? [btn] : []);
    ctx.setTimeout = () => 1;
    ctx.TicketBoard.openView("a"); await settle();
    btn.handlers.click();
    expect(content()).toMatch(/class="ticket-file-remove armed"[^>]*aria-label="Confirm remove doc.pdf"><svg.*<span>Confirm remove<\/span>/s);
    ctx.setTimeout = setTimeout; delete els["ticket-view-content"].querySelectorAll;
  });

  test("15.10 the drop area says what it takes; browse opens the file picker; a file dropped on it is attached", async () => {
    const html = readFileSync("ui/index.html", "utf8");
    expect(html).toContain('Drop files here or <button type="button" class="ticket-browse" id="ticket-view-attach-btn">browse</button> &middot; pdf, md, txt, png, jpg &middot; up to 8 MB');
    expect(readFileSync("ui/styles/kinds.css", "utf8")).toContain(".ticket-view-attach { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: var(--sp-8); margin-top: var(--sp-8); padding: var(--sp-14, 14px) var(--sp-10, 10px); border: 1px dashed var(--line-hover);");
    await show(mk("a", "in_progress"));
    ctx.TicketBoard.openView("a");
    posts = []; uploads.length = 0;
    const over: any = { prevented: false, preventDefault() { this.prevented = true; } };
    els["ticket-view-drop"].handlers.dragover(over);
    expect(over.prevented).toBe(true);                                                     // the drop is allowed
    expect(els["ticket-view-drop"].cls.has("over")).toBe(true);
    await els["ticket-view-drop"].handlers.drop({ preventDefault() {}, dataTransfer: { files: [{ name: "dropped.pdf", size: 100 }] } });
    expect(uploads).toEqual(["dropped.pdf"]);
    expect(posts.map((p) => p.path)).toEqual(["/tickets/a/attachments"]);
    expect(els["ticket-view-attach-status"].textContent).toBe("File saved");
    expect(els["ticket-view-drop"].cls.has("over")).toBe(false);
  });

  test("15.10 a file dropped on a finished ticket is not attached", async () => {
    await show(mk("d", "done"));
    ctx.TicketBoard.openView("d");
    posts = []; uploads.length = 0;
    await els["ticket-view-drop"].handlers.drop({ preventDefault() {}, dataTransfer: { files: [{ name: "dropped.pdf", size: 100 }] } });
    expect(uploads).toEqual([]);
    expect(posts).toEqual([]);
  });

  test("15.10 notes: newest first, three show, 'Show all N notes' shows the rest; the author has a role class; no notes has its own text", async () => {
    const mkN = (id: number, author: string) => ({ id, author, text: `note ${id}`, created_at_ms: 1791960000000 + id });
    notesOnHub.a = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => mkN(i, i % 2 ? "Worker1" : "Tester2"));
    await show(mk("a", "in_review", { notes_count: 8 }), mk("e", "in_review"));
    const btn: any = { dataset: { ticket: "a" }, handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { btn.handlers[t] = fn; } };
    els["ticket-view-notes"].querySelectorAll = (sel: string) => (sel === ".ticket-notes-all" ? [btn] : []);
    ctx.TicketBoard.openView("a"); await settle();
    const html = () => els["ticket-view-notes"].innerHTML as string;
    expect((html().match(/ticket-note-text/g) ?? []).length).toBe(3);
    expect(html().indexOf("note 8")).toBeLessThan(html().indexOf("note 7"));                // newest first
    expect(html()).toContain("note 6");
    expect(html()).not.toContain("note 5");
    expect(html()).toContain('<span class="ticket-note-author note-role-worker">Worker1</span>');
    expect(html()).toContain('<span class="ticket-note-author note-role-tester">Tester2</span>');
    expect(html()).toContain(">Show all 8 notes</button>");
    btn.handlers.click();
    expect((html().match(/ticket-note-text/g) ?? []).length).toBe(8);
    expect(html()).not.toContain("Show all");
    els["ticket-view"].close();
    ctx.TicketBoard.openView("e");
    expect(html()).toContain("No notes yet. Agents add notes while they work on the ticket.");
    delete els["ticket-view-notes"].querySelectorAll;
  });

  test("15.10 the role colours are 30 % token tints mixed into --text", () => {
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    for (const [role, token] of [["worker", "amber"], ["tester", "green"], ["validator", "purple"], ["orchestrator", "blue"]]) {
      expect(css).toContain(`.ticket-note-author.note-role-${role} { color: color-mix(in srgb, var(--${token}) 30%, var(--text)); }`);
    }
    expect(css).toContain(".ticket-note-author { font-family: var(--mono); font-weight: 600; color: var(--text); }");
  });

  // ---- 15.13: the keyboard path of the blocker picker, and two focus rules ----
  const two = () => [
    mk("a", "draft", { title: "[code] 9.1 Main", blocked_by: ["d"], open_blockers: [] }),
    bt("d", "done", "[code] 8.2 Done blocker"),
    bt("o", "queued", "[code] 8.3 Other"),
  ];
  const rows = () => (content().match(/<li class="ticket-blocker-row/g) ?? []).length;
  const idsIn = () => /data-ids="([^"]*)"/.exec(content())?.[1] ?? "";
  // The fake page: the "Add blocker" button, the search box and the group hold the handlers a browser would call.
  function pickerPage() {
    const mkEl = (extra: object = {}) => { const e: any = { handlers: {} as Record<string, any>, value: "", setAttribute() {}, ...extra }; e.addEventListener = (t: string, fn: any) => { e.handlers[t] = fn; }; return e; };
    const add = mkEl(), search = mkEl(), group = mkEl(), rm: any[] = [];
    els["ticket-view-content"].querySelector = (sel: string) => (sel === "#ticket-blocker-add" ? add : sel === "#ticket-edit-blockers-search" ? search : sel === "#ticket-edit-blockers" ? group : null);
    els["ticket-view-content"].querySelectorAll = (sel: string) => (sel === ".ticket-blocker-remove" ? rm : []);
    const key = (k: string) => { const e: any = { key: k, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} }; search.handlers.keydown?.(e); return e; };
    return { add, search, group, rm, key, off: () => { delete els["ticket-view-content"].querySelector; delete els["ticket-view-content"].querySelectorAll; } };
  }

  test("15.13 keyboard add: Enter on Add blocker, type, ArrowDown, Enter: two rows, Save enabled, the count 1, Save sends both ids", async () => {
    await show(...two());
    const m = mount({ request: "", blockers: "" });
    posts = [];
    ctx.TicketBoard.openView("a");                                                       // a draft: edit mode
    expect(rows()).toBe(1);
    const p = pickerPage();
    ctx.TicketBoard.openView("a");                                                       // the redraw wires the button
    p.add.handlers.click();                                                              // Enter on the button is a click
    ctx.TicketBoard.openView("a");                                                       // the redraw wires the search
    p.search.value = "other"; p.search.handlers.input();                                 // typing
    expect(Object.keys(p.group.handlers)).toEqual([]);                                   // the group has no input/change listener: a bubbled keystroke cannot rewrite the list
    const down = p.key("ArrowDown");
    expect(down.prevented).toBe(true);
    p.key("Enter");
    expect(rows()).toBe(2);
    expect(idsIn()).toBe("d,o");
    expect(els["ticket-view-save"].disabled).toBe(false);
    expect(els["ticket-view-dirty"].textContent).toBe("1 unsaved change");
    await m.submit();
    expect(posts[0].body).toEqual({ by: "human", blocked_by: ["d", "o"] });              // the rows shown are the ids Save sends
    p.off(); unmount();
  });

  test("15.13 the mouse path gives the same state as the keyboard path", async () => {
    await show(...two());
    const m = mount({ request: "", blockers: "" });
    posts = [];
    ctx.TicketBoard.openView("a");
    ctx.TicketBoard._commitBlockers(["d", "o"]);                                         // what a mousedown on an option does
    expect(rows()).toBe(2);
    expect(idsIn()).toBe("d,o");
    expect(els["ticket-view-save"].disabled).toBe(false);
    expect(els["ticket-view-dirty"].textContent).toBe("1 unsaved change");
    await m.submit();
    expect(posts[0].body).toEqual({ by: "human", blocked_by: ["d", "o"] });
    unmount();
  });

  test("15.13 Remove on one of two rows removes only that row", async () => {
    await show(...two());
    ctx.TicketBoard.openView("a");
    ctx.TicketBoard._commitBlockers(["d", "o"]);
    expect(rows()).toBe(2);
    const p = pickerPage();
    const mkRm = (id: string) => { const b: any = { dataset: { id }, handlers: {} as Record<string, any> }; b.addEventListener = (t: string, fn: any) => { b.handlers[t] = fn; }; return b; };
    const rmO = mkRm("o"), rmD = mkRm("d");
    p.rm.push(rmD, rmO);
    ctx.TicketBoard.openView("a");                                                       // wires both buttons
    rmO.handlers.click();
    expect(rows()).toBe(1);
    expect(idsIn()).toBe("d");                                                           // "o" went, "d" stays
    expect(els["ticket-view-save"].disabled).toBe(true);                                 // back to the ticket's own list
    p.off();
  });

  test("15.13 Escape with unsaved changes shows the line and puts the focus on Keep editing, again after the event", async () => {
    await show(...two());
    const m = mount({ ...draftVals, title: "[code] 9.1 Main" });
    ctx.TicketBoard.openView("a");
    m.type("title", "changed");
    const keep: any = { id: "ticket-view-keep", handlers: {} as Record<string, any>, addEventListener(t: string, fn: any) { keep.handlers[t] = fn; }, focus() { active = this; } };
    els["ticket-view-notice"].querySelector = (sel: string) => (sel === "#ticket-view-keep" ? keep : null);
    const old = ctx.document.getElementById;
    ctx.document.getElementById = (id: string) => (id === "ticket-view-keep" ? keep : old(id));
    let later: any = null;
    ctx.setTimeout = (fn: any) => { later = fn; return 1; };
    let prevented = 0;
    els["ticket-view"].handlers.cancel({ preventDefault() { prevented++; } });           // Escape
    expect(prevented).toBe(1);
    expect(els["ticket-view-notice"].innerHTML).toContain("Unsaved changes");
    expect(active).toBe(keep);
    active = null;
    later();                                                                             // once the cancel event is over the browser may have moved it
    expect(active).toBe(keep);
    ctx.document.getElementById = old; ctx.setTimeout = setTimeout; unmount();
  });

  test("15.13 when the dialog opens the focus is on the header Close, the first control", async () => {
    await show(mk("a", "queued"));
    active = null;
    ctx.TicketBoard.openView("a");
    expect(active).toBe(els["ticket-view-x"]);
    const page = readFileSync("ui/index.html", "utf8");
    const dlg = page.slice(page.indexOf('id="ticket-view"'), page.indexOf("</dialog>", page.indexOf('id="ticket-view"')));
    expect(dlg.indexOf('id="ticket-view-x"')).toBeLessThan(dlg.indexOf('id="ticket-view-close"'));   // so the first Tab from it walks the dialog in order
  });

  test("9: the New ticket dialog has Request and Blocked by after External ref, and creates with them", async () => {
    const html = readFileSync("ui/index.html", "utf8");
    const at = (x: string) => html.indexOf(x);
    expect(at('id="ticket-f-ref"')).toBeLessThan(at('id="ticket-f-request"'));
    expect(at('id="ticket-f-request"')).toBeLessThan(at('id="ticket-f-blockers"'));
    expect(at('id="ticket-f-blockers"')).toBeLessThan(at('class="ticket-f-attach"'));
    const form = {
      title: { value: "T" }, criteria: { value: "c" }, radius: { value: "low" }, priority: { value: "medium" },
      external_ref: { value: "" }, request_id: { value: " r-1 " }, blocked_by: { value: "t_1, t_2 ," }, reset: () => {},
    };
    posts = [];
    ctx.TicketBoard.openNew("draft");
    await formSubmit!({ preventDefault: () => {}, target: form });
    expect(posts[0].body.request_id).toBe("r-1");
    expect(posts[0].body.blocked_by).toEqual(["t_1", "t_2"]);
    form.request_id.value = ""; form.blocked_by.value = "";
    posts = [];
    ctx.TicketBoard.openNew("draft");
    await formSubmit!({ preventDefault: () => {}, target: form });
    expect("request_id" in posts[0].body).toBe(false);
    expect("blocked_by" in posts[0].body).toBe(false);
  });

  test("every new control is native and labelled; the new texts carry a high-contrast class", async () => {
    await show(mk("a", "draft", { request_id: "r-1", blocked_by: ["b"], open_blockers: ["b"] }), mk("b", "queued"));
    // Draft "+": a native button with an accessible name.
    expect(cols.innerHTML).toContain('<button type="button" class="ticket-add" data-col="draft" aria-label="Add a ticket to Draft">+</button>');
    // The blocker line: an icon plus the words "Blocked by 1 open ticket", not colour alone.
    expect(card("a")).toContain("Blocked by 1 open ticket</div>");
    expect(card("a")).toContain('<span class="ticket-request-label">r-1</span>');
    ctx.TicketBoard.openView("a");
    const html = els["ticket-view-content"].innerHTML as string;
    // Dialog fields: each input sits inside its <label>; the submit is a real button (Enter submits, Space presses it).
    expect(els["ticket-view-actions"].innerHTML).toMatch(/<label for="ticket-edit-request">Request<\/label><\/dt><dd><input id="ticket-edit-request"/);
    expect(html).toContain('<button type="button" id="ticket-blocker-add" class="ticket-blocker-add" aria-expanded="false">+ Add blocker</button>');
    expect(els["ticket-view-save"].hidden).toBe(false);
    expect(html).toContain('ticket-view-h ticket-view-h-strong">Blocked by <span class="ticket-view-count">1 open</span>');
  });

  test("keyboard focus is visible in the ticket dialogs: a :focus-visible outline beats the global outline: none", () => {
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    const rule = (sel: string) => css.split("}").find((b) => b.includes(sel) && b.includes("outline: 2px solid"));
    for (const sel of ["#ticket-modal button:focus-visible", "#ticket-modal input:focus-visible", "#ticket-modal textarea:focus-visible",
      "#ticket-modal select:focus-visible", "#ticket-view button:focus-visible", "#ticket-view input:focus-visible",
      "#ticket-filters select:focus-visible", ".ticket-add:focus-visible"]) {
      expect([sel, !!rule(sel)]).toEqual([sel, true]);
    }
    // The buttons the human could not see (Attach files, Cancel, Save) are native, enabled, not tabindex -1 and not hidden.
    const html = readFileSync("ui/index.html", "utf8");
    const form = html.slice(html.indexOf('id="ticket-new-form"'), html.indexOf('id="ticket-view"'));
    for (const id of ['id="ticket-f-attach-btn"', 'id="ticket-modal-cancel"', '<button type="submit">Save</button>']) expect(form).toContain(id);
    expect(form).not.toMatch(/tabindex="-1"[^>]*(ticket-f-attach-btn|ticket-modal-cancel)/);
    expect(form).not.toContain("hidden />\n        <span class=\"ticket-f-attach-hint\"><");   // only the file input is hidden
  });

  test("3 and 4: Attach file sits under the Attachments list; the bottom row is Cancel ticket slot, Close, Save changes; primary look and dawn fill", () => {
    const html = readFileSync("ui/index.html", "utf8");
    const dlg = html.slice(html.indexOf('id="ticket-view"'), html.indexOf("</dialog>", html.indexOf('id="ticket-view"')));
    const at = (id: string) => dlg.indexOf(id);
    const order = [at('id="ticket-view-content"'), at('id="ticket-view-attach-btn"'), at('id="ticket-view-actions"'), at('id="ticket-view-notice"'),
      at('id="ticket-view-row-actions"'), at('id="ticket-view-close"'), at('id="ticket-view-save"')];
    expect(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1]))).toBe(true);
    const row = dlg.slice(at('id="ticket-view-bottom"'));
    expect(row).not.toContain("ticket-view-attach-btn");                        // not in the action row
    expect(row).toContain('type="submit" id="ticket-view-save" form="ticket-request-form" hidden disabled>Save changes</button>');
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toContain("#ticket-view-save:not([hidden]), .ticket-view-bottom:has(#ticket-view-save[hidden]) #ticket-view-close {\n  background: var(--orange); color: var(--bg-inset)");
    expect(css).toMatch(/\[data-theme="rose-pine-dawn"\][^{]*#ticket-view-save[^{]*\{ background: var\(--text\); color: var\(--bg-inset\)/);
    expect(css).toMatch(/\.ticket-cancel-btn \{[^}]*margin-right: auto;[^}]*border: 1px solid var\(--red\)/);   // left, apart, danger outline
  });

  test("the Request filter select has a label for it in the page", () => {
    const html = readFileSync("ui/index.html", "utf8");
    expect(html).toContain('<label class="ff-label" for="ticket-filter-request">Request</label>');
    expect(html).toContain('<select id="ticket-filter-request">');
  });

  test("a done ticket's dialog shows no edit form", async () => {
    await show(mk("a", "done", { request_id: "r-1" }));
    ctx.TicketBoard.openView("a");
    expect(els["ticket-view-content"].innerHTML).not.toContain("ticket-request-form");
    expect(els["ticket-view-actions"].innerHTML).toContain("r-1");                        // the Request row of the panel
  });
});
