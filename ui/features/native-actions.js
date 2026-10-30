// native-actions.js — the buttons that need the desktop shell: Open config, Open skills folder, Open MCP config, Reload.
// In the desktop window they call the shell's native commands. In a browser there is no shell: the UI shows the path
// (from GET /settings/paths) with a Copy button, and Reload shows the restart text. No Tauri command runs in a browser.

const RESTART_TEXT = 'Restart the hub to apply these settings';
const RESTART_COMMAND = 'PORT=<hub port> bun run hub/hub.ts';

const NATIVE_ACTIONS = {
  config: { cmd: 'open_config_file', key: 'config', title: 'Config file' },
  skills: { cmd: 'open_skills_folder', key: 'skills', title: 'Skills folder' },
  mcp: { cmd: 'open_global_mcp_config', key: 'mcp', title: 'Global MCP config' },
};

function hasTauri() {
  return !!(window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke);
}

// A hub read route as JSON; rejects with the hub's error text.
async function hubGet(path) {
  const r = await authedFetch(path);
  if (!r.ok) throw new Error(await parseErrorBody(r));
  return r.json();
}

const pathModal = document.getElementById('path-modal');
const pathTitle = document.getElementById('path-title');
const pathNote = document.getElementById('path-note');
const pathValue = document.getElementById('path-value');
const pathCopyBtn = document.getElementById('path-copy-btn');
const pathCloseBtn = document.getElementById('path-close-btn');
const pathCopiedStatus = document.getElementById('path-copied-status');

function showPathModal(title, note, value) {
  pathTitle.textContent = title;
  pathNote.textContent = note;
  pathValue.value = value;
  pathModal.classList.add('open');
  pathCopiedStatus.classList.remove('visible');
  pathValue.focus();
  pathValue.select();
}

function closePathModal() {
  pathModal.classList.remove('open');
}

// Rejects when the hub or the shell fails; the caller shows the error.
async function openNative(kind) {
  const a = NATIVE_ACTIONS[kind];
  if (hasTauri()) return tauriInvoke(a.cmd);
  const paths = await hubGet('/settings/paths');
  showPathModal(a.title, 'This browser cannot open the file. Copy the path.', paths[a.key]);
}

// Returns true when it handled the click (a browser); the desktop window keeps its own reload.
function reloadInBrowser() {
  if (hasTauri()) return false;
  showPathModal(RESTART_TEXT, 'Stop the running hub. Then run this command in the project folder.', RESTART_COMMAND);
  return true;
}

if (pathCloseBtn) pathCloseBtn.addEventListener('click', closePathModal);
if (pathModal) {
  pathModal.addEventListener('click', (e) => {
    if (e.target === pathModal) closePathModal();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pathModal?.classList.contains('open')) closePathModal();
});
if (pathCopyBtn) pathCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pathValue.value);
    pathCopiedStatus.classList.add('visible');
    setTimeout(() => pathCopiedStatus.classList.remove('visible'), 1500);
  } catch (e) {
    pathValue.select();
    document.execCommand?.('copy');
  }
});
