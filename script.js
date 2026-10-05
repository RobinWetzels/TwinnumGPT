// =====================================================
//  Chatbot logic. You don't need to edit this file.
//  All the bot's personality lives in config.js.
// =====================================================

(function () {
  "use strict";

  const cfg = BOT_CONFIG;
  const KEY_NAME = "gemini_api_key";
  const THEME_NAME = "chat_theme";

  // ---------- Grab page elements ----------
  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const startersEl = $("starters");
  const formEl = $("chatForm");
  const inputEl = $("input");
  const sendBtn = $("sendBtn");
  const keyModal = $("keyModal");
  const keyInput = $("keyInput");
  const rememberBox = $("rememberBox");

  // Conversation history sent to Gemini: [{ role: "user"|"model", parts: [{text}] }]
  let history = [];
  let waiting = false;

  // ---------- Safe storage helpers (never crash if blocked) ----------
  function storageGet(store, name) {
    try { return window[store].getItem(name); } catch (e) { return null; }
  }
  function storageSet(store, name, value) {
    try { window[store].setItem(name, value); } catch (e) { /* ignore */ }
  }
  function storageRemove(store, name) {
    try { window[store].removeItem(name); } catch (e) { /* ignore */ }
  }

  function getApiKey() {
    return storageGet("sessionStorage", KEY_NAME) || storageGet("localStorage", KEY_NAME) || "";
  }

  // ---------- Setup page from config ----------
  document.title = cfg.name + " " + cfg.emoji;
  $("botTitle").textContent = cfg.name + " " + cfg.emoji;
  $("botTagline").textContent = cfg.tagline;
  document.documentElement.style.setProperty("--accent", cfg.themeColor);

  // Pick white or black text depending on how bright the theme color is
  function textColorFor(hex) {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(full.substr(0, 2), 16);
    const g = parseInt(full.substr(2, 2), 16);
    const b = parseInt(full.substr(4, 2), 16);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness > 160 ? "#111111" : "#ffffff";
  }
  document.documentElement.style.setProperty("--accent-text", textColorFor(cfg.themeColor));

  // ---------- Dark mode ----------
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
  }
  const savedTheme = storageGet("localStorage", THEME_NAME);
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(savedTheme || (prefersDark ? "dark" : "light"));

  $("themeBtn").addEventListener("click", function () {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
    storageSet("localStorage", THEME_NAME, next);
  });

  // ---------- Safe text formatting (escape HTML FIRST) ----------
  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function inlineFormat(text) {
    return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  function formatText(text) {
    const lines = text.replace(/\r/g, "").split("\n");
    let html = "";
    let listType = null; // "ul", "ol", or null

    function closeList() {
      if (listType) { html += "</" + listType + ">"; listType = null; }
    }

    lines.forEach(function (line) {
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

      if (bullet) {
        if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
        html += "<li>" + inlineFormat(bullet[1]) + "</li>";
      } else if (numbered) {
        if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
        html += "<li>" + inlineFormat(numbered[1]) + "</li>";
      } else if (line.trim() === "") {
        closeList();
      } else {
        closeList();
        html += "<p>" + inlineFormat(line) + "</p>";
      }
    });
    closeList();
    return html;
  }

  // ---------- Chat bubbles ----------
  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addBubble(kind, text) {
    const div = document.createElement("div");
    div.className = "bubble " + kind;
    if (kind === "user") {
      div.textContent = text; // user text is never treated as HTML
    } else {
      div.innerHTML = formatText(text); // escaped first, then formatted
    }
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  function showThinking() {
    const div = document.createElement("div");
    div.className = "bubble bot typing";
    div.id = "thinking";
    div.innerHTML = "<span></span><span></span><span></span>";
    messagesEl.appendChild(div);
    scrollToBottom();
  }
  function hideThinking() {
    const el = $("thinking");
    if (el) el.remove();
  }

  // ---------- Friendly error messages ----------
  function friendlyError(status) {
    if (status === 400 || status === 403) {
      return "Hmm, Google didn't accept your API key. Click the \"API key\" button and paste a valid key.";
    }
    if (status === 404) {
      return "That model name wasn't found. Open config.js and check the \"model\" setting.";
    }
    if (status === 429) {
      return "Too many requests right now (rate limit). Wait a minute and try again.";
    }
    if (status >= 500) {
      return "Google's servers are having trouble right now. Try again in a bit.";
    }
    return "Something went wrong (error " + status + "). Please try again.";
  }

  // ---------- Talk to Gemini ----------
  async function askGemini(apiKey) {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(cfg.model) +
      ":generateContent";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: cfg.systemInstructions }] },
        contents: history
      })
    });

    if (!response.ok) {
      const err = new Error("HTTP " + response.status);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();

    if (data.promptFeedback && data.promptFeedback.blockReason) {
      return "I can't help with that one. Want to ask me something else?";
    }

    const parts =
      data.candidates && data.candidates[0] && data.candidates[0].content
        ? data.candidates[0].content.parts || []
        : [];

    // Join the text parts and skip any "thought" parts
    const text = parts
      .filter(function (p) { return !p.thought && typeof p.text === "string"; })
      .map(function (p) { return p.text; })
      .join("");

    return text.trim() || "I couldn't come up with a reply that time. Try asking again.";
  }

  // ---------- Sending a message ----------
  async function sendMessage(text) {
    text = text.trim();
    if (!text || waiting) return;

    const apiKey = getApiKey();
    if (!apiKey) {
      openKeyModal();
      return;
    }

    startersEl.innerHTML = "";
    addBubble("user", text);
    history.push({ role: "user", parts: [{ text: text }] });

    inputEl.value = "";
    autoGrow();
    setWaiting(true);
    showThinking();

    try {
      const reply = await askGemini(apiKey);
      hideThinking();
      history.push({ role: "model", parts: [{ text: reply }] });
      addBubble("bot", reply);
    } catch (err) {
      hideThinking();
      history.pop(); // remove the failed question so history stays clean
      if (err && err.status) {
        addBubble("error", friendlyError(err.status));
        if (err.status === 400 || err.status === 403) openKeyModal();
      } else {
        addBubble("error", "Can't reach the internet right now. Check your connection and try again.");
      }
      inputEl.value = text; // put their message back so they can resend
      autoGrow();
    } finally {
      setWaiting(false);
      inputEl.focus();
    }
  }

  function setWaiting(state) {
    waiting = state;
    sendBtn.disabled = state;
  }

  // ---------- Starting / resetting a chat ----------
  function renderStarters() {
    startersEl.innerHTML = "";
    cfg.starterQuestions.forEach(function (q) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = q;
      btn.addEventListener("click", function () { sendMessage(q); });
      startersEl.appendChild(btn);
    });
  }

  function startChat() {
    history = [];
    messagesEl.innerHTML = "";
    addBubble("bot", cfg.welcomeMessage);
    renderStarters();
  }

  $("newChatBtn").addEventListener("click", function () {
    if (waiting) return;
    startChat();
  });

  // ---------- Input box behavior ----------
  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
  }
  inputEl.addEventListener("input", autoGrow);

  // Enter = send, Shift+Enter = new line
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });

  formEl.addEventListener("submit", function (e) {
    e.preventDefault();
    sendMessage(inputEl.value);
  });

  // ---------- API key pop-up ----------
  function openKeyModal() {
    keyInput.value = "";
    rememberBox.checked = !!storageGet("localStorage", KEY_NAME);
    keyModal.hidden = false;
    keyInput.focus();
  }
  function closeKeyModal() {
    keyModal.hidden = true;
    keyInput.value = "";
  }

  $("keyBtn").addEventListener("click", openKeyModal);
  $("keyCancel").addEventListener("click", closeKeyModal);

  $("keySave").addEventListener("click", function () {
    const key = keyInput.value.trim();
    if (!key) { keyInput.focus(); return; }
    storageSet("sessionStorage", KEY_NAME, key);
    if (rememberBox.checked) {
      storageSet("localStorage", KEY_NAME, key);
    } else {
      storageRemove("localStorage", KEY_NAME);
    }
    closeKeyModal();
  });

  $("keyClear").addEventListener("click", function () {
    storageRemove("sessionStorage", KEY_NAME);
    storageRemove("localStorage", KEY_NAME);
    closeKeyModal();
  });

  keyModal.addEventListener("click", function (e) {
    if (e.target === keyModal) closeKeyModal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !keyModal.hidden) closeKeyModal();
  });

  // ---------- Go! ----------
  startChat();
})();
