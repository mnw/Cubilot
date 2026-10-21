// mcp-modal.js — "How do I plug an external claude into this hub?" launch
// command modal. Opens via the title-bar reveal-btn (icon: file-with-fold).
// Tier 2 of index.html.
//
// Depends on (declared earlier):
//   from state.js — tauriInvoke
//
// Exposes:
//   openMcpModal, closeMcpModal, fallbackTemplate (rarely needed externally)

const mcpBtn = document.getElementById('reveal-btn');
const mcpModal = document.getElementById('mcp-modal');
const mcpTextarea = document.getElementById('mcp-textarea');
const mcpCopyBtn = document.getElementById('mcp-copy-btn');
const mcpCloseBtn = document.getElementById('mcp-close-btn');
const mcpCopiedStatus = document.getElementById('mcp-copied-status');

// The mod path is only known to the Rust shell, so the fallback keeps a placeholder.
function fallbackTemplate() {
  return "CHATBRIDGE_AGENT='agent' CHATBRIDGE_ROOM='default' claude --plugin-dir '<path to bundled chatbridge mod>'";
}

async function openMcpModal() {
  let text;
  try {
    text = await tauriInvoke('get_mcp_template');
  } catch {
    text = fallbackTemplate();
  }
  mcpTextarea.value = text;
  mcpModal.classList.add('open');
  mcpCopiedStatus.classList.remove('visible');
  mcpTextarea.focus();
  mcpTextarea.select();
}

function closeMcpModal() {
  mcpModal.classList.remove('open');
}

if (mcpBtn) mcpBtn.addEventListener('click', openMcpModal);
if (mcpCloseBtn) mcpCloseBtn.addEventListener('click', closeMcpModal);
if (mcpModal) {
  mcpModal.addEventListener('click', (e) => {
    if (e.target === mcpModal) closeMcpModal();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mcpModal?.classList.contains('open')) closeMcpModal();
});

if (mcpCopyBtn) mcpCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(mcpTextarea.value);
    mcpCopiedStatus.classList.add('visible');
    setTimeout(() => mcpCopiedStatus.classList.remove('visible'), 1500);
  } catch (e) {
    mcpTextarea.select();
    document.execCommand?.('copy');
  }
});
