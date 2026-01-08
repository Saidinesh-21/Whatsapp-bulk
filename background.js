// Service worker - campaign orchestration and controller
console.log('[WABulk] background service worker loaded');

// Campaigns stored by id (only one active campaign expected but support multiple)
let campaignCounter = 0;
let campaigns = {}; // id -> { id, contacts, index, status, options, senderTabId, createdByUs, port }
// map notificationId -> campaignId for button handlers
let notifToCampaign = {};
// control panel window id (single persistent panel)
let controlWindowId = null;

function persistCampaignState(id) {
    try {
        const c = campaigns[id];
        if (!c) return;
        const toSave = { id: c.id, index: c.index, status: c.status, total: c.contacts.length };
        chrome.storage.local.set({ ['wabulk_campaign_' + id]: toSave });
    } catch (e) { /* ignore persistence errors */ }
}

function sendToPortOrRuntime(port, msg) {
    try {
        if (port && port.postMessage) port.postMessage(msg);
        else chrome.runtime.sendMessage(msg);
    } catch (e) { /* ignore */ }
}

function createOrUpdateNotification(campaign, title, message, buttons = []) {
    try {
        const id = 'wabulk_campaign_' + campaign.id;
        notifToCampaign[id] = campaign.id;
        const opts = {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: title || `Campaign ${campaign.id}`,
            message: message || `${campaign.index}/${campaign.contacts.length} processed`,
            buttons: buttons
        };
        chrome.notifications.create(id, opts, () => {});
        campaign.notificationId = id;
    } catch (e) { /* ignore notification errors */ }
}

function clearNotification(campaign) {
    try {
        if (campaign && campaign.notificationId) {
            chrome.notifications.clear(campaign.notificationId, () => {});
            delete notifToCampaign[campaign.notificationId];
            campaign.notificationId = null;
        }
    } catch (e) {}
}

// Notification button handlers
chrome.notifications.onButtonClicked.addListener((notifId, btnIndex) => {
    try {
        const id = notifToCampaign[notifId];
        if (!id) return;
        const c = campaigns[id];
        if (!c) return;
        // Button 0 -> Pause/Resume, Button 1 -> Stop
        if (btnIndex === 0) {
            if (c.status === 'running') { c.status = 'paused'; c.version++; sendToPortOrRuntime(c.port, { action: 'info', message: 'Paused by user', id }); createOrUpdateNotification(c, 'Campaign paused', `${c.index}/${c.contacts.length} processed`, [{ title: 'Resume' }, { title: 'Stop' }]); }
            else { c.status = 'running'; runCampaign(id).catch(e=>console.error(e)); sendToPortOrRuntime(c.port, { action: 'info', message: 'Resumed by user', id }); createOrUpdateNotification(c, 'Campaign resumed', `${c.index}/${c.contacts.length} processed`, [{ title: 'Pause' }, { title: 'Stop' }]); }
        } else if (btnIndex === 1) {
            c.status = 'stopped'; c.version++; sendToPortOrRuntime(c.port, { action: 'info', message: 'Stopped by user', id }); clearNotification(c);
        }
    } catch (e) {}
});

// Keyboard command handler: stop/resume campaign via configured shortcut
chrome.commands?.onCommand?.addListener((command) => {
    try {
        if (command === 'wabulk-stop') {
            // stop all campaigns
            for (const id in campaigns) {
                campaigns[id].status = 'stopped';
                campaigns[id].version++;
                const c = campaigns[id];
                if (c && c.senderTabId) {
                    try { chrome.tabs.sendMessage(c.senderTabId, { action: 'abort', campaignId: c.id }); } catch (e) {}
                }
                try { clearNotification(c); } catch (e) {}
                sendToPortOrRuntime(c.port, { action: 'info', message: 'Stopped by keyboard shortcut', id });
            }
        }
    } catch (e) {}
});

chrome.runtime.onConnect.addListener((port) => {
    if (port?.name !== 'wabulk_port') return;
    console.log('[WABulk] popup connected via port');
    port.onMessage.addListener(msg => {
        try {
            if (msg && msg.action === 'attach' && msg.campaignId) {
                const id = String(msg.campaignId);
                if (campaigns[id]) {
                    campaigns[id].port = port;
                    port.postMessage({ action: 'attached', campaignId: id });
                }
            }
        } catch (e) {}
    });
    port.onDisconnect.addListener(() => {
        // clear the port reference from any campaign that had it
        for (const id in campaigns) {
            if (campaigns[id].port === port) campaigns[id].port = null;
        }
    });
});

