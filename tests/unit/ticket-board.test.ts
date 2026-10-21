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
  els["ticket-view-title"] = control({ textContent: "" });
  els["ticket-view-content"] = control({ innerHTML: "" });
  els["ticket-view-actions"] = control({ innerHTML: "", queried: [] as string[], contains: () => false, querySelector: () => null,
    querySelectorAll(sel: string) { this.queried.push(sel); return []; } });
  els["ticket-view-close"] = control({ focus() { active = this; } });
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
    escHtml: String, escAttr: String, addMessage: (m: any) => messages.push(m), parseErrorBody: async () => "upload refused",
    IMAGE_EXT_RE: /\.(png|jpe?g|gif|webp)$/i,
    imgUrl: (u: string) => `http://hub${u}?token=T`,
    FormData: class { file: any; append(_k: string, v: any) { this.file = v; } },
    console,
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
        return { ok: postOk && _path !== failPath, json: async () => (_path === "/tickets" ? { snapshot: { id: "t_new" } } : {}) };
      }
      const attachRoute = /^\/tickets\/([^/]+)\/attachments$/.exec(_path);
      if (attachRoute) {
        attachFetches.push(decodeURIComponent(attachRoute[1]));
        return { ok: true, json: async () => attachmentsOnHub[decodeURIComponent(attachRoute[1])] ?? [] };
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
    for (const [col, status] of [["queued", "queued"], ["progress", "in_progress"], ["review", "in_review"], ["done", "done"]]) {
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
    for (const col of ["queued", "progress", "review", "done"]) {
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
    for (const [col, status] of [["queued", "queued"], ["progress", "in_progress"], ["review", "in_review"], ["done", "done"]]) {
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
    expect(counts()).toEqual([["Queued", 3], ["In progress", 1], ["In review", 1], ["Done", 1]]);
    expect(els["ticket-filter-summary"].textContent).toBe("");
  });

  test("matchesFilter: radius and priority combine; an unknown priority is medium", () => {
    const m = ctx.TicketBoard.matchesFilter;
    const f = (radius: string, priorities: string[]) => ({ radius, priorities });
    expect(m(mk("x", "queued", "high", "high"), f("high", all5))).toBe(true);
    expect(m(mk("x", "queued", "low", "high"), f("high", all5))).toBe(false);
    expect(m(mk("x", "queued", "low", "high"), f("all", ["medium"]))).toBe(false);
    expect(m(mk("x", "queued", "low", "high"), f("all", ["high", "low"]))).toBe(true);
    expect(m(mk("x", "queued", "low", "constructor"), f("all", ["medium"]))).toBe(true);
    expect(m(mk("x", "queued", "low", 3), f("all", ["medium"]))).toBe(true);
    expect(m(mk("x", "queued", "low", "high"), f("all", []))).toBe(false);
  });

  test("the radius filter applies to every column and to the counts", async () => {
    await show(...board());
    ctx.TicketBoard.setFilter({ radius: "high", priorities: all5 });
    expect(counts()).toEqual([["Queued", 1], ["In progress", 1], ["In review", 0], ["Done", 1]]);
    expect(titles().sort()).toEqual(["b", "c", "e"]);
    ctx.TicketBoard.setFilter({ radius: "low", priorities: all5 });
    expect(counts()).toEqual([["Queued", 2], ["In progress", 0], ["In review", 1], ["Done", 0]]);
  });

  test("the priority filter takes any mix of levels and applies to the counts", async () => {
    await show(...board());
    ctx.TicketBoard.setFilter({ radius: "all", priorities: ["highest", "lowest"] });
    expect(titles().sort()).toEqual(["a", "d"]);
    expect(counts()).toEqual([["Queued", 1], ["In progress", 0], ["In review", 1], ["Done", 0]]);
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
    expect(ctx.TicketBoard._filter()).toEqual({ radius: "all", priorities: all5, showArchived: false, showCancelled: false });
    expect(radio()).toBe("all");
  });

  test("the choice is saved per room and restored on the room's return", async () => {
    await show(...board());
    ctx.TicketBoard.setFilter({ radius: "high", priorities: ["low"] });
    expect(JSON.parse(store.get("cubilot_board_filter:r")!)).toEqual({ radius: "high", priorities: ["low"], showArchived: false, showCancelled: false });
    ctx.SELECTED_ROOM = "r2";
    await ctx.TicketBoard.load();
    expect(ctx.TicketBoard._filter()).toEqual({ radius: "all", priorities: all5, showArchived: false, showCancelled: false });   // another room starts clean
    ctx.TicketBoard.setFilter({ radius: "low", priorities: all5 });
    ctx.SELECTED_ROOM = "r";
    await ctx.TicketBoard.load();
    expect(ctx.TicketBoard._filter()).toEqual({ radius: "high", priorities: ["low"], showArchived: false, showCancelled: false });
    expect(radio()).toBe("high");                                      // the controls follow the room
    expect(JSON.parse(store.get("cubilot_board_filter:r2")!)).toEqual({ radius: "low", priorities: all5, showArchived: false, showCancelled: false });
  });

  test("damaged storage falls back to no filter; unknown values are dropped", () => {
    store.set("cubilot_board_filter:r", "{not json");
    expect(ctx.TicketBoard.readFilter("r")).toEqual({ radius: "all", priorities: all5, showArchived: false, showCancelled: false });
    store.set("cubilot_board_filter:r", JSON.stringify({ radius: "extreme", priorities: ["high", "bogus", "constructor"] }));
    expect(ctx.TicketBoard.readFilter("r")).toEqual({ radius: "all", priorities: ["high"], showArchived: false, showCancelled: false });
    store.set("cubilot_board_filter:r", JSON.stringify({ radius: "low", priorities: "high" }));
    expect(ctx.TicketBoard.readFilter("r")).toEqual({ radius: "low", priorities: all5, showArchived: false, showCancelled: false });
    expect(ctx.TicketBoard.sanitizeFilter(null)).toEqual({ radius: "all", priorities: all5, showArchived: false, showCancelled: false });
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
    expect(cols.innerHTML).toContain("ticket-card radius-low status-done archived");
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

  test("the board has four columns; Cancelled appears only with Show cancelled, and has no +", async () => {
    await show(mk("q", "queued"), mk("c", "cancelled"));
    expect(headers()).toEqual(["Queued", "In progress", "In review", "Done"]);
    expect(titles()).toEqual(["q"]);                                            // the cancelled ticket is hidden
    set({ showCancelled: true });
    expect(headers()).toEqual(["Queued", "In progress", "In review", "Done", "Cancelled"]);
    expect(titles()).toEqual(["c", "q"]);
    expect((cols.innerHTML.match(/class="ticket-add"/g) ?? []).length).toBe(4);      // none on Cancelled
    await show(mk("q", "queued"));                                              // shown even with no cancelled ticket
    expect(headers().at(-1)).toBe("Cancelled");
    set({ showCancelled: false });
    expect(headers()).toEqual(["Queued", "In progress", "In review", "Done"]);
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
  test("a card is focusable, has a role and an accessible name", async () => {
    await board(T());
    expect(cols.innerHTML).toContain('role="button" tabindex="0" draggable="true" data-ticket="t_9" aria-label="Open ticket: Fix <it>"');
  });

  test("a click on the card opens the dialog with the whole ticket", async () => {
    const cards = await board(T({ blast_radius: "high", approval_request_id: "abcde", approval: { id: "abcde", status: "pending", resolved_by: null, version: 1 } }));
    click(cards.t_9);
    expect(view().open).toBe(true);
    expect(els["ticket-view-title"].textContent).toBe("Fix <it>");
    for (const text of ["t_9", "AUDIT-9", "in_progress", "High", "high", "human", "alice", "Created", "Updated", "line one<br>line two <b>"]) {
      expect(content()).toContain(text);
    }
    expect(content()).toContain("Acceptance criteria");
    expect(content()).toContain("waiting for your approval");              // the approval state
    expect(active).toBe(els["ticket-view-close"]);                         // focus moves into the dialog
  });

  test("an unassigned ticket says so; an archived one shows when", async () => {
    const cards = await board(T({ assignee: null, external_ref: null, archived_at_ms: 1791962000000 }));
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), showArchived: true });
    await settle();
    click(cards.t_9);
    expect(content()).toContain("unassigned");
    expect(content()).toContain("—");
    expect(content()).toContain("Archived");
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
    const html = els["ticket-view-actions"].innerHTML as string;
    expect(html).toContain('class="ticket-archive" data-ticket="t_9" data-archive="true">Archive</button>');
    expect(html).not.toContain('data-to=');                                // done: no moves
    expect(html).not.toContain("ticket-move");
    view().close();
    click(cards.t_8);
    const html2 = els["ticket-view-actions"].innerHTML as string;
    expect(html2).toContain('class="ticket-move" data-ticket="t_8" data-current="in_progress"');
    expect(html2).not.toContain("To review");
    expect(html2).toContain('data-to="cancelled">Cancel</button>');
    expect(html2).toContain('class="ticket-assign" data-ticket="t_8"');
  });

  test("the dialog's buttons are wired like the card's", async () => {
    const cards = await board(T());
    const move: any = { dataset: { ticket: "t_9", to: "in_review" }, handlers: {} };
    move.addEventListener = (type: string, fn: () => unknown) => { move.handlers[type] = fn; };
    actions().querySelectorAll = (sel: string) => { actions().queried.push(sel); return sel === ".ticket-actions button[data-to]" ? [move] : []; };
    click(cards.t_9);
    expect(actions().queried).toEqual(expect.arrayContaining([".ticket-assign", ".ticket-archive", ".ticket-actions button[data-to]"]));
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
    expect(content()).toContain("in_review");
    expect(content()).toContain("bob");
    expect(view().open).toBe(true);
  });

  test("an approval verdict updates the open dialog", async () => {
    const cards = await board(T({ blast_radius: "high", approval_request_id: "abcde", approval: { id: "abcde", status: "pending", resolved_by: null, version: 1 } }));
    click(cards.t_9);
    expect(content()).toContain("waiting for your approval");
    observers.permission({ kind: "permission.resolved", permission_id: "abcde", version: 9, snapshot: { id: "abcde", tool_name: "ticket:done", input_preview: JSON.stringify({ ticket_id: "t_9" }), status: "allowed", resolved_by: "human", version: 9 } });
    expect(content()).toContain("approved");
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
  const detailsOf = () => cols.innerHTML.match(/<details class="ticket-notes"[^>]*>.*?<\/details>/s)?.[0] ?? "";
  async function show(...tickets: any[]) {
    list = tickets;
    ctx.TicketBoard._tickets.clear();
    await ctx.TicketBoard.load();
  }
  function fakeDetails(id: string, open = false) {
    const d: any = { dataset: { ticket: id }, open, handlers: {} as Record<string, () => void> };
    d.addEventListener = (type: string, fn: () => void) => { d.handlers[type] = fn; };
    return d;
  }
  async function expand(d: any) {
    d.open = true;
    d.handlers.toggle();
    await settle();
  }
  const withDetails = (...ds: any[]) => { cols.querySelectorAll = (q: string) => (q === ".ticket-notes" ? ds : []); };

  test("a card shows a collapsed Notes (N) section; a ticket with no notes shows none", async () => {
    await show(T("a", 2), T("b", 0));
    expect(detailsOf()).toContain("<summary>Notes (2)</summary>");
    expect(detailsOf()).not.toMatch(/<details class="ticket-notes"[^>]* open/);
    expect(cols.innerHTML.match(/class="ticket-notes"/g)?.length).toBe(1);        // b has none
  });

  test("expanding reads the notes once and shows author, time and text", async () => {
    notesOnHub.a = [N(1, "alice", "Built in a.ts"), N(2, "bob", "Tested: 5 pass")];
    const d = fakeDetails("a");
    withDetails(d);
    await show(T("a", 2));
    expect(notesFetches).toEqual([]);                                             // nothing is read until it is opened
    await expand(d);
    expect(notesFetches).toEqual(["a"]);
    const html = detailsOf();
    for (const text of ["alice", "Built in a.ts", "bob", "Tested: 5 pass", "<time>"]) expect(html).toContain(text);
    d.open = false; d.handlers.toggle();
    await expand(d);
    expect(notesFetches).toEqual(["a"]);                                          // cached: no second read
  });

  test("the expanded state survives a redraw", async () => {
    notesOnHub.a = [N(1, "alice", "x")];
    const d = fakeDetails("a");
    withDetails(d);
    await show(T("a", 1));
    await expand(d);
    ctx.TicketBoard.setFilter(ctx.TicketBoard._filter());                          // any redraw
    expect(detailsOf()).toMatch(/<details class="ticket-notes"[^>]* open>/);
    d.open = false; d.handlers.toggle();
    ctx.TicketBoard.setFilter(ctx.TicketBoard._filter());
    expect(detailsOf()).not.toMatch(/<details class="ticket-notes"[^>]* open/);
  });

  test("a live note is added to a list that is already read, once, and the count follows", async () => {
    notesOnHub.a = [N(1, "alice", "first")];
    const d = fakeDetails("a");
    withDetails(d);
    await show(T("a", 1));
    await expand(d);
    const live = { kind: "ticket.noted", ticket_id: "a", room: "r", notes_count: 2, note: N(2, "alice", "second") };
    observers.ticket(live);
    observers.ticket(live);                                                         // a repeat adds nothing
    expect(detailsOf()).toContain("Notes (2)");
    expect(detailsOf()).toContain("second");
    expect((detailsOf().match(/ticket-note-text/g) ?? []).length).toBe(2);
    expect(notesFetches).toEqual(["a"]);                                            // no re-read needed
  });

  test("a live note for a list not read yet only moves the count", async () => {
    await show(T("a", 1));
    observers.ticket({ kind: "ticket.noted", ticket_id: "a", room: "r", notes_count: 2, note: N(2, "alice", "second") });
    expect(detailsOf()).toContain("Notes (2)");
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
    expect(detailsOf()).toContain("Notes (1)");
    expect(ctx.TicketBoard._tickets.has("ghost")).toBe(false);
  });

  test("a move that carried a note (ticket.update with a higher notes_count) refreshes an open list", async () => {
    notesOnHub.a = [N(1, "alice", "first")];
    const d = fakeDetails("a");
    withDetails(d);
    await show(T("a", 1, { version: 5 }));
    await expand(d);
    notesOnHub.a = [N(1, "alice", "first"), N(2, "alice", "Built X. Tested Y.")];
    observers.ticket({ kind: "ticket.update", ticket_id: "a", version: 6, notes_count: 2, snapshot: T("a", 0, { version: 6 }) });
    await settle();
    expect(notesFetches).toEqual(["a", "a"]);
    expect(detailsOf()).toContain("Built X. Tested Y.");
    expect(detailsOf()).toContain("Notes (2)");
  });

  test("an update without notes_count keeps the known count", async () => {
    await show(T("a", 3, { version: 5 }));
    observers.ticket({ kind: "ticket.update", ticket_id: "a", version: 6, snapshot: { ...T("a", 0), notes_count: undefined, version: 6, title: "renamed" } });
    expect(detailsOf()).toContain("Notes (3)");
  });

  test("the list read carries notes_count into the card", async () => {
    await show(T("a", 4));
    expect(detailsOf()).toContain("Notes (4)");
  });

  test("author and text are escaped", async () => {
    ctx.escHtml = (s: unknown) => String(s).replace(/</g, "&lt;");
    notesOnHub.a = [N(1, "<b>al", "<script>x</script>")];
    const d = fakeDetails("a");
    withDetails(d);
    await show(T("a", 1));
    await expand(d);
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
    const content = () => els["ticket-view-content"].innerHTML as string;
    expect(notesFetches).toEqual(["a"]);
    expect(content()).toContain("Notes (1)");
    expect(content()).toContain("Built in a.ts");
    observers.ticket({ kind: "ticket.noted", ticket_id: "a", room: "r", notes_count: 2, note: N(2, "alice", "Tested: ok") });
    expect(content()).toContain("Notes (2)");
    expect(content()).toContain("Tested: ok");
  });

  test("the full view says so when there are no notes", async () => {
    const card: any = { dataset: { ticket: "a" }, isConnected: true, handlers: {}, addEventListener(t: string, f: any) { this.handlers[t] = f; }, focus() {} };
    cols.querySelectorAll = (q: string) => (q === ".ticket-card" ? [card] : []);
    await show(T("a", 0));
    card.handlers.click({ target: { closest: () => null } });
    expect(els["ticket-view-content"].innerHTML).toContain("Notes (0)");
    expect(els["ticket-view-content"].innerHTML).toContain("No notes");
    expect(notesFetches).toEqual([]);
  });

  test("a room change forgets the notes and the expanded state", async () => {
    notesOnHub.a = [N(1, "alice", "x")];
    const d = fakeDetails("a");
    withDetails(d);
    await show(T("a", 1));
    await expand(d);
    ctx.SELECTED_ROOM = "r2";
    list = [T("a", 1, { room: "r2" })];
    await ctx.TicketBoard.load();
    expect(detailsOf()).not.toMatch(/<details class="ticket-notes"[^>]* open/);
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
  const viewHtml = () => els["ticket-view-content"].innerHTML as string;
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
    expect(viewHtml().indexOf("old note")).toBeLessThan(viewHtml().indexOf("live new note"));   // oldest first
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
    els["ticket-view-content"].querySelectorAll = (q: string) => (q === ".ticket-notes-retry" ? [retry] : []);
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
    expect(row).not.toContain("<select");                                          // the radius select is gone
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
  const view = () => els["ticket-view-content"].innerHTML as string;
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
    expect(els["ticket-view-attach-status"].textContent).toBe("Attached 2 files");
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
    expect(view()).toContain("Attachments (2)");
    expect(view()).toContain('href="http://hub/image/x1.pdf?token=T"');
    for (const x of ["report.pdf", "notes.md", "alice", "bob", "<time", ">PDF<", ">MD<"].filter((v) => v !== "<time")) expect(view()).toContain(x);
    ctx.TicketBoard.closeView();
    open("b");
    expect(view()).toContain("Attachments (0)");
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
    ctx.escAttr = (x: unknown) => String(x).replace(/"/g, "&quot;");
    attachmentsOnHub.a = [A(1, '<img onerror=x>"q".pdf', "/image/e1.pdf", "<b>me")];
    await show(T("a", 1));
    open("a");
    await settle();
    expect(view()).toContain("&lt;img onerror=x>");
    expect(view()).toContain("&lt;b>me");
    expect(view()).not.toContain("<img onerror");
  });

  test("a live ticket.attached entry is merged into a list already read, once, and the count follows", async () => {
    attachmentsOnHub.a = [A(1, "first.pdf", "/image/l1.pdf")];
    await show(T("a", 1));
    open("a");
    await settle();
    const live = { kind: "ticket.attached", ticket_id: "a", room: "r", attachments_count: 2, attachment: A(2, "second.md", "/image/l2.md") };
    observers.ticket(live);
    observers.ticket(live);
    expect(view()).toContain("Attachments (2)");
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

  test("the count only grows: an older entry, a late list and a ticket.update cannot lower it", async () => {
    await show(T("a", 1));
    for (const n of [3, 2, 1]) observers.ticket({ kind: "ticket.attached", ticket_id: "a", room: "r", attachments_count: n, attachment: A(10 + n, `n${n}.pdf`, `/image/n${n}.pdf`) });
    expect(ctx.TicketBoard._tickets.get("a").attachments_count).toBe(3);
    list = [T("a", 1)];
    await ctx.TicketBoard.load();                                                 // a list read at count 1
    expect(ctx.TicketBoard._tickets.get("a").attachments_count).toBe(3);
    observers.ticket({ kind: "ticket.update", ticket_id: "a", version: 99, snapshot: { ...T("a", 0), version: 99 } });
    expect(ctx.TicketBoard._tickets.get("a").attachments_count).toBe(3);
  });

  test("a read that answers after a live attachment merges and keeps it", async () => {
    await show(T("a", 1));
    let finish!: (r: any) => void;
    const normal = ctx.authedFetch;
    ctx.authedFetch = (path: string, init?: any) => (path.endsWith("/attachments") && !init ? new Promise((r) => { finish = r; }) : normal(path, init));
    open("a");
    observers.ticket({ kind: "ticket.attached", ticket_id: "a", room: "r", attachments_count: 2, attachment: A(7, "live.pdf", "/image/live.pdf") });
    finish({ ok: true, json: async () => [A(6, "old.pdf", "/image/old.pdf")] });
    await settle();
    expect(view()).toContain("live.pdf");
    expect(view()).toContain("old.pdf");
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

    test("the card renders the criteria as Markdown inside its details", async () => {
      ctx.escHtml = real;
      await show(T("- [ ] one\n- **two**"));
      expect(cols.innerHTML).toContain('<details class="ticket-criteria"><summary>Acceptance criteria</summary><div class="md"><ul class="md-checklist">');
      expect(cols.innerHTML).toContain("<strong>two</strong>");
    });

    test("the card escapes hostile criteria", async () => {
      ctx.escHtml = real;
      await show(T('<img src=x onerror=alert(1)> **b**'));
      expect(cols.innerHTML).not.toContain("<img");
      expect(cols.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt; <strong>b</strong>");
    });

    test("the full view renders it too", async () => {
      ctx.escHtml = real;
      await show(T("run `bun test`\n\n- a"));
      ctx.TicketBoard.openView("t_md");
      const html = els["ticket-view-content"].innerHTML as string;
      expect(html).toContain('<div class="ticket-view-criteria md"><p>run <code>bun test</code></p><ul class="md-list"><li>a</li></ul></div>');
    });

    test("plain criteria (no Markdown) still read as before, line breaks kept", async () => {
      ctx.escHtml = real;
      await show(T("line one\nline two"));
      expect(cols.innerHTML).toContain("<p>line one<br>line two</p>");
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

  test("an open card has a Move to select with the four columns; its own column is shown and disabled", async () => {
    await show(T("a", "queued"), T("b", "claimed"), T("c", "in_review"));
    expect(optionsOf("a")).toEqual([["queued", "Queued", true], ["in_progress", "In progress", false], ["in_review", "In review", false], ["done", "Done", false]]);
    expect(optionsOf("b")!.map((o) => o[2])).toEqual([false, true, false, false]);   // claimed sits in In progress
    expect(optionsOf("c")!.map((o) => o[2])).toEqual([false, false, true, false]);
    expect(cols.innerHTML).toContain("Move to");
  });

  test("Move to and Assignee share one fields row, Move to first, with their aria-labels", async () => {
    await show(T("a", "queued"));
    const m = /<div class="ticket-fields">(.*?)<\/div>/s.exec(cols.innerHTML);
    expect(m).not.toBeNull();
    const row = m![1];
    expect(row.indexOf("ticket-move-label")).toBeGreaterThanOrEqual(0);
    expect(row.indexOf("ticket-move-label")).toBeLessThan(row.indexOf("ticket-assign-label"));
    expect(row).toContain('aria-label="Move T a to column"');
    expect(row).toContain('aria-label="Assignee of T a"');
  });

  test("done and cancelled cards have no select and are not draggable; the per-status move buttons are gone", async () => {
    ctx.TicketBoard.setFilter({ ...ctx.TicketBoard._filter(), showCancelled: true });
    await show(T("d", "done"), T("x", "cancelled"), T("q", "queued"));
    expect(optionsOf("d")).toBeNull();
    expect(optionsOf("x")).toBeNull();
    expect(cols.innerHTML.match(/draggable="true"/g)?.length).toBe(1);
    for (const gone of ["Claim<", "Start<", "To review<", "Rework<"]) expect(cols.innerHTML).not.toContain(gone);
    expect(cols.innerHTML).toContain('data-to="cancelled">Cancel</button>');
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
    expect(optionsOf("a")!.map((o) => o[2])).toEqual([false, true, false, false]);
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
