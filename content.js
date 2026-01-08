// Content script runs on WhatsApp Web
// Listener handles send requests, verify/send, ping, and abort messages in one place
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
        if (!request || !request.action) return false;
        if (request.action === 'sendMessage') {
            // legacy/simple send (keeps compatibility)
            sendMessage(request.phone, request.name, request.message)
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true; // Keep channel open for async response
        }

        if (request.action === 'verifyAndSend') {
            verifyAndSend(request.phone, request.name, request.message, request.campaignId)
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;
        }

        if (request.action === 'ping') {
            sendResponse({ ok: true });
            return false;
        }

        if (request.action === 'abort') {
            try { if (request.campaignId) abortFlags.add(request.campaignId); } catch (e) {}
            try { sendResponse({ ok: true, aborted: true }); } catch (e) {}
            return false;
        }
    } catch (e) {
        try { sendResponse({ success: false, error: String(e) }); } catch (er) {}
        return false;
    }
});

// Abort flag per campaign id (best-effort)
const abortFlags = new Set();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'abort') {
        try {
            if (request.campaignId) abortFlags.add(request.campaignId);
        } catch (e) {}
        // respond to ack
        try { sendResponse({ ok: true, aborted: true }); } catch (e) {}
        return false;
    }
});

async function sendMessage(phone, name, message) {
    const steps = [];
    try {
        // Prefer working only when the compose box / message input is present.
        // The popup should navigate the tab to the /send URL and re-inject this
        // content script if necessary. Here we only attempt to send if the
        // compose box is available.
        const composeSelectors = [
            '[data-testid="compose-box-input"]',
            '#main footer [contenteditable="true"]',
            '[contenteditable="true"]',
            'div[role="textbox"]'
        ];
        let composeEl = null;
        try {
            composeEl = await waitForAny(composeSelectors, 4000);
            steps.push('compose-box-found');
        } catch (e) {
            // Not present in the current DOM; caller should navigate to the send URL
            return { success: false, error: 'Cannot find compose box', steps };
        }

        // Normalize message input element
        const messageInput = composeEl;
        if (!messageInput) {
            return { success: false, error: 'Cannot find message input', steps };
        }

        // Focus and set message content
        messageInput.focus();

        // Different editors require different ways to set text
        try {
            if (messageInput.isContentEditable || messageInput.tagName === 'DIV') {
                // Clear existing
                messageInput.innerHTML = '';
                // Preserve newlines
                const parts = message.split('\n');
                for (let i = 0; i < parts.length; i++) {
                    const tn = document.createTextNode(parts[i]);
                    messageInput.appendChild(tn);
                    if (i < parts.length - 1) messageInput.appendChild(document.createElement('br'));
                }
                // Use a generic input event (InputEvent may not be supported in older browsers)
                try {
                    messageInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
                } catch (ie) {
                    messageInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            } else {
                messageInput.value = message;
                messageInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            steps.push('message-filled');
        } catch (e) {
            steps.push('message-fill-failed');
            return { success: false, error: 'Failed to set message', steps };
        }

        await sleep(300);

        // Click send button if present otherwise press Enter
        const sendSelectors = ['[data-testid="send"]', 'button[type="submit"]', 'span[data-icon="send"]', '[aria-label="Send"]'];
        let sendBtn = null;
        for (const s of sendSelectors) { const el = document.querySelector(s); if (el) { sendBtn = el; break; } }

        if (sendBtn) {
            try { sendBtn.click(); steps.push('send-clicked'); } catch (e) { /* continue to Enter fallback */ }
        }

        // fallback: dispatch Enter if click didn't work or no send button
        if (!sendBtn || (steps.indexOf('send-clicked') === -1)) {
            try {
                messageInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                steps.push('enter-dispatched');
            } catch (e) {}
        }

        await sleep(700);
        steps.push('sent');
        return { success: true, note: 'sent via direct link', steps };

    } catch (error) {
        steps.push('exception');
        return { success: false, error: error.message, steps };
    }
}

function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);

        const observer = new MutationObserver(() => {
            const el = document.querySelector(selector);
            if (el) {
                observer.disconnect();
                resolve(el);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Element ${selector} not found within ${timeout}ms`));
        }, timeout);
    });
}

function waitForAny(selectors, timeout = 5000) {
    return new Promise((resolve, reject) => {
        if (!Array.isArray(selectors)) selectors = [selectors];

        for (const s of selectors) {
            const el = document.querySelector(s);
            if (el) return resolve(el);
        }

        const observer = new MutationObserver(() => {
            for (const s of selectors) {
                const el = document.querySelector(s);
                if (el) {
                    observer.disconnect();
                    return resolve(el);
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => {
            observer.disconnect();
            reject(new Error(`None of selectors ${JSON.stringify(selectors)} found within ${timeout}ms`));
        }, timeout);
    });
}

// Try to detect and clear common interstitials or dialogs that block sending
async function handleInterstitials(timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        // Look for dialog buttons or anchors that suggest continuation
        const candidates = Array.from(document.querySelectorAll('button, a, div'));
        for (const el of candidates) {
            try {
                const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                if (!txt) continue;
                if (txt.includes('continue') && txt.includes('chat')) { try { el.click(); return { handled: true, reason: 'continue-chat' }; } catch (e) {} }
                if (txt.includes('use whatsapp') || txt.includes('use whatsapp web') || txt.includes('open whatsapp')) { try { el.click(); return { handled: true, reason: 'use-whatsapp' }; } catch (e) {} }
                if (txt.includes('send message') && txt.includes('not')) { return { handled: false, error: 'phone_not_found' }; }
            } catch (e) {}
        }
        // small wait for DOM changes
        await sleep(250);
    }
    return { handled: false };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Verify-and-send: used when popup navigates to /send?phone=..&text=..
async function verifyAndSend(phone, name, message, campaignId) {
    const steps = [];
    try {
        // try dismissing interstitials first
        try {
            const inter = await handleInterstitials(2000);
            if (inter && inter.error === 'phone_not_found') return { success: false, error: 'Phone not found (interstitial)', steps };
            if (inter && inter.handled) steps.push('interstitial-handled:' + (inter.reason || 'unknown'));
        } catch (e) {}

        const composeSelectors = ['[data-testid="compose-box-input"]', '#main footer [contenteditable="true"]', '[contenteditable="true"]', 'div[role="textbox"]'];
        let composeEl = null;
        try {
            composeEl = await waitForAny(composeSelectors, 10000);
            steps.push('compose-box-found');
        } catch (e) {
            return { success: false, error: 'Cannot find compose box', steps };
        }

        const messageInput = composeEl;
        if (!messageInput) return { success: false, error: 'Cannot find message input', steps };

        // We'll attempt send up to maxAttempts times before giving up
        const maxAttempts = 3;
        let attempt = 0;
        let lastErr = null;
        for (attempt = 1; attempt <= maxAttempts; attempt++) {
            // refill message each attempt
            try {
                messageInput.focus();
                if (messageInput.isContentEditable || messageInput.tagName === 'DIV') {
                    // set innerHTML with line breaks
                    messageInput.innerHTML = '';
                    const parts = message.split('\n');
                    for (let i = 0; i < parts.length; i++) {
                        messageInput.appendChild(document.createTextNode(parts[i]));
                        if (i < parts.length - 1) messageInput.appendChild(document.createElement('br'));
                    }
                    try { messageInput.dispatchEvent(new InputEvent('input', { bubbles: true })); } catch (ie) { messageInput.dispatchEvent(new Event('input', { bubbles: true })); }
                } else {
                    messageInput.value = message;
                    messageInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                steps.push(`message-filled-attempt-${attempt}`);
            } catch (e) {
                steps.push(`message-fill-failed-attempt-${attempt}`);
                lastErr = e;
                // try small delay then next attempt
                await sleep(300);
                continue;
            }

            await sleep(350);

            // attempt click-based send first
            let didClickSend = false;
            try {
                const sendSelectors = ['[data-testid="send"]', 'button[type="submit"]', 'span[data-icon="send"]', '[aria-label="Send"]'];
                let sendBtn = null;
                for (const s of sendSelectors) { const el = document.querySelector(s); if (el) { sendBtn = el; break; } }
                if (sendBtn) {
                    try {
                        // synthetic strong click sequence
                        sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                        sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                        sendBtn.click();
                        steps.push(`send-clicked-attempt-${attempt}`);
                        didClickSend = true;
                    } catch (e) { /* fallback to Enter below */ }
                }
            } catch (e) {}

            if (!didClickSend) {
                try {
                    messageInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                    steps.push(`enter-dispatched-attempt-${attempt}`);
                } catch (e) {}
            }

            // Verify: poll for outgoing message that contains the text
            const verifyTimeout = 14000;
            const start = Date.now();
            let found = false;
            while (Date.now() - start < verifyTimeout) {
                // check for abort flag
                if (campaignId && abortFlags.has(campaignId)) {
                    return { success: false, error: 'aborted', steps };
                }
                // common selectors for message text
                const textEls = Array.from(document.querySelectorAll('span.selectable-text, div.copyable-text, span.copyable-text, span._11JPr'));
                for (const el of textEls) {
                    const txt = (el.innerText || el.textContent || '').trim();
                    if (!txt) continue;
                    // exact or contains match
                    if (txt === message || txt.includes(message)) {
                        // check if it's an outgoing message by looking up ancestor classes
                        let anc = el.closest('div');
                        let isOutgoing = false;
                        while (anc) {
                            const c = anc.className || '';
                            if (/outgoing|message-out|message-outgoing|_2hqOq|message-out|_3ays3/.test(c)) { isOutgoing = true; break; }
                            anc = anc.parentElement;
                        }
                        // if we can't determine outgoing reliably, accept presence as success
                        if (isOutgoing) { found = true; break; }
                    }
                }
                if (found) break;
                await sleep(400);
            }

            if (found) {
                steps.push(`verified-attempt-${attempt}`);
                return { success: true, steps, note: `sent and verified on attempt ${attempt}` };
            }

            // Not found -> record and try again up to attempts
            steps.push(`verify-timeout-attempt-${attempt}`);
            lastErr = new Error('Message not observed in chat after send');
            // small backoff before retry
            await sleep(500 + attempt * 200);
        }

        // all attempts failed
        return { success: false, error: lastErr ? (lastErr.message || String(lastErr)) : 'failed', steps };
    } catch (err) {
        steps.push('exception');
        return { success: false, error: err.message, steps };
    }
}