// If control window is closed, clear controlWindowId
chrome.windows.onRemoved.addListener((wid) => {
    try {
        if (controlWindowId && wid === controlWindowId) controlWindowId = null;
    } catch (e) {}
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
        try {
            if (request.action === 'startCampaign') {
                const id = ++campaignCounter;
                const contacts = request.contacts || [];
                const options = request.options || {};
                const port = request.expectPort && sender?.id ? null : null; // port will be attached via connect from popup

                campaigns[id] = {
                    id,
                    contacts,
                    index: 0,
                    status: 'running',
                    options,
                    senderTabId: null,
                    createdByUs: false,
                    port,
                    version: 1
                };

                // Open a persistent control panel window (if not already open)
                try {
                    if (!controlWindowId) {
                        chrome.windows.create({ url: chrome.runtime.getURL('control.html') + '?campaignId=' + id, type: 'popup', width: 620, height: 720 }, (w) => {
                            try { if (w && w.id) controlWindowId = w.id; } catch (e) {}
                        });
                    } else {
                        // focus the window if exists
                        try { chrome.windows.update(controlWindowId, { focused: true }); } catch (e) {}
                    }
                } catch (e) {}

                // try to attach a port from any existing connection matching (popup should connect separately)
                // Start the campaign asynchronously
                runCampaign(id).catch(e => console.error('[WABulk] campaign run error', e));

                sendResponse({ ok: true, id });
                return;
            }

            if (!request.action) { sendResponse({ ok: false, error: 'no action' }); return; }

            if (request.action === 'pauseCampaign') {
                for (const id in campaigns) { campaigns[id].status = 'paused'; persistCampaignState(id); sendResponse({ ok: true }); return; }
                sendResponse({ ok: false, error: 'no running campaign' });
                return;
            }

            if (request.action === 'resumeCampaign') {
                for (const id in campaigns) {
                    if (campaigns[id].status === 'paused') { campaigns[id].status = 'running'; persistCampaignState(id); // resume
                        runCampaign(parseInt(id)).catch(e=>console.error(e)); sendResponse({ ok: true }); return; }
                }
                sendResponse({ ok: false, error: 'no paused campaign' });
                return;
            }

            if (request.action === 'stopCampaign') {
                for (const id in campaigns) {
                    campaigns[id].status = 'stopped';
                    campaigns[id].version++;
                    // attempt to abort content script if possible
                    const c = campaigns[id];
                    if (c && c.senderTabId) {
                        try { chrome.tabs.sendMessage(c.senderTabId, { action: 'abort', campaignId: c.id }); } catch (e) {}
                    }
                    persistCampaignState(id);
                    sendResponse({ ok: true });
                    return;
                }
                sendResponse({ ok: false, error: 'no running campaign' });
                return;
            }

            

            sendResponse({ ok: false, error: 'unknown action' });
        } catch (err) {
            sendResponse({ ok: false, error: String(err) });
        }
    })();
    // indicate async sendResponse
    return true;
});

async function ensureSenderTab(campaign) {
    if (campaign.senderTabId) {
        try {
            const tab = await new Promise((res, rej) => chrome.tabs.get(campaign.senderTabId, t => { const err = chrome.runtime.lastError; if (err) return rej(err); res(t); }));
            return tab;
        } catch (e) {
            campaign.senderTabId = null; campaign.createdByUs = false;
        }
    }
    // Prefer reusing an existing WhatsApp Web tab if one exists (avoid opening new tabs for each send)
    try {
        const tabs = await new Promise((res) => chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (t) => res(t)));
        if (tabs && tabs.length > 0) {
            // Prefer the active tab in current window if present
            let chosen = tabs.find(t => t.active) || tabs[0];
            campaign.senderTabId = chosen.id;
            campaign.createdByUs = false;
            return chosen;
        }
    } catch (e) {
        // fallthrough to create
    }

    return new Promise((resolve, reject) => {
        chrome.tabs.create({ url: 'https://web.whatsapp.com/', active: true }, (tab) => {
            const err = chrome.runtime.lastError;
            if (err) return reject(err);
            campaign.senderTabId = tab.id;
            campaign.createdByUs = true;
            try { if (tab && typeof tab.windowId === 'number') chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
            setTimeout(() => resolve(tab), 600);
        });
    });
}

function navigateTabToUrl(tabId, url, timeout = 10000, focus = true) {
    return new Promise((resolve) => {
        let resolved = false;
        const onUpdated = (updatedTabId, changeInfo) => {
            if (updatedTabId !== tabId) return;
            if (changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(onUpdated);
                if (!resolved) { resolved = true; resolve(); }
            }
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        try {
            chrome.tabs.update(tabId, { url, active: focus }, (tab) => {
                try { if (focus && tab && typeof tab.windowId === 'number') chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
            });
        } catch (e) {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
            return;
        }
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); if (!resolved) { resolved = true; resolve(); } }, timeout);
    });
}

function sendToTabWithResponse(tabId, payload, timeout = 10000) {
    return new Promise((resolve) => {
        let done = false;
        try {
            chrome.tabs.sendMessage(tabId, payload, (response) => {
                const err = chrome.runtime.lastError;
                if (done) return;
                done = true;
                resolve({ response, err });
            });
        } catch (e) {
            if (done) return;
            done = true;
            resolve({ response: null, err: e });
        }
        setTimeout(() => { if (done) return; done = true; resolve({ response: null, err: new Error('timeout') }); }, timeout);
    });
}

