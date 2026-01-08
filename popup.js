// Popup controller for WhatsApp Bulk Messenger (background-driven)

// Global state
let contacts = [];
let campaignRunning = false;
let campaignPaused = false;
let campaignStats = { total: 0, sent: 0, failed: 0, pending: 0 };
let waTabId = null;
let campaignPort = null;
let currentCampaignId = null;

// DOM Elements
const csvFile = document.getElementById('csvFile');
const uploadBtn = document.getElementById('uploadBtn');
const fileStatus = document.getElementById('fileStatus');
const previewSection = document.getElementById('previewSection');
const campaignSection = document.getElementById('campaignSection');
const verificationSection = document.getElementById('verificationSection');
const contactsList = document.getElementById('contactsList');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const proceedBtn = document.getElementById('proceedBtn');
const campaignLog = document.getElementById('campaignLog');
const campaignWarning = document.getElementById('campaignWarning');

// Wire up UI
uploadBtn?.addEventListener('click', handleCSVUpload);
startBtn?.addEventListener('click', startCampaign);
pauseBtn?.addEventListener('click', pauseCampaign);
stopBtn?.addEventListener('click', stopCampaign);
resetBtn?.addEventListener('click', resetCampaign);
proceedBtn?.addEventListener('click', () => {
  verificationSection.style.display = 'none';
  campaignSection.style.display = 'block';
  campaignWarning.style.display = 'block';
  startBtn.disabled = false;
});

// Verification checkboxes - enable Proceed only when all are checked and contacts loaded
const checkWhatsApp = document.getElementById('checkWhatsApp');
const checkLogin = document.getElementById('checkLogin');
const checkConsent = document.getElementById('checkConsent');
const checkAbuse = document.getElementById('checkAbuse');

function updateProceedButton() {
  try {
    const allChecked = !!(checkWhatsApp?.checked && checkLogin?.checked && checkConsent?.checked && checkAbuse?.checked);
    proceedBtn.disabled = !(allChecked && contacts.length > 0);
  } catch (e) { proceedBtn.disabled = true; }
}

[checkWhatsApp, checkLogin, checkConsent, checkAbuse].forEach(chk => {
  if (chk) chk.addEventListener('change', updateProceedButton);
});

// Helpers
function showStatus(msg, type) {
  if (fileStatus) { fileStatus.textContent = msg; fileStatus.className = `status-message ${type}`; }
}

