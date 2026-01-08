// Control panel script: connects to background via port and controls campaign
let port = null;
let campaignId = null;

const logArea = document.getElementById('logArea');
const totalCount = document.getElementById('totalCount');
const sentCount = document.getElementById('sentCount');
const failedCount = document.getElementById('failedCount');
const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');
const stopBtn = document.getElementById('stopBtn');
const campaignIdEl = document.getElementById('campaignId');

function addLog(msg, type='info'){
  const d = document.createElement('div'); d.className = 'log-entry ' + type; d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`; logArea.appendChild(d); logArea.scrollTop = logArea.scrollHeight; }

function bindButtons(){
  pauseBtn.addEventListener('click', ()=>{
    if (!campaignId) return addLog('No campaign attached', 'error');
    chrome.runtime.sendMessage({ action: 'pauseCampaign' }, (resp)=>{ if (resp && resp.ok) { addLog('Paused campaign', 'info'); pauseBtn.style.display='none'; resumeBtn.style.display='inline-block'; } else addLog('Pause failed: '+(resp?.error||'unknown'),'error'); });
  });
  resumeBtn.addEventListener('click', ()=>{
    if (!campaignId) return addLog('No campaign attached', 'error');
    chrome.runtime.sendMessage({ action: 'resumeCampaign' }, (resp)=>{ if (resp && resp.ok) { addLog('Resumed campaign', 'info'); resumeBtn.style.display='none'; pauseBtn.style.display='inline-block'; } else addLog('Resume failed: '+(resp?.error||'unknown'),'error'); });
  });
  stopBtn.addEventListener('click', ()=>{
    if (!campaignId) return addLog('No campaign attached', 'error');
    if (!confirm('Stop campaign?')) return;
    chrome.runtime.sendMessage({ action: 'stopCampaign' }, (resp)=>{ if (resp && resp.ok) { addLog('Stopped campaign', 'info'); } else addLog('Stop failed: '+(resp?.error||'unknown'),'error'); });
  });
}

function connectPort(){
  try {
    port = chrome.runtime.connect({ name: 'wabulk_port' });
    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(()=>{ addLog('Disconnected from background', 'error'); port = null; });
    addLog('Connected to background', 'info');
    // If campaignId present in query string, attach immediately
    const params = new URLSearchParams(location.search);
    const id = params.get('campaignId');
    if (id) { campaignId = id; campaignIdEl.textContent = 'Campaign ' + id; try { port.postMessage({ action: 'attach', campaignId: String(id) }); addLog('Sent attach for campaign '+id, 'info'); } catch (e) {} }
  } catch (e) { addLog('Failed to connect to background: '+(e.message||e), 'error'); }
}

function handlePortMessage(msg){
  if (!msg || !msg.action) return;
  if (msg.action === 'campaignProgress'){
    const { index, contact, result } = msg;
    addLog(`${index}: ${contact.name} (+${contact.phone}) -> ${result && result.success ? 'OK' : 'FAIL'} ${result && result.error ? '- '+result.error : ''}`, result && result.success ? 'success' : 'error');
    // update counts if available by reading DOM: ask background for persisted stats or update heuristically
    // For now increment sent/failed counters by inspecting the message
    if (result && result.success) sentCount.textContent = Number(sentCount.textContent||0) + 1;
    else failedCount.textContent = Number(failedCount.textContent||0) + 1;
  } else if (msg.action === 'campaignStatus'){
    addLog('Status: '+msg.status, 'info');
    if (msg.status === 'finished' || msg.status === 'stopped'){
      pauseBtn.disabled = true; resumeBtn.disabled = true; stopBtn.disabled = true;
    }
  } else if (msg.action === 'attached'){
    addLog('Attached to campaign '+msg.campaignId,'info');
    campaignId = msg.campaignId; campaignIdEl.textContent = 'Campaign ' + campaignId;
  } else if (msg.action === 'error'){
    addLog('Error: '+msg.error,'error');
  } else if (msg.action === 'info'){
    addLog(msg.message,'info');
  }
}

bindButtons();
connectPort();

// Try to request campaign summary once connected
setTimeout(()=>{
  if (!campaignId && window.location.search.indexOf('campaignId=') === -1) {
    chrome.runtime.sendMessage({ action: 'getActiveCampaign' }, (resp)=>{
      if (resp && resp.id) { campaignId = resp.id; campaignIdEl.textContent = 'Campaign ' + campaignId; try { if (port) port.postMessage({ action: 'attach', campaignId: String(campaignId) }); } catch (e) {} }
    });
  }
}, 400);
