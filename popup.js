const timerEl = document.getElementById("timer");
const statusEl = document.createElement("div");
statusEl.id = "status";
document.body.appendChild(statusEl);

let countdownInterval = null;

function setStatus(text) {
    statusEl.textContent = text;
}

function formatTime(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60);
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

let hasPlayedSound = false;

function playBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();

        oscillator.type = "sine";
        oscillator.frequency.value = 880;
        gain.gain.value = 0.25;

        oscillator.connect(gain);
        gain.connect(ctx.destination);

        oscillator.start();
        setTimeout(() => {
            oscillator.stop();
            ctx.close();
        }, 200);
    } catch (e) {
        // If audio is blocked, just ignore.
        console.warn("Beep playback failed", e);
    }
}

function updateTimerDisplay(endTime) {
    if (!endTime) {
        timerEl.textContent = "Stopped";
        return;
    }

    const remaining = endTime - Date.now();
    if (remaining <= 0) {
        timerEl.textContent = "Time's up!";
        if (!hasPlayedSound) {
            playBeep();
            hasPlayedSound = true;
        }
        return;
    }

    timerEl.textContent = `Running: ${formatTime(remaining)}`;
}

function startCountdown(endTime) {
    clearInterval(countdownInterval);

    updateTimerDisplay(endTime);

    countdownInterval = setInterval(() => {
        const remaining = endTime - Date.now();
        if (remaining <= 0) {
            clearInterval(countdownInterval);
            timerEl.textContent = "Time's up!";
            return;
        }
        updateTimerDisplay(endTime);
    }, 250);
}

function getSiteKeyFromUrl(url) {
    if (!url) return null;
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith("youtube.com")) return "youtube";
    if (host.endsWith("instagram.com")) return "instagram";
    if (host.endsWith("facebook.com")) return "facebook";
    return null;
}

function withActiveTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) {
            callback(null, null);
            return;
        }
        const key = getSiteKeyFromUrl(tab.url);
        callback(key, tab.url);
    });
}

function queryEndTime() {
    withActiveTab((key, url) => {
        if (!key) {
            timerEl.textContent = "Stopped";
            setStatus("No known site");
            return;
        }

        const stored = localStorage.getItem(`productivityTimerEnd_${key}`);
        const storedEnd = stored ? Number(stored) : null;
        if (storedEnd && storedEnd > Date.now()) {
            startCountdown(storedEnd);
            setStatus(`Timer running (${key})`);
            return;
        }

        chrome.runtime.sendMessage({ action: "getEndTime", siteKey: key }, (response) => {
            if (chrome.runtime.lastError) {
                setStatus("Error: " + chrome.runtime.lastError.message);
                timerEl.textContent = "Stopped";
                return;
            }

            if (response && response.endTime) {
                startCountdown(response.endTime);
                setStatus(`Timer running (${key})`);
            } else {
                timerEl.textContent = "Stopped";
                setStatus("");
            }
        });
    });
}

function sendMessage(action) {
    withActiveTab((key, url) => {
        if (!key) {
            setStatus("No known site");
            return;
        }

        chrome.runtime.sendMessage({ action, siteKey: key }, (response) => {
            if (chrome.runtime.lastError) {
                setStatus("Error: " + chrome.runtime.lastError.message);
                return;
            }

            if (response && response.status) {
                setStatus("Timer: " + response.status);
            }

            if (response && response.endTime) {
                startCountdown(response.endTime);
                localStorage.setItem(`productivityTimerEnd_${key}`, response.endTime);
            }
        });
    });
}

document.getElementById("start").addEventListener("click", () => {
    sendMessage("startTimer");
});

document.getElementById("reset").addEventListener("click", () => {
    withActiveTab((key) => {
        if (!key) {
            setStatus("No known site");
            return;
        }

        sendMessage("resetTimer");
        clearInterval(countdownInterval);
        timerEl.textContent = "Stopped";
        localStorage.removeItem(`productivityTimerEnd_${key}`);
    });
});

queryEndTime();
