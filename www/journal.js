/* ==========================================================================
   Reading Journal — journal.js
   Plain JS, no dependencies. Pairs with journal.css.

   Setup:
     <link rel="stylesheet" href="journal.css">
     <div id="journal-root"></div>
     <script src="journal.js"></script>

   From the reader screen:
     openJournalForBook("The Overstory", 214);

   Entry schema (localStorage key "readingJournal.entries"):
     { id, bookTitle, pageNumber, date, noteType, content }
     noteType: 'quote' | 'thought' | 'inspired'
     date: ISO 8601 string
   ========================================================================== */
(function (global) {
  "use strict";

  var STORAGE_KEY = "readingJournal.entries";
  var ROOT_ID = "journal-root";

  var NOTE_TYPES = {
    quote:    { label: "Quote" },
    thought:  { label: "Thoughtful" },
    inspired: { label: "Inspired" }
  };

  // Static SVG strings (no user data), so innerHTML is safe here.
  var ICONS = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    inspired: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    thought: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h13v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-6z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3v2M12 3v2"/></svg>'
  };

  var root = null;       // screen container (may be null if only the modal is used)
  var listEl = null;
  var countEl = null;
  var overlay = null;    // modal overlay, built lazily
  var form = null;
  var editingId = null;
  var lastFocus = null;

  /* ------------------------------ Storage ------------------------------ */

  function isValid(e) {
    return e && typeof e === "object" &&
      typeof e.id === "string" &&
      typeof e.bookTitle === "string" &&
      typeof e.content === "string" &&
      typeof e.date === "string" &&
      NOTE_TYPES.hasOwnProperty(e.noteType);
  }

  function loadEntries() {
    try {
      var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter(isValid) : [];
    } catch (err) {
      return [];
    }
  }

  function saveEntries(entries) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      return true;
    } catch (err) {
      return false; // storage full or unavailable (private mode)
    }
  }

  function sortedEntries() {
    return loadEntries().sort(function (a, b) {
      return new Date(b.date) - new Date(a.date);
    });
  }

  function newId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function notifyChange() {
    document.dispatchEvent(new CustomEvent("journal:change"));
  }

  /* ------------------------------ Helpers ------------------------------ */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    var opts = { month: "long", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }

  function metaText(entry) {
    var date = formatDate(entry.date);
    var page = entry.pageNumber ? "p. " + entry.pageNumber : "";
    return [date, page].filter(Boolean).join(" \u00b7 ");
  }

  /* ------------------------------- Render ------------------------------ */

  function buildCard(entry) {
    var li = el("li");
    var card = el("button", "jn-card" + (entry.noteType === "quote" ? " jn-card--quote" : ""));
    card.type = "button";
    card.setAttribute("aria-label", "Edit entry from " + entry.bookTitle);
    card.addEventListener("click", function () { openModal({ entry: entry }); });

    var head = el("div", "jn-card-head");
    head.appendChild(el("span", "jn-book", entry.bookTitle));
    head.appendChild(el("span", "jn-meta", metaText(entry)));
    card.appendChild(head);

    card.appendChild(el("p", "jn-body", entry.content));

    if (entry.noteType !== "quote") {
      var chip = el("span", "jn-chip jn-chip--" + entry.noteType);
      chip.innerHTML = ICONS[entry.noteType]; // static string
      chip.appendChild(document.createTextNode(NOTE_TYPES[entry.noteType].label));
      card.appendChild(chip);
    }

    li.appendChild(card);
    return li;
  }

  function render() {
    if (!listEl) return;
    var entries = sortedEntries();

    countEl.textContent = entries.length + (entries.length === 1 ? " entry" : " entries");
    listEl.textContent = "";

    if (!entries.length) {
      var empty = el("li", "jn-empty", "No entries yet. Tap + to save a quote or a thought from your book.");
      listEl.appendChild(empty);
      return;
    }
    entries.forEach(function (entry) { listEl.appendChild(buildCard(entry)); });
  }

  function mountScreen(container) {
    root = container;
    root.textContent = "";
    root.classList.add("jn-screen");

    var header = el("header", "jn-header");
    header.appendChild(el("h1", "jn-title", "Journal"));
    countEl = el("p", "jn-count", "");
    countEl.setAttribute("aria-live", "polite");
    header.appendChild(countEl);

    listEl = el("ul", "jn-list");

    var fab = el("button", "jn-fab");
    fab.type = "button";
    fab.setAttribute("aria-label", "New journal entry");
    fab.innerHTML = ICONS.plus; // static string
    fab.addEventListener("click", function () { openModal(); });

    root.appendChild(header);
    root.appendChild(listEl);
    root.appendChild(fab);
    render();
  }

  /* ------------------------------- Modal ------------------------------- */

  function field(labelText, control, id) {
    var wrap = el("div", "jn-field");
    var label = el("label", "jn-label", labelText);
    label.htmlFor = id;
    control.id = id;
    wrap.appendChild(label);
    wrap.appendChild(control);
    return wrap;
  }

  function buildModal() {
    overlay = el("div", "jn-overlay");
    overlay.hidden = true;

    var modal = el("div", "jn-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "jn-modal-title");

    var title = el("h2", "jn-modal-title", "New entry");
    title.id = "jn-modal-title";

    form = el("form");
    form.noValidate = true;

    var book = el("input", "jn-input");
    book.type = "text";
    book.name = "bookTitle";
    book.autocomplete = "off";
    book.setAttribute("list", "jn-book-options");
    var bookOptions = el("datalist");
    bookOptions.id = "jn-book-options";

    var page = el("input", "jn-input");
    page.type = "number";
    page.name = "pageNumber";
    page.min = "1";
    page.step = "1";
    page.inputMode = "numeric";

    var mood = el("select", "jn-select");
    mood.name = "noteType";
    Object.keys(NOTE_TYPES).forEach(function (key) {
      var opt = el("option", null, NOTE_TYPES[key].label);
      opt.value = key;
      mood.appendChild(opt);
    });
    mood.value = "thought";

    var content = el("textarea", "jn-textarea");
    content.name = "content";
    content.rows = 5;

    var row = el("div", "jn-field-row");
    row.appendChild(field("Page number", page, "jn-page"));
    row.appendChild(field("Mood tag", mood, "jn-mood"));

    var error = el("p", "jn-error");
    error.setAttribute("role", "alert");

    var actions = el("div", "jn-actions");
    var del = el("button", "jn-btn jn-btn--danger", "Delete");
    del.type = "button";
    del.hidden = true;
    del.dataset.role = "delete";
    var cancel = el("button", "jn-btn jn-btn--ghost", "Cancel");
    cancel.type = "button";
    cancel.dataset.role = "cancel";
    var save = el("button", "jn-btn jn-btn--primary", "Save entry");
    save.type = "submit";
    actions.appendChild(del);
    actions.appendChild(cancel);
    actions.appendChild(save);

    var bookField = field("Book name", book, "jn-book-input");
    bookField.appendChild(bookOptions);

    form.appendChild(bookField);
    form.appendChild(row);
    form.appendChild(field("Note or quote", content, "jn-content"));
    form.appendChild(error);
    form.appendChild(actions);

    modal.appendChild(title);
    modal.appendChild(form);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Events
    form.addEventListener("submit", onSubmit);
    cancel.addEventListener("click", closeModal);
    del.addEventListener("click", onDelete);
    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) closeModal();
    });
    overlay.addEventListener("keydown", onModalKeydown);
    [book, content].forEach(function (input) {
      input.addEventListener("input", function () {
        input.removeAttribute("aria-invalid");
        error.textContent = "";
      });
    });
  }

  function onModalKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
      return;
    }
    if (e.key !== "Tab") return;
    // Keep focus inside the dialog.
    var focusable = overlay.querySelectorAll("input, select, textarea, button:not([hidden])");
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function refreshBookOptions() {
    var list = overlay.querySelector("#jn-book-options");
    list.textContent = "";
    var seen = {};
    loadEntries().forEach(function (e) {
      if (seen[e.bookTitle]) return;
      seen[e.bookTitle] = true;
      var opt = document.createElement("option");
      opt.value = e.bookTitle;
      list.appendChild(opt);
    });
  }

  /**
   * opts.entry     existing entry to edit
   * opts.bookTitle pre-filled book name
   * opts.page      pre-filled page number
   */
  function openModal(opts) {
    opts = opts || {};
    if (!overlay) buildModal();
    refreshBookOptions();

    var entry = opts.entry || null;
    editingId = entry ? entry.id : null;
    lastFocus = document.activeElement;

    overlay.querySelector("#jn-modal-title").textContent = entry ? "Edit entry" : "New entry";
    form.elements.bookTitle.value = entry ? entry.bookTitle : (opts.bookTitle || "");
    form.elements.pageNumber.value = entry ? (entry.pageNumber || "") : (opts.page || "");
    form.elements.noteType.value = entry ? entry.noteType : "thought";
    form.elements.content.value = entry ? entry.content : "";
    form.querySelector('[data-role="delete"]').hidden = !entry;
    form.querySelector(".jn-error").textContent = "";
    form.elements.bookTitle.removeAttribute("aria-invalid");
    form.elements.content.removeAttribute("aria-invalid");

    var wasHidden = overlay.hidden;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    if (wasHidden) document.dispatchEvent(new CustomEvent("journal:open"));

    // If the book is already known, jump straight to writing.
    var target = form.elements.bookTitle.value ? form.elements.content : form.elements.bookTitle;
    target.focus();
  }

  function closeModal() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.body.style.overflow = "";
    editingId = null;
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    document.dispatchEvent(new CustomEvent("journal:close"));
  }

  function onSubmit(e) {
    e.preventDefault();
    var errorEl = form.querySelector(".jn-error");
    var title = form.elements.bookTitle.value.trim();
    var content = form.elements.content.value.trim();
    var pageRaw = form.elements.pageNumber.value.trim();
    var page = pageRaw === "" ? null : parseInt(pageRaw, 10);

    form.elements.bookTitle.removeAttribute("aria-invalid");
    form.elements.content.removeAttribute("aria-invalid");

    var message = "";
    if (!title) {
      message = "Add the book name.";
      form.elements.bookTitle.setAttribute("aria-invalid", "true");
      form.elements.bookTitle.focus();
    } else if (page !== null && (isNaN(page) || page < 1)) {
      message = "Page number must be 1 or higher.";
      form.elements.pageNumber.focus();
    } else if (!content) {
      message = "Write a note or paste a quote.";
      form.elements.content.setAttribute("aria-invalid", "true");
      form.elements.content.focus();
    }
    if (message) {
      errorEl.textContent = message;
      return;
    }

    var entries = loadEntries();
    var noteType = form.elements.noteType.value;

    if (editingId) {
      entries = entries.map(function (item) {
        return item.id === editingId
          ? { id: item.id, bookTitle: title, pageNumber: page, date: item.date, noteType: noteType, content: content }
          : item;
      });
    } else {
      entries.push({
        id: newId(),
        bookTitle: title,
        pageNumber: page,
        date: new Date().toISOString(),
        noteType: noteType,
        content: content
      });
    }

    if (!saveEntries(entries)) {
      errorEl.textContent = "Couldn't save. Your browser storage may be full or blocked.";
      return;
    }
    closeModal();
    render();
    notifyChange();
  }

  function onDelete() {
    if (!editingId) return;
    if (!global.confirm("Delete this entry? This can't be undone.")) return;
    var remaining = loadEntries().filter(function (item) { return item.id !== editingId; });
    if (!saveEntries(remaining)) {
      form.querySelector(".jn-error").textContent = "Couldn't delete. Browser storage is unavailable.";
      return;
    }
    closeModal();
    render();
    notifyChange();
  }

  /* ----------------------------- Public API ---------------------------- */

  /**
   * Open the new-entry modal with the book (and optionally page) pre-filled.
   * Call from the reader screen: openJournalForBook("The Overstory", 214)
   */
  function openJournalForBook(bookTitle, currentPage) {
    var page = parseInt(currentPage, 10);
    openModal({
      bookTitle: bookTitle ? String(bookTitle) : "",
      page: page > 0 ? page : ""
    });
  }

  function init(container) {
    var target = container || document.getElementById(ROOT_ID);
    if (target) mountScreen(target);
  }

  global.ReadingJournal = {
    init: init,
    render: render,
    openModal: openModal,
    closeModal: closeModal,
    openJournalForBook: openJournalForBook,
    getEntries: sortedEntries
  };
  global.openJournalForBook = openJournalForBook;

  // Keep the list in sync if another tab edits the journal.
  global.addEventListener("storage", function (e) {
    if (e.key === STORAGE_KEY) render();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { init(); });
  } else {
    init();
  }
})(window);