function logMessage(msg, type = 'info') {
  if (!campaignLog) return;
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="log-time">[${time}]</span> ${msg}`;
  campaignLog.appendChild(entry);
  campaignLog.scrollTop = campaignLog.scrollHeight;
}

function updateStats() {
  try {
    document.getElementById('totalCount').textContent = contacts.length;
    document.getElementById('sentCount').textContent = campaignStats.sent;
    document.getElementById('pendingCount').textContent = contacts.length - campaignStats.sent - campaignStats.failed;
    document.getElementById('failedCount').textContent = campaignStats.failed;
    const percent = contacts.length > 0 ? Math.round((campaignStats.sent / contacts.length) * 100) : 0;
    document.getElementById('progressPercent').textContent = percent + '%';
    document.getElementById('progressBar').style.width = percent + '%';
  } catch (e) {}
}

// CSV handling
function handleCSVUpload() {
  const inputEl = document.getElementById('csvFile');
  const file = inputEl?.files?.[0];
  if (!(file instanceof Blob)) { showStatus('Please choose a CSV file first (then click Upload).', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const csv = e.target.result;
      contacts = parseCSV(csv);
      if (contacts.length === 0) { showStatus('No valid contacts found in CSV', 'error'); return; }
      showStatus(`✅ ${contacts.length} contacts loaded successfully`, 'success');
      displayContacts();
      previewSection.style.display = 'block'; verificationSection.style.display = 'block'; campaignSection.style.display = 'none';
      inputEl.value = '';
      campaignStats = { total: contacts.length, sent: 0, failed: 0, pending: contacts.length };
      updateStats();
    } catch (err) { showStatus(`Error parsing CSV: ${err.message}`, 'error'); }
  };
  reader.readAsText(file);
}

function parseCSV(csv) {
  const text = (typeof csv === 'string') ? csv : String(csv);
  const lines = text.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  const parsed = [];
  function unquote(s) {
    if (typeof s !== 'string') return '';
    let out = s.trim();
    // remove surrounding double or single quotes
    if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
      out = out.slice(1, -1);
    }
    // unescape double double-quotes inside quoted CSV fields
    out = out.replace(/""/g, '"');
    return out;
  }
  for (const line of lines) {
    const parts = line.split(',').map(p => p.trim());
    if (parts.length < 3) continue;
    const phoneRaw = unquote(String(parts[0] || ''));
    const name = unquote(String(parts[1] || ''));
    const message = unquote(parts.slice(2).join(',').trim());
    const phoneDigits = phoneRaw.replace(/\D/g, '');
    let normalized = '';
    if (phoneDigits.length === 10) normalized = '91' + phoneDigits;
    else if (phoneDigits.length > 10 && phoneDigits.length <= 15) normalized = phoneDigits;
    else if (phoneDigits.length > 15) normalized = '91' + phoneDigits.slice(-10);
    else continue;
    parsed.push({ phone: normalized, name, message, status: 'pending' });
  }
  return parsed;
}

function displayContacts() {
  if (!contactsList) return;
  contactsList.innerHTML = '';
  contacts.slice(0, 10).forEach(contact => {
    const div = document.createElement('div'); div.className = 'contact-item';
    div.innerHTML = `<div class="contact-phone">+${contact.phone}</div><div class="contact-name">${contact.name}</div><div class="contact-message">${contact.message}</div>`;
    contactsList.appendChild(div);
  });
  if (contacts.length > 10) {
    const div = document.createElement('div'); div.className = 'contact-item'; div.style.textAlign = 'center'; div.style.color = '#667eea'; div.innerText = `... and ${contacts.length - 10} more contacts`; contactsList.appendChild(div);
  }
}

// Utility: ensure user has WA tab active (for auth/session)
function captureWhatsAppTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab?.id || !tab.url?.startsWith('https://web.whatsapp.com/')) { resolve({ ok: false, error: 'Open WhatsApp Web tab and keep it active, then try again.' }); return; }
      waTabId = tab.id; resolve({ ok: true, tabId: waTabId });
    });
  });
}

// Campaign control
async function startCampaign() {
  if (contacts.length === 0) { logMessage('No contacts to send', 'error'); return; }
  const cap = await captureWhatsAppTabId(); if (!cap.ok) { logMessage(cap.error, 'error'); return; }
  campaignRunning = true; campaignPaused = false; startBtn.style.display = 'none'; pauseBtn.style.display = 'inline-flex'; stopBtn.style.display = 'inline-flex'; resetBtn.disabled = true;
  logMessage(`🚀 Starting campaign (background). Sending ${contacts.length} messages...`, 'info');
  let delaySec = parseInt(document.getElementById('delayInput').value, 10); if (isNaN(delaySec) || delaySec < 1) delaySec = 10;
  const randomize = document.getElementById('randomizeDelay').checked; let batchSize = parseInt(document.getElementById('batchSize').value, 10); if (isNaN(batchSize) || batchSize < 1) batchSize = 10; let batchDelaySec = parseInt(document.getElementById('batchDelay').value, 10); if (isNaN(batchDelaySec) || batchDelaySec < 1) batchDelaySec = 60;
  const options = { delay: delaySec * 1000, randomize, batchSize, batchDelay: batchDelaySec * 1000 };
  try {
    campaignPort = chrome.runtime.connect({ name: 'wabulk_port' });
    campaignPort.onMessage.addListener((msg) => {
      if (!msg || !msg.action) return;
      if (msg.action === 'campaignProgress') {
        const { index, contact, result } = msg; const c = contacts[index]; if (result && result.success) { c.status = 'sent'; campaignStats.sent++; logMessage(`✅ ${c.name} (+${c.phone}) - ${result.note || 'sent'}`, 'success'); } else { c.status = 'failed'; campaignStats.failed++; logMessage(`❌ ${c.name} (+${c.phone}) - ${result.error || 'failed'}`, 'error'); } campaignStats.pending = contacts.filter(c => c.status === 'pending').length; updateStats();
      } else if (msg.action === 'campaignStatus') {
        if (msg.status === 'finished' || msg.status === 'stopped') { campaignRunning = false; campaignPaused = false; pauseBtn.style.display = 'none'; stopBtn.style.display = 'none'; startBtn.style.display = 'inline-flex'; resetBtn.disabled = false; logMessage(`✅ Campaign ${msg.status}`, 'info'); try { campaignPort.disconnect(); } catch (e) {} campaignPort = null; currentCampaignId = null; }
      } else if (msg.action === 'error') { logMessage(`⚠️ ${msg.error}`, 'error'); } else if (msg.action === 'info') { logMessage(msg.message, 'info'); }
    });
  } catch (e) { logMessage('⚠️ Failed to open port for logs: ' + (e.message || e), 'info'); campaignPort = null; }
  chrome.runtime.sendMessage({ action: 'startCampaign', contacts, options }, (resp) => { if (!resp || !resp.ok) { logMessage('❌ Failed to start campaign: ' + (resp?.error || 'unknown'), 'error'); campaignRunning = false; return; } currentCampaignId = resp.id; try { if (campaignPort) campaignPort.postMessage({ action: 'attach', campaignId: currentCampaignId }); } catch (e) {} campaignStats.total = contacts.length; updateStats(); });
}

function pauseCampaign() { chrome.runtime.sendMessage({ action: 'pauseCampaign' }, (resp) => { if (resp && resp.ok) { campaignPaused = true; pauseBtn.textContent = '▶️ Resume'; logMessage('⏸️ Campaign paused', 'info'); } else logMessage('⚠️ Pause failed: ' + (resp?.error || 'unknown'), 'error'); }); }

function stopCampaign() { if (!confirm('Stop campaign? Unsent messages will be discarded.')) return; chrome.runtime.sendMessage({ action: 'stopCampaign' }, (resp) => { if (resp && resp.ok) { campaignRunning = false; campaignPaused = false; pauseBtn.style.display = 'none'; stopBtn.style.display = 'none'; startBtn.style.display = 'inline-flex'; resetBtn.disabled = false; logMessage('⏹️ Campaign stopped', 'info'); } else logMessage('⚠️ Stop failed: ' + (resp?.error || 'unknown'), 'error'); }); }

function resetCampaign() { if (!confirm('Reset all data?')) return; contacts = []; campaignStats = { total: 0, sent: 0, failed: 0, pending: 0 }; if (campaignLog) campaignLog.innerHTML = ''; if (csvFile) csvFile.value = ''; if (fileStatus) fileStatus.textContent = ''; if (previewSection) previewSection.style.display = 'none'; if (campaignSection) campaignSection.style.display = 'none'; if (verificationSection) verificationSection.style.display = 'none'; if (startBtn) startBtn.style.display = 'inline-flex'; if (pauseBtn) pauseBtn.style.display = 'none'; if (stopBtn) stopBtn.style.display = 'none'; resetBtn.disabled = false; updateStats(); }

// Initialize
updateStats();
