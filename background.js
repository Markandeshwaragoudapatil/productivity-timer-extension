// Use alarms API so timer survives service worker suspension in MV3
const ALARM_NAME_BASE = "productivityTimer";

const TIMER_DURATION_MS = 15_000; // 15 seconds for testing

const DEFAULT_SITES = [
    "youtube.com",
    "instagram.com",
    "facebook.com"
];

let blockedSites = [...DEFAULT_SITES];

function normalizeDomain(domain) {
    return (domain || "").trim().toLowerCase().replace(/^\*\.?/, "");
}

function updateBlockedSitesFromStorage(callback) {
    chrome.storage.local.get({ blockedSites: DEFAULT_SITES }, (result) => {
        if (Array.isArray(result.blockedSites) && result.blockedSites.length) {
            blockedSites = result.blockedSites.map(normalizeDomain).filter(Boolean);
        } else {
            blockedSites = [...DEFAULT_SITES];
        }
        if (typeof callback === "function") callback();
    });
}

function notifyTabsToRecheckSites(domains) {
    if (!Array.isArray(domains) || domains.length === 0) return;

    chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
            if (!tab.url) return;
            const key = getSiteKey(tab.url);
            if (key && domains.includes(key)) {
                chrome.tabs.sendMessage(tab.id, { action: "refreshBlockedSites" }, () => {
                    // ignore errors (tab may not have content script)
                });
            }
        });
    });
}

function notifyComponentsBlockedSitesChanged(added, removed) {
    chrome.runtime.sendMessage({ action: "blockedSitesChanged", added, removed });
}

// Keep the in-memory list in sync with storage
updateBlockedSitesFromStorage();
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.blockedSites) {
        const oldSites = Array.isArray(changes.blockedSites.oldValue) ? changes.blockedSites.oldValue.map(normalizeDomain) : [];
        const newSites = Array.isArray(changes.blockedSites.newValue) ? changes.blockedSites.newValue.map(normalizeDomain) : [];

        const addedSites = newSites.filter((site) => !oldSites.includes(site));
        const removedSites = oldSites.filter((site) => !newSites.includes(site));

        // Clear any timers/alarms for sites that were removed from the block list.
        removedSites.forEach((site) => {
            const alarmName = `${ALARM_NAME_BASE}_${site}`;
            chrome.alarms.clear(alarmName);
            clearTimerState(site);
        });

        updateBlockedSitesFromStorage(() => {
            // Notify content scripts to re-check their current tab URLs
            notifyTabsToRecheckSites(addedSites);
            // Notify popups / other components about blocked list changes
            notifyComponentsBlockedSitesChanged(addedSites, removedSites);
        });
    }
});

function getSiteKey(url) {
    if (!url) return null;
    const host = new URL(url).hostname.toLowerCase();
    for (const domain of blockedSites) {
        if (!domain) continue;
        if (host === domain || host.endsWith(`.${domain}`)) {
            return domain;
        }
    }
    return null;
}

function stateKey(key) {
    return `productivityTimerState_${key}`;
}

function cooldownKey(key) {
    return `productivityTimerCooldown_${key}`;
}

function setTimerState(key, data) {
    chrome.storage.local.set({ [stateKey(key)]: data });
}

function clearTimerState(key) {
    chrome.storage.local.remove(stateKey(key));
}

function getTimerState(key, callback) {
    chrome.storage.local.get([stateKey(key)], (result) => {
        callback(result[stateKey(key)] || null);
    });
}

function getTabKeyMap(callback) {
    chrome.storage.local.get(["productivityTimerTabMap"], (result) => {
        callback(result.productivityTimerTabMap || {});
    });
}

function setTabKeyMap(map, callback) {
    chrome.storage.local.set({ productivityTimerTabMap: map }, () => {
        if (callback) callback();
    });
}

function setTabKey(tabId, key) {
    getTabKeyMap((map) => {
        map[tabId] = key;
        setTabKeyMap(map);
    });
}

function removeTabKey(tabId, callback) {
    getTabKeyMap((map) => {
        if (map.hasOwnProperty(tabId)) {
            delete map[tabId];
            setTabKeyMap(map, callback);
        } else if (callback) {
            callback();
        }
    });
}

function getKeyForTab(tabId, callback) {
    getTabKeyMap((map) => {
        callback(map[tabId] || null);
    });
}

