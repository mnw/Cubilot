// The dark role listbox of the spawn modal (task 5.7): ui/terminal/role-list.js in a vm with a tiny fake DOM.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

class El {
  children: El[] = []; dataset: Record<string, string> = {}; attrs: Record<string, string> = {};
  listeners: Record<string, Function[]> = {}; classes = new Set<string>(); value = ""; _text = ""; selectedIndex = 0; options: El[] = [];
  parent: El | null = null; label: El | null = null;
  constructor(public tag = "div") {}
  get className() { return [...this.classes].join(" "); }
  set className(v: string) { this.classes = new Set(v.split(/\s+/).filter(Boolean)); }
  get classList() {
    const c = this.classes;
    return { add: (n: string) => c.add(n), remove: (n: string) => c.delete(n), contains: (n: string) => c.has(n), toggle: (n: string, on: boolean) => (on ? c.add(n) : c.delete(n)) };
  }
  set textContent(v: string) { this._text = v; if (v === "") this.children = []; }
  get textContent() { return this._text; }
  append(...k: El[]) { for (const c of k) { c.parent = this; this.children.push(c); } }
  contains(n: any): boolean { return n === this || this.children.some((c) => c.contains(n)); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  querySelector(_s: string) { return this.label; }
  addEventListener(t: string, f: Function) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  dispatchEvent(e: any) { for (const f of this.listeners[e.type] || []) f({ target: this, ...e }); }
  key(k: string) { const e: any = { key: k, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }; for (const f of this.listeners.keydown || []) f(e); return e; }
  click() { for (const f of this.listeners.click || []) f({ target: this, stopPropagation() {} }); }
}
class Sel extends El {
  get selectedOptions() { return [this.options[this.selectedIndex]]; }
  add(o: El) { this.options.push(o); }
  setValue(v: string) { this.value = v; this.selectedIndex = Math.max(0, this.options.findIndex((o) => o.value === v)); }
}

function setup() {
  const win: any = {};
  const docListeners: Record<string, Function[]> = {};
  const doc = { createElement: (t: string) => new El(t), addEventListener: (t: string, f: Function) => (docListeners[t] = docListeners[t] || []).push(f) };
  const Ev = class { constructor(public type: string) {} };
  new Function("window", "Event", readFileSync("ui/terminal/role-list.js", "utf8"))(win, Ev);
  const select = new Sel("select");
  // value is assigned like a real select: setting .value moves selectedIndex
  Object.defineProperty(select, "value", { get() { return this._v ?? ""; }, set(v) { this._v = v; this.selectedIndex = Math.max(0, this.options.findIndex((o: El) => o.value === v)); } });
  select.dispatchEvent = (e: any) => { for (const f of select.listeners[e.type] || []) f(e); };
  const mk = (label: string, value: string) => { const o = new El("option"); o._text = label; o.value = value; select.add(o); };
  mk("None", ""); mk("worker", "worker"); mk("validator", "validator");
  const button = new El("button"); button.label = new El("span");
  const menu = new El();
  const api = win.__CUBILOT_TERM__.roleList.attach({ select, button, menu, doc });
  const changes: string[] = [];
  select.addEventListener("change", () => changes.push(select.value));
  return { select, button, menu, api, changes, docClick: (target: any) => (docListeners.click || []).forEach((f) => f({ target })) };
}

describe("role listbox", () => {
  test("options are None plus the role names, nothing else", () => {
    const { menu, button } = setup();
    expect(menu.children.map((c) => c.children[0]._text)).toEqual(["None", "worker", "validator"]);
    expect(button.label!._text).toBe("None");
  });

  test("keyboard: ArrowDown opens, arrows move, Enter sets the select value and fires change", () => {
    const { select, button, menu, changes } = setup();
    button.key("ArrowDown");
    expect(menu.classList.contains("open")).toBe(true);
    expect(button.attrs["aria-expanded"]).toBe("true");
    button.key("ArrowDown");
    button.key("ArrowDown");   // None -> worker -> validator
    button.key("Enter");
    expect(select.value).toBe("validator");
    expect(changes).toEqual(["validator"]);
    expect(button.label!._text).toBe("validator");
    expect(menu.classList.contains("open")).toBe(false);
    expect(menu.children[2].children[1]._text).toBe("✓");   // check mark on the selected item
  });

  test("Esc closes without a change and stops the event; picking the same value fires nothing", () => {
    const { select, button, menu, changes } = setup();
    button.click();
    expect(menu.classList.contains("open")).toBe(true);
    const e = button.key("Escape");
    expect(e.stopped).toBe(true);
    expect(menu.classList.contains("open")).toBe(false);
    expect(select.value).toBe("");
    button.click();
    button.key("Enter");   // active item is the current one (None)
    expect(changes).toEqual([]);
  });

  test("click picks an item; click outside closes; sync follows a programmatic value", () => {
    const { select, button, menu, changes, docClick, api } = setup();
    button.click();
    menu.children[1].click();
    expect(select.value).toBe("worker");
    expect(changes).toEqual(["worker"]);
    button.click();
    docClick(new El());
    expect(menu.classList.contains("open")).toBe(false);
    select.value = "validator";
    api.sync();
    expect(button.label!._text).toBe("validator");
  });
});
