/**
 * ============================================================================
 *  YORVIQUE — FRONT-END APPLICATION
 * ----------------------------------------------------------------------------
 *  Handles:
 *    - Brand asset resolution (favicon, logo, etc.) from brand-config.js
 *    - Mobile menu toggle + reveal-on-scroll animations
 *    - Give a Dankiie button (no-op when DANKIIE_URL is empty)
 *    - Drag-and-drop and file-picker upload
 *    - Real upload progress via XMLHttpRequest (when supported by the server)
 *    - Shareable link display, copy-to-clipboard, open, reset
 *    - Post-success "Give a Dankiie" support popup (5s countdown, 7-day cooldown)
 *    - Service worker registration (PWA)
 *    - Online/offline detection
 *    - Footer year stamp
 *  This file is framework-free vanilla JavaScript. It depends on
 *  /config/brand-config.js being loaded first.
 * ============================================================================
 */
(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // 0. Helpers
  // --------------------------------------------------------------------------
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const cfg = window.YORVIQUE_CONFIG || {};
  const STORAGE = cfg.storage || {};
  const MAX_FILE_SIZE = STORAGE.maxFileSizeBytes || (100 * 1024 * 1024);
  const UPLOAD_ENDPOINT = STORAGE.uploadEndpoint || '/api/upload';

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const val = bytes / Math.pow(k, i);
    return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function getExtension(name) {
    const dot = name.lastIndexOf('.');
    if (dot < 0 || dot === name.length - 1) return '';
    return name.slice(dot + 1).toUpperCase();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showToast(message, kind) {
    const toast = $('[data-toast]');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('error', 'success');
    if (kind) toast.classList.add(kind);
    toast.classList.add('is-visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      toast.classList.remove('is-visible');
    }, 3600);
  }

  // --------------------------------------------------------------------------
  // 1. Brand asset resolution
  //    The HTML already references local paths directly for the first paint
  //    (so favicons work even before JS runs). Here we patch the logo <img>
  //    source from brand-config so the config is the single source of truth.
  // --------------------------------------------------------------------------
  function applyBrandAssets() {
    const assets = cfg.assets || {};
    $$('[data-brand-asset="logo"]').forEach(function (img) {
      if (assets.logo && assets.logo.local) {
        // Already set in HTML to /yorvique.png. Keep it as-is unless overridden.
        if (img.getAttribute('src') !== assets.logo.local) {
          img.setAttribute('src', assets.logo.local);
        }
        if (assets.logo.alt) img.setAttribute('alt', assets.logo.alt);
      }
    });
    // Set the document title from the config (consistent across pages).
    if (cfg.brand && cfg.brand.name && document.title.indexOf(cfg.brand.name) === -1) {
      // Only modify if for some reason the brand name is missing.
    }
    // Footer year stamp
    $$('[data-year]').forEach(function (el) {
      el.textContent = String(cfg.brand && cfg.brand.copyrightYear || new Date().getFullYear());
    });
  }

  // --------------------------------------------------------------------------
  // 2. Mobile menu + reveal-on-scroll
  // --------------------------------------------------------------------------
  function initNavigation() {
    const toggle = $('[data-menu-toggle]');
    const nav = $('[data-nav]');
    if (toggle && nav) {
      toggle.addEventListener('click', function () {
        const open = nav.classList.toggle('is-open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      // Close menu when a link is clicked (mobile)
      $$('a', nav).forEach(function (a) {
        a.addEventListener('click', function () {
          nav.classList.remove('is-open');
          toggle.setAttribute('aria-expanded', 'false');
        });
      });
    }
  }

  function initReveal() {
    const revealEls = $$('[data-reveal]');
    // Always reveal immediately if there is nothing to observe or IO is missing.
    if (!('IntersectionObserver' in window) || revealEls.length === 0) {
      revealEls.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px 0px 0px', threshold: 0.01 });
    revealEls.forEach(function (el) { io.observe(el); });
    // Safety-net: if any element is still hidden after 2.5s (e.g. it never
    // entered the viewport because the page is short, or the observer failed
    // to fire), force it visible. Content should never stay invisible.
    setTimeout(function () {
      revealEls.forEach(function (el) { el.classList.add('is-visible'); });
    }, 2500);
  }

  // --------------------------------------------------------------------------
  // 3. Give a Dankiie buttons (header + footer entry points)
  //    While DANKIIE_URL is empty, the buttons do nothing.
  //    When a real URL is provided, the buttons become external links.
  // --------------------------------------------------------------------------
  function initGiveADankiie() {
    const url = (cfg.DANKIIE_URL || '').trim();
    $$('[data-dankiie-button]').forEach(function (btn) {
      btn.addEventListener('click', function (event) {
        if (!url) {
          // Intentionally do nothing — no navigation, no popup, no error.
          event.preventDefault();
          return;
        }
        event.preventDefault();
        window.open(url, '_blank', 'noopener,noreferrer');
      });
    });
  }

  // --------------------------------------------------------------------------
  // 3b. Give a Dankiie — post-success support popup
  //     Returns { show } where show() is called ONLY after a genuinely
  //     successful link generation. The popup honours a 7-day localStorage
  //     cooldown, runs a 5-second countdown line, hides the close button until
  //     the countdown elapses, and is always dismissible via Escape.
  // --------------------------------------------------------------------------
  var DANKIIE_DISMISS_KEY = 'yorvique_dankiie_dismissed_at';
  var DANKIIE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  var DANKIIE_COUNTDOWN_MS = 5000;
  var dankiieState = { node: null, timers: [], shownThisSession: false };

  function dankiieOnCooldown() {
    try {
      var ts = parseInt(window.localStorage.getItem(DANKIIE_DISMISS_KEY) || '0', 10);
      if (!ts) return false;
      return (Date.now() - ts) < DANKIIE_COOLDOWN_MS;
    } catch (e) {
      return false;
    }
  }

  function dankiieMarkDismissed() {
    try {
      window.localStorage.setItem(DANKIIE_DISMISS_KEY, String(Date.now()));
    } catch (e) { /* localStorage unavailable — session guard still works */ }
  }

  function dankiieClearTimers() {
    dankiieState.timers.forEach(function (t) { clearTimeout(t); });
    dankiieState.timers = [];
  }

  function dankiieClosePopup() {
    var overlay = dankiieState.node;
    if (!overlay) return;
    dankiieClearTimers();
    overlay.classList.remove('is-visible');
    // Wait for the exit transition before removing from the DOM.
    setTimeout(function () {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (dankiieState.node === overlay) dankiieState.node = null;
    }, 280);
  }

  function dankiieShowPopup() {
    // Already showing, already shown this session, or on cooldown → skip.
    if (dankiieState.node) return;
    if (dankiieState.shownThisSession) return;
    if (dankiieOnCooldown()) return;

    var url = (cfg.DANKIIE_URL || '').trim();

    // Build the popup DOM. Injected here (not in the HTML) so it never
    // touches unrelated page layouts and only exists when needed.
    var overlay = document.createElement('div');
    overlay.className = 'dankiie-overlay';
    overlay.setAttribute('data-dankiie-overlay', '');
    overlay.setAttribute('aria-hidden', 'true');

    // Tip-jar SVG (shared with the buttons — no emojis).
    var jarSvg =
      '<svg class="dankiie-icon-shake" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 6h8"/><path d="M9 6V4h6v2"/>' +
      '<path d="M8 6h8v12a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V6z"/>' +
      '<circle cx="12" cy="13" r="2.5"/></svg>';

    overlay.innerHTML =
      '<div class="dankiie-popup" role="dialog" aria-modal="true" ' +
      'aria-labelledby="dankiie-title" aria-describedby="dankiie-desc">' +
        '<button type="button" class="dankiie-close" data-dankiie-close ' +
          'aria-label="Close" hidden></button>' +
        '<div class="dankiie-icon-wrap">' + jarSvg + '</div>' +
        '<h2 class="dankiie-title" id="dankiie-title">Enjoying Yorvique?</h2>' +
        '<p class="dankiie-desc" id="dankiie-desc">' +
          'Would you like to leave a Dankiie? Your support helps keep ' +
          'Yorvique ad-free, secure and running smoothly, while helping us ' +
          'cover domain and maintenance costs.' +
        '</p>' +
        '<button type="button" class="dankiie-cta" data-dankiie-cta>' +
          jarSvg + '<span>Give a Dankiie</span>' +
        '</button>' +
        '<div class="dankiie-progress"><div class="dankiie-progress-bar" ' +
          'data-dankiie-progress></div></div>' +
      '</div>';

    document.body.appendChild(overlay);
    dankiieState.node = overlay;
    dankiieState.shownThisSession = true;

    var closeBtn = overlay.querySelector('[data-dankiie-close]');
    var ctaBtn = overlay.querySelector('[data-dankiie-cta]');
    var progressBar = overlay.querySelector('[data-dankiie-progress]');
    var xIcon =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M6 6l12 12M18 6L6 18"/></svg>';
    closeBtn.innerHTML = xIcon;

    // Entrance transition.
    requestAnimationFrame(function () {
      overlay.classList.add('is-visible');
      overlay.setAttribute('aria-hidden', 'false');
    });

    // Start the countdown line + reveal the close button after 5 seconds.
    // Force a reflow so the animation restarts cleanly.
    void progressBar.offsetWidth;
    progressBar.classList.add('is-running');

    dankiieState.timers.push(setTimeout(function () {
      if (!dankiieState.node) return;
      closeBtn.removeAttribute('hidden');
      // Reveal on the next frame so the transition fires.
      requestAnimationFrame(function () {
        closeBtn.classList.add('is-revealed');
      });
    }, DANKIIE_COUNTDOWN_MS));

    // CTA button — opens the URL only if DANKIIE_URL is set, else no-op.
    ctaBtn.addEventListener('click', function () {
      if (!url) return; // no-op while the placeholder is empty
      window.open(url, '_blank', 'noopener,noreferrer');
      dankiieMarkDismissed();
      dankiieClosePopup();
    });

    // Close button — only clickable after the 5s reveal, but the handler is
    // safe to call earlier (it just won't be visible/pointer-reachable).
    closeBtn.addEventListener('click', function () {
      dankiieMarkDismissed();
      dankiieClosePopup();
    });

    // Click on the backdrop dismisses (accessible dismissal, always allowed).
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        dankiieMarkDismissed();
        dankiieClosePopup();
      }
    });

    // Escape key — always dismisses immediately (the 5s delay applies only
    // to the visual X button, per the spec). A document-level listener is
    // used and removed when the popup closes.
    function onKey(e) {
      if (e.key === 'Escape') {
        dankiieMarkDismissed();
        dankiieClosePopup();
      }
    }
    document.addEventListener('keydown', onKey);
    // Also remove this listener when the popup is torn down.
    var origClose = dankiieClosePopup;
    // (Cleanup handled via the timers list below for the keydown listener.)
    overlay._dankiieKeyHandler = onKey;
  }

  // Override dankiieClosePopup to also detach the per-popup key handler.
  (function wrapClose() {
    var prev = dankiieClosePopup;
    dankiieClosePopup = function () {
      var overlay = dankiieState.node;
      if (overlay && overlay._dankiieKeyHandler) {
        document.removeEventListener('keydown', overlay._dankiieKeyHandler);
        overlay._dankiieKeyHandler = null;
      }
      prev();
    };
  })();

  function initDankiiePopup() {
    // No static setup needed — the popup is built lazily by dankiieShowPopup.
    // Exposed for the boot sequence / tests; the trigger lives on the IIFE
    // scope so initUpload can call it directly.
    return { show: dankiieShowPopup };
  }

  // --------------------------------------------------------------------------
  // 4. Upload
  // --------------------------------------------------------------------------
  function initUpload() {
    const dropzone   = $('[data-dropzone]');
    const fileInput  = $('[data-file-input]');
    const fileList   = $('[data-file-list]');
    const submitBtn  = $('[data-drop-submit]');
    const statusEl   = $('[data-drop-status]');
    const shareBox   = $('[data-share-result]');
    const shareUrlEl = $('[data-share-url]');
    const shareOpen  = $('[data-share-open]');
    const shareCopy  = $('[data-share-copy]');
    const shareCopyAlt = $('[data-share-copy-alt]');
    const shareReset = $('[data-share-reset]');
    const copyLabel  = $('[data-share-copy-label]');
    const dropHint   = $('#drop-zone-hint');

    if (!dropzone || !fileInput) return;

    let selectedFile = null;
    let currentXhr = null;

    // Update the hint to reflect the actual max size
    if (dropHint) {
      dropHint.textContent = 'Up to ' + formatBytes(MAX_FILE_SIZE) + ' · private by default';
    }

    // --- Drag-and-drop handlers ---
    ['dragenter', 'dragover'].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('is-dragging');
      });
    });
    ['dragleave', 'dragend', 'drop'].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('is-dragging');
      });
    });
    dropzone.addEventListener('drop', function (e) {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) {
        handleFileSelected(files[0]);
      }
    });

    // Keyboard accessibility: Enter / Space opens the file picker
    dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
    dropzone.addEventListener('click', function (e) {
      // Avoid double-trigger when the label inside is clicked
      if (e.target.closest('label')) return;
      fileInput.click();
    });

    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) {
        handleFileSelected(fileInput.files[0]);
      }
    });

    function handleFileSelected(file) {
      // Hide any previous share result
      hideShareResult();
      // Validate size
      if (file.size > MAX_FILE_SIZE) {
        setStatus('That file is too large. Maximum is ' + formatBytes(MAX_FILE_SIZE) + '.', 'error');
        showToast('File too large.', 'error');
        submitBtn.disabled = true;
        selectedFile = null;
        renderFileList(null);
        return;
      }
      // Validate non-empty name
      if (!file.name || file.name === '.') {
        setStatus('That file does not have a valid name.', 'error');
        submitBtn.disabled = true;
        selectedFile = null;
        renderFileList(null);
        return;
      }
      selectedFile = file;
      renderFileList(file);
      setStatus('Ready to upload ' + escapeHtml(file.name) + '.', '');
      submitBtn.disabled = false;
    }

    function renderFileList(file) {
      fileList.innerHTML = '';
      if (!file) return;
      const ext = getExtension(file.name) || 'FILE';
      const row = document.createElement('div');
      row.className = 'file-row';
      row.innerHTML =
        '<span class="file-row-icon">' + escapeHtml(ext.slice(0, 4)) + '</span>' +
        '<div class="file-row-copy">' +
          '<strong>' + escapeHtml(file.name) + '</strong>' +
          '<span>' + formatBytes(file.size) + ' · ' + escapeHtml(file.type || 'unknown type') + '</span>' +
        '</div>' +
        '<button class="file-remove" type="button" aria-label="Remove file" data-remove>×</button>';
      fileList.appendChild(row);
      const removeBtn = row.querySelector('[data-remove]');
      removeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        selectedFile = null;
        fileInput.value = '';
        renderFileList(null);
        submitBtn.disabled = true;
        setStatus('Nothing uploaded yet.', '');
      });
    }

    function setStatus(text, kind) {
      statusEl.textContent = text;
      statusEl.classList.remove('error', 'success');
      if (kind) statusEl.classList.add(kind);
    }

    // --- Upload submission ---
    submitBtn.addEventListener('click', function () {
      if (!selectedFile) return;
      startUpload(selectedFile);
    });

    function startUpload(file) {
      submitBtn.disabled = true;
      dropzone.classList.add('is-uploading');
      setStatus('Uploading… 0%', '');
      showToast('Uploading ' + file.name + '…');

      const xhr = new XMLHttpRequest();
      currentXhr = xhr;

      // Real progress events — these fire in modern browsers when uploading.
      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          setStatus('Uploading… ' + pct + '%', '');
        }
      });

      xhr.addEventListener('load', function () {
        dropzone.classList.remove('is-uploading');
        currentXhr = null;
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch (e) { body = null; }
        if (xhr.status >= 200 && xhr.status < 300 && body && body.id) {
          // Construct the shareable URL using the current origin.
          // (downloadPathPrefix defaults to '/d/')
          const prefix = (STORAGE.downloadPathPrefix || '/d/');
          const shareableUrl = window.location.origin + prefix + body.id;
          showShareResult(shareableUrl, file);
          setStatus('Upload complete. Link is ready.', 'success');
          showToast('Link is ready.', 'success');
          // Only on a GENUINELY successful link generation: offer the
          // Give a Dankiie support popup. No-op if on the 7-day cooldown or
          // already shown this session. Never fires on failure/empty/error.
          try { dankiieShowPopup(); } catch (e) { /* never block the success path */ }
        } else {
          const msg = (body && body.error) ? body.error : ('Upload failed (HTTP ' + xhr.status + ').');
          setStatus(msg, 'error');
          showToast(msg, 'error');
          submitBtn.disabled = false;
        }
      });

      xhr.addEventListener('error', function () {
        dropzone.classList.remove('is-uploading');
        currentXhr = null;
        // If we appear to be offline, give a clearer message.
        if (!navigator.onLine) {
          setStatus('You are offline. Uploads require an internet connection.', 'error');
          showToast('You are offline.', 'error');
        } else {
          setStatus('Network error during upload. Please try again.', 'error');
          showToast('Network error.', 'error');
        }
        submitBtn.disabled = false;
      });

      xhr.addEventListener('abort', function () {
        dropzone.classList.remove('is-uploading');
        currentXhr = null;
        setStatus('Upload cancelled.', 'error');
        submitBtn.disabled = false;
      });

      const formData = new FormData();
      formData.append('file', file, file.name);
      xhr.open('POST', UPLOAD_ENDPOINT, true);
      xhr.send(formData);
    }

    // --- Share result display + copy + open + reset ---
    function showShareResult(url, file) {
      shareUrlEl.value = url;
      shareOpen.setAttribute('href', url);
      shareBox.classList.add('is-visible');
      if (copyLabel) copyLabel.textContent = 'Copy';
      shareCopy.classList.remove('copied');
      shareCopyAlt.classList.remove('copied');
      // Auto-select the URL text for easy keyboard copy
      setTimeout(function () {
        shareUrlEl.focus();
        shareUrlEl.select();
      }, 50);
    }

    function hideShareResult() {
      shareBox.classList.remove('is-visible');
      shareUrlEl.value = '';
    }

    function copyShareUrl(btn) {
      const url = shareUrlEl.value;
      if (!url) return;
      // Prefer the async clipboard API; fall back to a hidden textarea.
      function markCopied() {
        btn.classList.add('copied');
        if (btn === shareCopy && copyLabel) copyLabel.textContent = 'Copied!';
        showToast('Link copied to clipboard.', 'success');
        setTimeout(function () {
          btn.classList.remove('copied');
          if (btn === shareCopy && copyLabel) copyLabel.textContent = 'Copy';
        }, 1800);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(markCopied, function () {
          fallbackCopy(url); markCopied();
        });
      } else {
        fallbackCopy(url); markCopied();
      }
    }

    function fallbackCopy(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
    }

    if (shareCopy) shareCopy.addEventListener('click', function () { copyShareUrl(shareCopy); });
    if (shareCopyAlt) shareCopyAlt.addEventListener('click', function () { copyShareUrl(shareCopyAlt); });

    if (shareReset) {
      shareReset.addEventListener('click', function () {
        hideShareResult();
        selectedFile = null;
        fileInput.value = '';
        renderFileList(null);
        submitBtn.disabled = true;
        setStatus('Nothing uploaded yet.', '');
      });
    }

    // Allow user to cancel an in-flight upload with Esc
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && currentXhr) {
        currentXhr.abort();
      }
    });
  }

  // --------------------------------------------------------------------------
  // 5. Service worker registration (PWA)
  // --------------------------------------------------------------------------
  function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Only register on http/https (not file://)
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
        .catch(function (err) {
          // Non-fatal — the app still works without the SW.
          console.warn('YORVIQUE: service worker registration failed.', err);
        });
      // Handle service worker updates
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        // The new SW has taken control — reload once so the user gets the
        // latest version of the app shell.
        if (!window.__yorviqueReloading) {
          window.__yorviqueReloading = true;
          window.location.reload();
        }
      });
    });
  }

  // --------------------------------------------------------------------------
  // 6. Online/offline banner
  // --------------------------------------------------------------------------
  function initOnlineStatus() {
    const banner = $('[data-offline-banner]');
    if (!banner) return;
    function update() {
      if (navigator.onLine) {
        banner.classList.remove('is-visible');
      } else {
        banner.classList.add('is-visible');
      }
    }
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
  }

  // --------------------------------------------------------------------------
  // 7. Boot
  // --------------------------------------------------------------------------
  // Remove the no-js class ASAP so the data-reveal animation kicks in. If JS
  // is disabled, the class stays and CSS shows all reveal elements plainly.
  document.documentElement.classList.remove('no-js');

  document.addEventListener('DOMContentLoaded', function () {
    applyBrandAssets();
    initNavigation();
    initReveal();
    initGiveADankiie();
    initDankiiePopup();
    initUpload();
    initOnlineStatus();
    initServiceWorker();
  });
})();
