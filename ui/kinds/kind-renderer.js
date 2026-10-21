// Registry: per-Kind <script> files self-register via KindCardRenderer.register(...).
// Main.js consults the registry for SSE dispatch + replay-on-connect. Load BEFORE per-Kind files.

const KindCardRenderer = (() => {
  /** @type {{prefix:string,loadPath:string,toLoadEventShape:(s:any)=>any,render:(e:any)=>void}[]} */
  const adapters = [];

  function register(adapter) {
    if (
      typeof adapter !== 'object' ||
      adapter === null ||
      typeof adapter.prefix !== 'string' || !adapter.prefix.length ||
      typeof adapter.loadPath !== 'string' || !adapter.loadPath.length ||
      typeof adapter.toLoadEventShape !== 'function' ||
      typeof adapter.render !== 'function'
    ) {
      throw new Error(
        `KindCardRenderer.register: invalid adapter (expected {prefix, loadPath, toLoadEventShape, render}); got ${JSON.stringify(Object.keys(adapter ?? {}))}`,
      );
    }
    if (adapters.some((a) => a.prefix === adapter.prefix)) {
      throw new Error(`KindCardRenderer.register: prefix "${adapter.prefix}" already registered`);
    }
    adapters.push(adapter);
  }

  // Observers see every event of a prefix in addition to (or instead of) its card
  // adapter — e.g. the ticket board reads permission events without owning them.
  /** @type {{prefix:string, fn:(e:any)=>void}[]} */
  const observers = [];
  function observe(prefix, fn) { observers.push({ prefix, fn }); }

  function dispatch(kind, event) {
    if (typeof kind !== 'string') return false;
    let observed = false;
    for (const o of observers) {
      if (kind.startsWith(`${o.prefix}.`)) { o.fn(event); observed = true; }
    }
    for (const a of adapters) {
      if (kind.startsWith(`${a.prefix}.`)) {
        a.render(event);
        return true;
      }
    }
    return observed;
  }

  async function loadAllPending() {
    for (const a of adapters) {
      try {
        await loadPending(a.loadPath, a.toLoadEventShape, a.render);
      } catch (e) {
        console.warn(`[kind-renderer] loadPending ${a.loadPath} failed:`, e);
      }
    }
  }

  function _registeredPrefixes() {
    return adapters.map((a) => a.prefix).slice();
  }

  return { register, observe, dispatch, loadAllPending, _registeredPrefixes };
})();
