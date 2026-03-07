console.log("Productivity Timer content script running");

function getSiteKey() {
    const host = window.location.hostname.toLowerCase();
    if (host.endsWith("youtube.com")) return "youtube";
    if (host.endsWith("instagram.com")) return "instagram";
    if (host.endsWith("facebook.com")) return "facebook";
    return null;
}

const siteKey = getSiteKey();
if (siteKey) {
    chrome.runtime.sendMessage({ action: "startTimer", siteKey }, (response) => {
        console.log("startTimer response", response);
    });
}
