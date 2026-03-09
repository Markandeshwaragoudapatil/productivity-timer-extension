console.log("Productivity Timer content script running");

const DEFAULT_SITES = [
    "youtube.com",
    "instagram.com",
    "facebook.com"
];

function normalizeDomain(domain) {
    return (domain || "").trim().toLowerCase().replace(/^\*\.?/, "");
}

function getSiteKey(url, blockedSites) {
    if (!url) return null;
    const host = new URL(url).hostname.toLowerCase();
    for (const domain of blockedSites) {
        const normalized = normalizeDomain(domain);
        if (!normalized) continue;
        if (host === normalized || host.endsWith(`.${normalized}`)) {
            return normalized;
        }
    }
    return null;
}

function maybeStartTimer() {
    chrome.storage.local.get({ blockedSites: DEFAULT_SITES }, (result) => {
        const sites = Array.isArray(result.blockedSites) && result.blockedSites.length ? result.blockedSites : DEFAULT_SITES;
        const key = getSiteKey(window.location.href, sites);
        if (!key) return;

        chrome.runtime.sendMessage({ action: "startTimer", siteKey: key }, (response) => {
            console.log("startTimer response", response);
        });
    });
}

maybeStartTimer();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.action === "refreshBlockedSites") {
        maybeStartTimer();
    }
});