async function runCampaign(id) {
    const campaign = campaigns[id];
    if (!campaign) return;
    const total = campaign.contacts.length;
    sendToPortOrRuntime(campaign.port, { action: 'campaignStatus', status: 'started', id, total });

    // Ensure sender tab exists
    try { await ensureSenderTab(campaign); } catch (e) { sendToPortOrRuntime(campaign.port, { action: 'error', error: 'Failed to create sender tab: ' + (e.message || e) }); campaign.status = 'stopped'; return; }

    // main loop
    while (campaign.index < total) {
        if (campaign.status === 'stopped') break;
        if (campaign.status === 'paused') {
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

    const contact = campaign.contacts[campaign.index];
    // Always apply template replacement to either campaign template or contact message
    const rawTemplate = (campaign.options && campaign.options.template) ? campaign.options.template : contact.message;
    const finalMessage = applyTemplate(rawTemplate, contact);
        const sendUrl = `https://web.whatsapp.com/send?phone=${contact.phone}&text=${encodeURIComponent(finalMessage)}`;

        // navigate
        try {
            await navigateTabToUrl(campaign.senderTabId, sendUrl, 12000);
        } catch (e) {
            // ignore navigation error
        }

        // inject content script
        try {
            await new Promise((res, rej) => chrome.scripting.executeScript({ target: { tabId: campaign.senderTabId }, files: ['content.js'] }, () => { const err = chrome.runtime.lastError; if (err) return rej(err); res(); }));
        } catch (e) {
            // injection failed; try to continue
        }

        // handshake: try pinging the content script with a few retries.
        // This reduces races where the tab navigates and the content script isn't yet listening.
        let pingOk = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                // focus the tab/window to improve script activation for web.whatsapp
                try { chrome.tabs.update(campaign.senderTabId, { active: true }, () => {}); } catch (e) {}
                try { const tab = await new Promise((res, rej) => chrome.tabs.get(campaign.senderTabId, t => { const err = chrome.runtime.lastError; if (err) return rej(err); res(t); })); if (tab && typeof tab.windowId === 'number') chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}

                const ping = await sendToTabWithResponse(campaign.senderTabId, { action: 'ping' }, 3000);
                if (!ping.err && ping.response && ping.response.ok) { pingOk = true; break; }
            } catch (e) {
                // swallow and try injecting below
            }

            // if no response, attempt to inject content script and wait a bit before retrying
            try {
                await new Promise((res) => chrome.scripting.executeScript({ target: { tabId: campaign.senderTabId }, files: ['content.js'] }, () => res()));
            } catch (e) { /* ignore injection errors */ }
            await new Promise(r => setTimeout(r, 700 + attempt * 200));
        }

        if (!pingOk) {
            // one last best-effort inject before proceeding; the send may still fail and be reported
            try { await new Promise((res) => chrome.scripting.executeScript({ target: { tabId: campaign.senderTabId }, files: ['content.js'] }, () => res())); } catch (e) {}
            await new Promise(r => setTimeout(r, 500));
        }

        // create notification controls for this campaign (allow user to pause/stop even if popup closed)
        try {
            createOrUpdateNotification(campaign, 'Campaign running', `${campaign.index}/${campaign.contacts.length} processed`, [{ title: 'Pause' }, { title: 'Stop' }]);
        } catch (e) {}

        // perform send
        const res = await sendToTabWithResponse(campaign.senderTabId, { action: 'verifyAndSend', phone: contact.phone, name: contact.name, message: finalMessage, campaignId: campaign.id }, 14000);

        // respect campaign version to avoid stale results
        if (campaign.version !== campaigns[id].version) {
            // aborted/restarted
            sendToPortOrRuntime(campaign.port, { action: 'info', message: 'campaign invalidated, aborting', id });
            break;
        }

        let result;
        if (res.err) result = { success: false, error: res.err.message || String(res.err) };
        else result = res.response || { success: false, error: 'no response' };

        // report
        sendToPortOrRuntime(campaign.port, { action: 'campaignProgress', id, index: campaign.index, contact, result });

        campaign.index++;
        persistCampaignState(id);

        // spacing between messages if options provided
        const delay = (campaign.options && campaign.options.delay) ? campaign.options.delay : 1000;
        await new Promise(r => setTimeout(r, delay));
    }

    // cleanup
    sendToPortOrRuntime(campaign.port, { action: 'campaignStatus', status: campaign.status === 'stopped' ? 'stopped' : 'finished', id });
    try { clearNotification(campaign); } catch (e) {}
    if (campaign.createdByUs && campaign.senderTabId) {
        try { chrome.tabs.remove(campaign.senderTabId); } catch (e) {}
        campaign.senderTabId = null; campaign.createdByUs = false;
    }
}

function applyTemplate(template, data) {
    try {
        let out = (template || '');
        out = out.replaceAll('{name}', data.name ?? '');
        out = out.replaceAll('{phone}', data.phone ?? '');
        return out;
    } catch (e) {
        return (template || '').replace(/\{name\}/g, data.name ?? '').replace(/\{phone\}/g, data.phone ?? '');
    }
}