function setCooldown(key, msFromNow) {
    const cooldownUntil = Date.now() + msFromNow;
    chrome.storage.local.set({ [cooldownKey(key)]: cooldownUntil });
}

function getCooldown(key, callback) {
    chrome.storage.local.get([cooldownKey(key)], (result) => {
        callback(result[cooldownKey(key)] || 0);
    });
}

function isDistractingUrl(url, key) {
    if (!url || !key) return false;
    return getSiteKey(url) === key;
}

function closeTabsForSite(key) {
    if (!key) return;
    const urls = [`*://${key}/*`, `*://*.${key}/*`];
    if (!urls.length) return;

    console.log(`Closing tabs for site key=${key}`, urls);

    chrome.tabs.query({ url: urls }, (tabs) => {
        const ids = tabs.map((t) => t.id).filter((id) => typeof id === "number");
        if (ids.length) {
            console.log(`Removing tabs for ${key}:`, ids);
            chrome.tabs.remove(ids, () => {
                // ignore errors
            });
        }
    });

    // Start a 30 second cooldown during which these URLs will be auto-closed.
    setCooldown(key, 30_000);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Background received message", message);

    if (message.action === "startTimer") {
        const key = message.siteKey || getSiteKey(sender.tab && sender.tab.url);
        if (!key) {
            sendResponse({ status: "no_site" });
            return true;
        }

        // If the site is still on cooldown, don’t start and close the tab immediately.
        getCooldown(key, (cooldownUntil) => {
            if (Date.now() < cooldownUntil) {
                if (sender.tab && typeof sender.tab.id === "number") {
                    chrome.tabs.remove(sender.tab.id, () => {
                        // ignore errors
                    });
                }
                sendResponse({ status: "blocked", key });
                return;
            }

            // If another tab has already paused the timer, keep it paused.
        getTimerState(key, (existingState) => {
            if (existingState && existingState.status === "paused") {
                sendResponse({ status: "paused", remaining: existingState.remaining, key });
                return;
            }

            // If it's already running, just return the current end time so new tabs stay in sync.
            if (existingState && existingState.status === "running") {
                sendResponse({ status: "running", endTime: existingState.endTime, key });
                return;
            }

            // Start a new timer (reset any existing state)
            const endTime = Date.now() + TIMER_DURATION_MS;
            setTimerState(key, { status: "running", endTime });

            const alarmName = `${ALARM_NAME_BASE}_${key}`;
            chrome.alarms.create(alarmName, { delayInMinutes: TIMER_DURATION_MS / 60000 });

            sendResponse({ status: "started", endTime, key });
        });

        });

        return true; // keep service worker alive for sendResponse
    }

    if (message.action === "pauseTimer") {
        const key = message.siteKey || getSiteKey(sender.tab && sender.tab.url);
        if (!key) {
            sendResponse({ status: "no_site" });
            return true;
        }

        getTimerState(key, (state) => {
            if (!state || state.status !== "running") {
                sendResponse({ status: "not_running", key });
                return;
            }

            const remaining = Math.max(0, state.endTime - Date.now());
            const alarmName = `${ALARM_NAME_BASE}_${key}`;
            chrome.alarms.clear(alarmName);
            setTimerState(key, { status: "paused", remaining });
            sendResponse({ status: "paused", remaining, key });
        });

        return true;
    }

    if (message.action === "resumeTimer") {
        const key = message.siteKey || getSiteKey(sender.tab && sender.tab.url);
        if (!key) {
            sendResponse({ status: "no_site" });
            return true;
        }

        getTimerState(key, (state) => {
            if (!state || state.status !== "paused") {
                sendResponse({ status: "not_paused", key });
                return;
            }

            const endTime = Date.now() + (state.remaining || 0);
            setTimerState(key, { status: "running", endTime });
            const alarmName = `${ALARM_NAME_BASE}_${key}`;
            chrome.alarms.create(alarmName, { delayInMinutes: (state.remaining || 0) / 60000 });
            sendResponse({ status: "resumed", endTime, key });
        });

        return true;
    }

    if (message.action === "resetTimer") {
        const key = message.siteKey || getSiteKey(sender.tab && sender.tab.url);
        if (!key) {
            sendResponse({ status: "no_site" });
            return true;
        }

        const alarmName = `${ALARM_NAME_BASE}_${key}`;
        chrome.alarms.clear(alarmName, (wasCleared) => {
            if (wasCleared) {
                clearTimerState(key);
            }
            sendResponse({ status: wasCleared ? "reset" : "none", key });
        });
        return true;
    }

    if (message.action === "getEndTime") {
        const key = message.siteKey || getSiteKey(sender.tab && sender.tab.url);
        if (!key) {
            sendResponse({});
            return true;
        }

        getTimerState(key, (state) => {
            sendResponse(state ? { ...state, key } : {});
        });
        return true;
    }

    if (message.action === "resetTimer") {
        const key = message.siteKey || getSiteKey(sender.tab && sender.tab.url);
        if (!key) {
            sendResponse({ status: "no_site" });
            return true;
        }

        const alarmName = `${ALARM_NAME_BASE}_${key}`;
        chrome.alarms.clear(alarmName, (wasCleared) => {
            if (wasCleared) {
                clearTimerState(key);
            }
            sendResponse({ status: wasCleared ? "reset" : "none", key });
        });
        return true;
    }

    if (message.action === "getEndTime") {
        const key = message.siteKey || getSiteKey(sender.tab && sender.tab.url);
        if (!key) {
            sendResponse({});
            return true;
        }

        getTimerState(key, (state) => {
            // Return the full timer state so popups on other tabs know whether the timer is paused or running.
            if (!state) {
                sendResponse({});
                return;
            }

            const response = { key, status: state.status };
            if (state.status === "running") {
                response.endTime = state.endTime;
            } else if (state.status === "paused") {
                response.remaining = state.remaining;
            }

            sendResponse(response);
        });
        return true;
    }

    sendResponse({ status: "unknown" });
});


chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name.startsWith(ALARM_NAME_BASE)) {
        const key = alarm.name.substring(ALARM_NAME_BASE.length + 1);

        // If the user has already closed all tabs for this site, don’t alert or close anything.
        const urls = [`*://${key}/*`, `*://*.${key}/*`];
        chrome.tabs.query({ url: urls }, (tabs) => {
            if (!tabs.length) {
                clearTimerState(key);
                return;
            }

            chrome.notifications.create({
                type: "basic",
                iconUrl: chrome.runtime.getURL("icon.png"),
                title: "Time's Up!",
                message: `Your ${key} timer is over.`,
                buttons: [
                    { title: "Restart Timer" },
                    { title: "Dismiss" }
                ]
            });

            // Play a sound via TTS so user hears it even if the popup is closed.
            if (chrome.tts) {
                chrome.tts.speak("Time is up", { rate: 1.0 });
            }

            // Close all tabs for this site and start cooldown for this site
            closeTabsForSite(key);
            clearTimerState(key);
        });
    }
});

chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
    if (btnIdx === 0) {
        // 15 seconds for testing
        chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.25 });
    }
});

// Close newly opened distracting tabs during the cooldown period
const SITE_KEYS = ["youtube", "instagram", "facebook"];

function checkAndCloseDuringCooldown(url, closeTab) {
    SITE_KEYS.forEach((key) => {
        if (isDistractingUrl(url, key)) {
            getCooldown(key, (cooldownUntil) => {
                if (Date.now() < cooldownUntil) {
                    console.log(`Cooldown active for ${key} (until ${new Date(cooldownUntil).toISOString()}) — closing tab`, url);
                    closeTab();
                }
            });
        }
    });
}

chrome.tabs.onCreated.addListener((tab) => {
    const key = getSiteKey(tab.url);
    if (key) {
        setTabKey(tab.id, key);
    }

    checkAndCloseDuringCooldown(tab.url, () => {
        chrome.tabs.remove(tab.id, () => {
            // ignore errors
        });
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
        const key = getSiteKey(changeInfo.url);
        if (key) {
            setTabKey(tabId, key);
        }

        checkAndCloseDuringCooldown(changeInfo.url, () => {
            chrome.tabs.remove(tabId, () => {
                // ignore errors
            });
        });
    }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    getKeyForTab(tabId, (key) => {
        removeTabKey(tabId, () => {
            if (!key) return;

            // If no remaining tabs for this site exist, cancel the timer/alarm.
            const urls = [`*://${key}/*`, `*://*.${key}/*`];

            chrome.tabs.query({ url: urls }, (tabs) => {
                if (!tabs.length) {
                    const alarmName = `${ALARM_NAME_BASE}_${key}`;
                    chrome.alarms.clear(alarmName);
                    clearTimerState(key);
                }
            });
        });
    });
});
