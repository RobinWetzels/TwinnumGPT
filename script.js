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
  let knowledgeText = "";

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
  // Accepts PrimaryColor (new) or themeColor (old); falls back if missing or invalid.
  function pickThemeColor() {
    const c = cfg.PrimaryColor || cfg.themeColor || "";
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c).trim()) ? String(c).trim() : "#D6336C";
  }
  const themeColor = pickThemeColor();

  document.title = cfg.name + " " + cfg.emoji;
  $("botTitle").textContent = cfg.name + " " + cfg.emoji;
  $("botTagline").textContent = cfg.tagline;
  document.documentElement.style.setProperty("--accent", themeColor);

  // Pick white or black text depending on how bright the theme color is
  function textColorFor(hex) {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness > 160 ? "#111111" : "#ffffff";
  }
  document.documentElement.style.setProperty("--accent-text", textColorFor(themeColor));

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

  // ---------- Knowledge file (optional notes for the bot) ----------
  // Everything above the first "## " line is ignored.
  async function loadKnowledge() {
    if (!cfg.knowledgeFile) return;
    try {
      const res = await fetch(cfg.knowledgeFile, { cache: "no-cache" });
      if (!res.ok) return;
      const raw = await res.text();
      const start = raw.search(/^##\s/m);
      if (start === -1) return;
      knowledgeText = raw.slice(start).trim();
    } catch (e) {
      // Happens when opening index.html straight from disk. The bot still works without it.
      console.warn("Could not load " + cfg.knowledgeFile + " (host the site to use it).");
    }
  }
  const knowledgeReady = loadKnowledge();

  function buildSystemText() {
    let text = cfg.systemInstructions;
    if (knowledgeText) {
      text +=
        "\n\nREFERENCE NOTES (use only when relevant to the user's question):\n" +
        knowledgeText;
    }
    return text;
  }

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
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(?!\s)([^*]+?)\*/g, "<em>$1</em>");
  }

  function formatText(text) {
    const lines = text.replace(/\r/g, "").split("\n");
    let html = "";
    let listType = null; // "ul", "ol", or null

    function closeList() {
      if (listType) { html += "</" + listType + ">"; listType = null; }
    }

    lines.forEach(function (line) {
      const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

      if (heading) {
        closeList();
        html += "<p><strong>" + inlineFormat(heading[1]) + "</strong></p>";
      } else if (bullet) {
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
  function friendlyError(err) {
    const status = err.status;
    if (err.keyProblem) {
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

  // Shown if Google's filters block a message or reply. Kept caring on purpose,
  // since heavy personal topics are the most likely to trip a filter.
  const BLOCKED_REPLY =
    "That one tripped a filter on my end, so I can't answer it properly. " +
    "If you're going through something heavy or you don't feel safe, please call or text 988 (US) " +
    "or reach out to someone you trust. Otherwise, try rewording it and I'm right here.";

  // ---------- Talk to Gemini ----------
  async function askGemini(apiKey) {
    await knowledgeReady;

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
        systemInstruction: { parts: [{ text: buildSystemText() }] },
        contents: history
      })
    });

    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = (body && body.error && body.error.message) || "";
      } catch (e) { /* no readable body */ }

      const err = new Error("HTTP " + response.status);
      err.status = response.status;
      err.keyProblem =
        response.status === 401 ||
        response.status === 403 ||
        (response.status === 400 && /api key/i.test(detail));
      throw err;
    }

    const data = await response.json();

    if (data.promptFeedback && data.promptFeedback.blockReason) {
      return BLOCKED_REPLY;
    }

    const candidate = data.candidates && data.candidates[0];
    const parts = candidate && candidate.content ? candidate.content.parts || [] : [];

    // Join the text parts and skip any "thought" parts
    const text = parts
      .filter(function (p) { return !p.thought && typeof p.text === "string"; })
      .map(function (p) { return p.text; })
      .join("")
      .trim();

    if (text) return text;
    if (candidate && candidate.finishReason === "SAFETY") return BLOCKED_REPLY;
    return "I couldn't come up with a reply that time. Try asking again.";
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
        addBubble("error", friendlyError(err));
        if (err.keyProblem) openKeyModal();
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
    (cfg.starterQuestions || []).forEach(function (q) {
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
