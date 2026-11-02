// =====================================================
//  Chatbot logic. You don't need to edit this file.
//  All the bot's personality lives in config.js.
// =====================================================

(function () {
  "use strict";

  const cfg = BOT_CONFIG;
  const KEY_NAME = "gemini_api_key";
  const THEME_NAME = "chat_theme";
  const EMBED_MODEL = "gemini-embedding-001";
  const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

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

  // Notes from knowledge.md, one per "## " section: [{ title, text }]
  let notes = [];
  let noteVectors = null;   // "meaning" search: one number-list per note
  let keywordIndex = null;  // keyword search: word counts per note
  let meaningFailed = false;

  // Which "less thinking" setting works for this model (found automatically)
  let thinkingMode = cfg.thinkingLevel ? "level" : "none";

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

  // ---------- Notes file (knowledge.md) ----------
  // Everything above the first "## " line is ignored. Each "## " section is one note.
  async function loadKnowledge() {
    if (!cfg.knowledgeFile) return;
    try {
      const res = await fetch(cfg.knowledgeFile, { cache: "no-cache" });
      if (!res.ok) return;
      const raw = await res.text();
      const start = raw.search(/^##\s/m);
      if (start === -1) return;
      notes = raw
        .slice(start)
        .split(/^##\s+/m)
        .map(function (chunk) { return chunk.trim(); })
        .filter(Boolean)
        .map(function (chunk) {
          const lines = chunk.split("\n");
          return { title: lines[0].trim(), text: lines.slice(1).join("\n").trim() };
        });
    } catch (e) {
      // Happens when opening index.html straight from disk. The bot still works without notes.
      console.warn("Could not load " + cfg.knowledgeFile + " (host the site to use it).");
    }
  }
  const knowledgeReady = loadKnowledge();

  // ---------- Search: keywords ----------
  const STOP_WORDS = new Set((
    "the and for are was were been being have has had with this that these those what which who whom why how " +
    "does did doing can could should would will you your yours our ours their them they his her its from into " +
    "about than then there here when where also just not but any all some more most very tell explain give list " +
    "show need want like know mean means please"
  ).split(" "));

  function stem(word) {
    if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
    return word;
  }

  function tokenize(text) {
    return (text.toLowerCase().match(/[a-z0-9]+/g) || [])
      .filter(function (w) { return w.length > 2 && !STOP_WORDS.has(w); })
      .map(stem);
  }

  function buildKeywordIndex() {
    const idx = { tf: [], title: [], idf: {} };
    const df = {};
    notes.forEach(function (n) {
      const counts = {};
      tokenize(n.title + " " + n.text).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
      idx.tf.push(counts);
      idx.title.push(new Set(tokenize(n.title)));
      Object.keys(counts).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
    });
    Object.keys(df).forEach(function (t) { idx.idf[t] = Math.log(1 + notes.length / df[t]); });
    return idx;
  }

  function keywordScores(query) {
    if (!keywordIndex) keywordIndex = buildKeywordIndex();
    const words = Array.from(new Set(tokenize(query)));
    return notes.map(function (note, i) {
      let score = 0;
      words.forEach(function (w) {
        const idf = keywordIndex.idf[w];
        if (!idf) return;
        score += idf * ((keywordIndex.title[i].has(w) ? 3 : 0) + Math.min(keywordIndex.tf[i][w] || 0, 3));
      });
      return { note: note, score: score };
    });
  }

  // ---------- Search: meaning (embeddings) ----------
  async function embedTexts(texts, apiKey, taskType) {
    const response = await fetch(API_BASE + EMBED_MODEL + ":batchEmbedContents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        requests: texts.map(function (t) {
          return {
            model: "models/" + EMBED_MODEL,
            content: { parts: [{ text: t }] },
            taskType: taskType,
            outputDimensionality: 768
          };
        })
      })
    });
    if (!response.ok) throw new Error("Embedding request failed (HTTP " + response.status + ")");
    const data = await response.json();
    return data.embeddings.map(function (e) { return e.values; });
  }

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  async function meaningScores(query, apiKey) {
    if (!noteVectors) {
      noteVectors = await embedTexts(
        notes.map(function (n) { return (n.title + "\n" + n.text).slice(0, 6000); }),
        apiKey,
        "RETRIEVAL_DOCUMENT"
      );
    }
    const q = (await embedTexts([query], apiKey, "RETRIEVAL_QUERY"))[0];
    return notes.map(function (note, i) { return { note: note, score: cosine(q, noteVectors[i]) }; });
  }

  // ---------- Retrieval: pick the notes to show the bot ----------
  function previousUserText() {
    for (let i = history.length - 2; i >= 0; i--) {
      if (history[i].role === "user") return history[i].parts[0].text;
    }
    return "";
  }

  async function retrieve(question, apiKey) {
    await knowledgeReady;
    if (!notes.length) return null;

    // Very short follow-ups ("what about the second one?") borrow the previous question
    let query = question;
    if (tokenize(question).length < 3) query = previousUserText() + " " + question;

    const wantKeywords = cfg.searchMethod === "keywords";
    let method = wantKeywords ? "keywords" : "meaning";
    let scored;

    if (!wantKeywords && !meaningFailed) {
      try {
        scored = await meaningScores(query, apiKey);
      } catch (e) {
        console.warn("Meaning search failed, using keywords instead:", e);
        meaningFailed = true;
      }
    }
    if (!scored) {
      scored = keywordScores(query);
      method = wantKeywords ? "keywords" : "keywords (meaning search unavailable)";
    }

    const useMeaning = method === "meaning";
    const minScore = useMeaning ? (cfg.meaningMinScore || 0.6) : (cfg.keywordMinScore || 4);
    const window_ = useMeaning ? 0.08 : null; // keep notes close to the best match

    scored.sort(function (a, b) { return b.score - a.score; });
    const top = scored[0].score;
    const hits = scored
      .filter(function (s) {
        if (s.score < minScore) return false;
        return useMeaning ? s.score >= top - window_ : s.score >= top * 0.4;
      })
      .slice(0, cfg.topK || 3);

    const closest = scored.find(function (s) { return hits.indexOf(s) === -1; });

    function pack(s) {
      return { title: s.note.title, text: s.note.text, score: s.score };
    }
    return { method: method, hits: hits.map(pack), closest: closest ? pack(closest) : null };
  }

  // ---------- Build the instructions sent with each question ----------
  function buildSystemText(retrieved) {
    let text = cfg.systemInstructions;
    if (!retrieved) return text;

    if (retrieved.hits.length) {
      text +=
        "\n\nRELEVANT NOTES (found for this question; each begins with its title):\n" +
        retrieved.hits.map(function (h) { return "NOTE: " + h.title + "\n" + h.text; }).join("\n\n") +
        "\n\nWhen you use a note, name it at the end of your reply like this: (From my notes: note title). " +
        "Only name notes you actually used.";
    } else {
      text +=
        "\n\nRELEVANT NOTES: none were found for this question. If the user is asking a communication, " +
        "public speaking, or presentation course question, start your reply with \"I couldn't find that in my notes\" " +
        "and then give brief general help, clearly labeled as not coming from the notes. For personal, " +
        "relationship, or other advice questions, just answer normally and do not mention notes.";
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

  // The AI sometimes writes math in LaTeX ($x = 5$, \times, \frac{a}{b}).
  // This turns it into plain readable text. Dollar amounts like "$5 and $10" are left alone.
  function cleanMath(text) {
    function looksLikeMath(s) {
      return /[\\^_=<>{}+*\/]/.test(s) || /^[A-Za-z]$/.test(s) || /\d\s*-\s*\d/.test(s);
    }
    return text
      .replace(/\$\$([\s\S]+?)\$\$/g, "$1")
      .replace(/\\\[([\s\S]+?)\\\]/g, "$1")
      .replace(/\\\(([\s\S]+?)\\\)/g, "$1")
      .replace(/\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, function (match, inner) {
        return looksLikeMath(inner) ? inner : match;
      })
      .replace(/\\text\{([^}]*)\}/g, "$1")
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)")
      .replace(/\\sqrt\{([^{}]*)\}/g, "√($1)")
      .replace(/\\times(?![a-zA-Z])/g, "×")
      .replace(/\\div(?![a-zA-Z])/g, "÷")
      .replace(/\\cdot(?![a-zA-Z])/g, "·")
      .replace(/\\pm(?![a-zA-Z])/g, "±")
      .replace(/\\leq?(?![a-zA-Z])/g, "≤")
      .replace(/\\geq?(?![a-zA-Z])/g, "≥")
      .replace(/\\neq?(?![a-zA-Z])/g, "≠")
      .replace(/\\approx(?![a-zA-Z])/g, "≈")
      .replace(/\\pi(?![a-zA-Z])/g, "π")
      .replace(/\\(left|right)(?![a-zA-Z])/g, "")
      .replace(/\\%/g, "%")
      .replace(/\\[,;! ]/g, " ")
      .replace(/\^2(?![0-9])/g, "²")
      .replace(/\^3(?![0-9])/g, "³");
  }

  function formatText(text) {
    const lines = cleanMath(text).replace(/\r/g, "").split("\n");
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

  // "Sources" box under a bot reply: which notes were found, and how well they matched
  function addSources(retrieved) {
    if (!retrieved) return;
    const useMeaning = retrieved.method === "meaning";
    const fmt = function (n) { return useMeaning ? n.toFixed(2) : n.toFixed(1); };

    let html = "<summary>Sources (" + retrieved.hits.length + ")</summary>";
    if (retrieved.hits.length) {
      html += "<ol>" + retrieved.hits.map(function (h) {
        return "<li>" + escapeHtml(h.title) + " <span class=\"score\">score " + fmt(h.score) + "</span></li>";
      }).join("") + "</ol>";
    } else {
      html += "<p>No note matched this question well enough.</p>";
    }
    if (retrieved.closest) {
      html += "<p class=\"score\">Closest miss: " + escapeHtml(retrieved.closest.title) +
        " (score " + fmt(retrieved.closest.score) + ")</p>";
    }
    html += "<p class=\"score\">Search method: " + escapeHtml(retrieved.method) + "</p>";

    const box = document.createElement("details");
    box.className = "sources";
    box.innerHTML = html;
    messagesEl.appendChild(box);
    scrollToBottom();
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

  // ---------- Talk to Gemini (streaming: text appears as it is written) ----------
  async function askGemini(apiKey, onText, retrieved) {
    const url = API_BASE + encodeURIComponent(cfg.model) + ":streamGenerateContent?alt=sse";

    // Only send the most recent messages so long chats don't slow things down
    function recentHistory() {
      const max = cfg.maxHistoryMessages || 20;
      let recent = history.slice(-max);
      while (recent.length && recent[0].role !== "user") recent = recent.slice(1);
      return recent;
    }

    // mode: "level" (newer models), "budget" (Gemini 2.5 models), or "none"
    function sendRequest(mode) {
      const payload = {
        systemInstruction: { parts: [{ text: buildSystemText(retrieved) }] },
        contents: recentHistory()
      };
      if (mode === "level") {
        payload.generationConfig = {
          thinkingConfig: { thinkingLevel: String(cfg.thinkingLevel).toUpperCase() }
        };
      } else if (mode === "budget") {
        payload.generationConfig = { thinkingConfig: { thinkingBudget: 0 } };
      }
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(payload)
      });
    }

    async function errorDetail(res) {
      try {
        const body = await res.clone().json();
        return (body && body.error && body.error.message) || "";
      } catch (e) { return ""; }
    }

    // Try the fastest setting first. If the model rejects it, fall back and
    // remember what worked so later messages don't repeat the failed attempt.
    let response = await sendRequest(thinkingMode);
    while (!response.ok && response.status === 400 && thinkingMode !== "none") {
      const detail = await errorDetail(response);
      if (/api key/i.test(detail)) break; // a real key problem, not a thinking problem
      thinkingMode = thinkingMode === "level" ? "budget" : "none";
      response = await sendRequest(thinkingMode);
    }

    if (!response.ok) {
      const detail = await errorDetail(response);
      const err = new Error("HTTP " + response.status);
      err.status = response.status;
      err.keyProblem =
        response.status === 401 ||
        response.status === 403 ||
        (response.status === 400 && /api key/i.test(detail));
      throw err;
    }

    // ----- Read the stream of events -----
    let fullText = "";
    let blocked = false;

    function handleLine(line) {
      line = line.trim();
      if (line.indexOf("data:") !== 0) return;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") return;

      let data;
      try { data = JSON.parse(json); } catch (e) { return; }

      if (data.promptFeedback && data.promptFeedback.blockReason) blocked = true;

      const candidate = data.candidates && data.candidates[0];
      if (candidate && candidate.finishReason === "SAFETY") blocked = true;

      const parts = candidate && candidate.content ? candidate.content.parts || [] : [];
      parts.forEach(function (p) {
        if (!p.thought && typeof p.text === "string") fullText += p.text;
      });
      if (fullText.trim()) onText(fullText.trim());
    }

    if (response.body && response.body.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep the unfinished line for next time
        lines.forEach(handleLine);
      }
      buffer += decoder.decode();
      if (buffer) buffer.split("\n").forEach(handleLine);
    } else {
      // Browser can't stream: read everything at once
      (await response.text()).split("\n").forEach(handleLine);
    }

    const finalText = fullText.trim();
    if (finalText) return finalText;
    if (blocked) return BLOCKED_REPLY;
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

    let botBubble = null;

    try {
      // Find the notes that match this question (never blocks the chat if it fails)
      let retrieved = null;
      try {
        retrieved = await retrieve(text, apiKey);
      } catch (e) {
        console.warn("Note search failed:", e);
      }

      const reply = await askGemini(apiKey, function (partial) {
        if (!botBubble) {
          hideThinking();
          botBubble = addBubble("bot", partial);
        } else {
          botBubble.innerHTML = formatText(partial);
          scrollToBottom();
        }
      }, retrieved);

      hideThinking();
      if (botBubble) {
        botBubble.innerHTML = formatText(reply);
        scrollToBottom();
      } else {
        addBubble("bot", reply);
      }
      history.push({ role: "model", parts: [{ text: reply }] });
      addSources(retrieved);
    } catch (err) {
      hideThinking();
      if (botBubble) botBubble.remove(); // drop a half-finished reply
      history.pop(); // remove the failed question so history stays clean
      if (err && err.status) {
        addBubble("error", friendlyError(err));
        if (err.keyProblem) openKeyModal();
      } else {
        console.error("Chat request failed:", err);
        const why = err && err.message ? " (" + err.name + ": " + err.message + ")" : "";
        addBubble("error", "I couldn't reach Google" + why + ". Check your connection, your API key, and any ad blocker or school network filter, then try again.");
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
    // Remove any spaces or line breaks picked up while copying
    const key = keyInput.value.replace(/\s+/g, "");
    if (!key) { keyInput.focus(); return; }
    if (!/^[\x21-\x7E]+$/.test(key)) {
      alert("That key has a character that isn't allowed. Copy it again straight from aistudio.google.com/apikey.");
      keyInput.focus();
      return;
    }
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
