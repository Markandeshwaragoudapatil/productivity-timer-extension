const timerEl = document.getElementById("timer");
const statusEl = document.getElementById("status");
const siteEl = document.getElementById("site");
const progressBar = document.getElementById("progressBar");
const startBtn = document.getElementById("start");
const resetBtn = document.getElementById("reset");

let countdownInterval = null;
let currentMode = "reset"; // reset | running | paused

function setStatus(text) {
    statusEl.textContent = text;
}

function setSite(text) {
    siteEl.textContent = text;
}

function setProgress(percent) {
    progressBar.style.width = `${percent}%`;
}

function setMode(mode) {
    currentMode = mode;

    if (mode === "running") {
        startBtn.textContent = "Stop";
        startBtn.classList.add("danger");
        startBtn.classList.remove("primary");
        resetBtn.style.display = "inline-flex";
    } else if (mode === "paused") {
        startBtn.textContent = "Resume";
        startBtn.classList.add("primary");
        startBtn.classList.remove("danger");
        resetBtn.style.display = "inline-flex";
    } else {
        // reset
        startBtn.textContent = "Start";
        startBtn.classList.add("primary");
        startBtn.classList.remove("danger");
        resetBtn.style.display = "none";
    }
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
        setProgress(0);
        setMode("reset");
        return;
    }

    const remaining = endTime - Date.now();
    if (remaining <= 0) {
        timerEl.textContent = "Time's up!";
        setProgress(100);
        setMode("reset");
        if (!hasPlayedSound) {
            playBeep();
            hasPlayedSound = true;
        }
        return;
    }

    const total = 15_000; // match timer duration in background
    const percent = Math.min(100, Math.max(0, (1 - remaining / total) * 100));
    setProgress(percent);

    timerEl.textContent = `Running: ${formatTime(remaining)}`;
    setMode("running");
}

function startCountdown(endTime) {
    clearInterval(countdownInterval);

    updateTimerDisplay(endTime);

    countdownInterval = setInterval(() => {
        const remaining = endTime - Date.now();
        if (remaining <= 0) {
            clearInterval(countdownInterval);
            timerEl.textContent = "Time's up!";
            setMode("reset");
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
        setSite(key || "—");

        if (!key) {
            timerEl.textContent = "Stopped";
            setStatus("No known site");
            setProgress(0);
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

            if (response && response.status === "paused") {
                clearInterval(countdownInterval);
                setMode("paused");
                const remaining = response.remaining || 0;
                timerEl.textContent = `Paused: ${formatTime(remaining)}`;
                setProgress((1 - remaining / 15000) * 100);
                localStorage.removeItem(`productivityTimerEnd_${key}`);
                setStatus(`Timer paused (${key})`);
                return;
            }

            if (response && response.status === "running" && response.endTime) {
                startCountdown(response.endTime);
                setStatus(`Timer running (${key})`);
                return;
            }

            timerEl.textContent = "Stopped";
            setStatus("");
        });
    });
}

function sendMessage(action) {
    withActiveTab((key, url) => {
        if (!key) {
            setStatus("No known site");
            setSite("—");
            return;
        }

        setSite(key);

        chrome.runtime.sendMessage({ action, siteKey: key }, (response) => {
            if (chrome.runtime.lastError) {
                setStatus("Error: " + chrome.runtime.lastError.message);
                return;
            }

            if (response && response.status) {
                setStatus("Timer: " + response.status);
            }

            if (response && response.status === "paused") {
                clearInterval(countdownInterval);
                setMode("paused");
                const remaining = response.remaining || 0;
                timerEl.textContent = `Paused: ${formatTime(remaining)}`;
                setProgress((1 - remaining / 15000) * 100);
                localStorage.removeItem(`productivityTimerEnd_${key}`);
                return;
            }

            if (response && response.endTime) {
                if (action === "resumeTimer" || action === "startTimer") {
                    startCountdown(response.endTime);
                    localStorage.setItem(`productivityTimerEnd_${key}`, response.endTime);
                }
            }
        });
    });
}

startBtn.addEventListener("click", () => {
    if (currentMode === "running") {
        sendMessage("pauseTimer");
        return;
    }

    if (currentMode === "paused") {
        sendMessage("resumeTimer");
        return;
    }

    // reset state
    sendMessage("startTimer");
});

resetBtn.addEventListener("click", () => {
    withActiveTab((key) => {
        if (!key) {
            setStatus("No known site");
            return;
        }

        sendMessage("resetTimer");
        clearInterval(countdownInterval);
        timerEl.textContent = "Stopped";
        setMode("reset");
        localStorage.removeItem(`productivityTimerEnd_${key}`);
    });
});

queryEndTime();
