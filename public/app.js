/* ═══════════════════════════════════════════════════════════════════════════
   YT → MP3  ·  Frontend Application Logic (Batch Edition)
   ═══════════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ─── DOM References ──────────────────────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const urlInput        = $('#urlInput');
  const pasteBtn        = $('#pasteBtn');
  const convertBtn      = $('#convertBtn');
  const btnText         = convertBtn.querySelector('.btn-text');
  const btnLoader       = convertBtn.querySelector('.btn-loader');
  const btnArrow        = convertBtn.querySelector('.btn-arrow');
  const queueSection    = $('#queueSection');
  const queueList       = $('#queueList');
  const globalStatusMsg   = $('#globalStatusMsg');
  const globalStatusRatio = $('#globalStatusRatio');
  const globalProgressBar = $('#globalProgressBar');
  const globalProgressGlow = $('#globalProgressGlow');
  const downloadAllBtn  = $('#downloadAllBtn');
  const clearQueueBtn   = $('#clearQueueBtn');

  // ─── State ───────────────────────────────────────────────────────────────

  let queue = [];
  const MAX_CONCURRENT = 2;
  let activeWorkers = 0;

  // ─── URL Validation ──────────────────────────────────────────────────────

  function isValidYouTubeUrl(url) {
    const patterns = [
      /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]{11}/,
      /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]{11}/,
      /^(https?:\/\/)?youtu\.be\/[\w-]{11}/,
      /^(https?:\/\/)?(www\.)?youtube\.com\/embed\/[\w-]{11}/,
      /^(https?:\/\/)?m\.youtube\.com\/watch\?v=[\w-]{11}/,
    ];
    return patterns.some(p => p.test(url.trim()));
  }

  // ─── UI State Management ─────────────────────────────────────────────────

  function setUIState(state) {
    if (state === 'idle') {
      $('#inputGroup').hidden = false;
      $('#qualitySelector').hidden = false;
      queueSection.hidden = true;
      convertBtn.disabled = false;
      btnText.textContent = 'Convert';
      btnLoader.hidden = true;
      btnArrow.hidden = false;
    } else if (state === 'processing') {
      $('#inputGroup').hidden = true;
      $('#qualitySelector').hidden = true;
      queueSection.hidden = false;
    }
  }

  // ─── Paste from clipboard ────────────────────────────────────────────────

  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        urlInput.value = text.trim();
        urlInput.focus();
        pasteBtn.style.transform = 'scale(0.85)';
        setTimeout(() => { pasteBtn.style.transform = ''; }, 150);
      }
    } catch {
      urlInput.focus();
    }
  });

  // ─── Command+Enter or Ctrl+Enter to trigger convert ──────────────────────

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !convertBtn.disabled) {
      e.preventDefault();
      convertBtn.click();
    }
  });

  // ─── Start Batch Conversion ──────────────────────────────────────────────

  convertBtn.addEventListener('click', () => {
    const rawInput = urlInput.value.trim();
    if (!rawInput) {
      urlInput.focus();
      shakeElement(urlInput.parentElement);
      return;
    }

    const lines = rawInput.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    if (lines.length === 0) {
      urlInput.focus();
      shakeElement(urlInput.parentElement);
      return;
    }

    setUIState('processing');
    queueList.innerHTML = '';
    queue = [];
    activeWorkers = 0;

    lines.forEach((url, index) => {
      const item = {
        id: `item_${index}_${Date.now()}`,
        url: url,
        status: 'pending',
        progress: 0,
        title: url,
        thumbnail: null,
        channel: null,
        duration: null,
        jobId: null,
        eventSource: null
      };

      queue.push(item);

      // Create DOM node
      const el = createQueueItemDOM(item);
      queueList.appendChild(el);

      // Attach remove handler
      el.querySelector('.queue-item-remove-btn').addEventListener('click', () => {
        removeItem(item);
      });

      // Validate URL immediately
      if (!isValidYouTubeUrl(url)) {
        updateItemStatus(item, 'error', 'Invalid YouTube URL');
      }
    });

    updateGlobalStatus();

    // Start worker loop
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      processNext();
    }
  });

  // ─── Concurrency Worker Loop ─────────────────────────────────────────────

  async function processNext() {
    // Find first pending item
    const item = queue.find(it => it.status === 'pending');
    if (!item || activeWorkers >= MAX_CONCURRENT) {
      updateGlobalStatus();
      return;
    }

    activeWorkers++;
    try {
      await processItem(item);
    } catch (e) {
      console.error('Job worker error:', e);
    } finally {
      activeWorkers--;
      processNext();
    }
  }

  // ─── Process Single Queue Item ───────────────────────────────────────────

  async function processItem(item) {
    if (item.status === 'removed' || item.status === 'error') return;

    updateItemStatus(item, 'fetching', 'Fetching info...');

    // Phase 1: Try to fetch info first for nice UI rendering
    try {
      const infoRes = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url })
      });
      if (infoRes.ok) {
        const info = await infoRes.json();
        item.title = info.title || item.title;
        item.thumbnail = info.thumbnail;
        item.channel = info.channel;
        item.duration = info.duration;
        updateItemUI(item);
      }
    } catch (e) {
      console.warn('Metadata fetch failed, moving to conversion directly:', e.message);
    }

    if (item.status === 'removed') return;

    // Phase 2: Start Conversion on Server
    const quality = $('input[name="quality"]:checked')?.value || '192';
    updateItemStatus(item, 'converting', 'Starting conversion...');

    try {
      const convertRes = await fetch('/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url, quality })
      });

      if (!convertRes.ok) {
        const data = await convertRes.json();
        throw new Error(data.error || 'Conversion request failed');
      }

      const { jobId } = await convertRes.json();
      item.jobId = jobId;

      // Phase 3: Connect SSE to trace progress
      await new Promise((resolve) => {
        let isDone = false;

        const finish = (status, msg) => {
          if (isDone) return;
          isDone = true;

          if (item.eventSource) {
            item.eventSource.close();
            item.eventSource = null;
          }

          updateItemStatus(item, status, msg);
          resolve();
        };

        item.eventSource = new EventSource(`/api/progress/${jobId}`);

        item.eventSource.onmessage = (event) => {
          if (item.status === 'removed') {
            finish('removed', 'Cancelled');
            return;
          }

          try {
            const data = JSON.parse(event.data);
            if (data.status === 'downloading') {
              updateItemProgress(item, data.progress, data.message || 'Downloading...');
            } else if (data.status === 'converting') {
              updateItemProgress(item, data.progress || 95, data.message || 'Converting...');
            } else if (data.status === 'complete') {
              item.progress = 100;
              finish('complete', 'Ready');
            } else if (data.status === 'error') {
              finish('error', data.message || 'Conversion failed');
            }
          } catch (e) {
            console.error('SSE JSON parse error:', e);
          }
        };

        item.eventSource.onerror = () => {
          if (item.status === 'removed') {
            finish('removed', 'Cancelled');
            return;
          }

          // Let EventSource attempt to reconnect
          setTimeout(() => {
            if (isDone) return;
            if (!item.eventSource || item.eventSource.readyState === EventSource.CLOSED) {
              finish('error', 'Connection lost');
            }
          }, 8000);
        };
      });

    } catch (err) {
      updateItemStatus(item, 'error', err.message);
    }
  }

  // ─── Queue Item DOM Creator ──────────────────────────────────────────────

  function createQueueItemDOM(item) {
    const div = document.createElement('div');
    div.className = 'queue-item status-pending';
    div.id = item.id;
    div.innerHTML = `
      <div class="queue-item-thumb">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
      </div>
      <div class="queue-item-info">
        <div class="queue-item-title" title="${item.url}">${item.url}</div>
        <div class="queue-item-meta">Waiting in queue...</div>
        <div class="queue-item-progress-container" hidden>
          <div class="queue-item-progress-track">
            <div class="queue-item-progress-bar"></div>
          </div>
        </div>
      </div>
      <div class="queue-item-actions">
        <button class="queue-item-remove-btn" title="Remove" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    `;
    return div;
  }

  // ─── Queue Item DOM Updates ──────────────────────────────────────────────

  function updateItemUI(item) {
    const el = document.getElementById(item.id);
    if (!el) return;

    if (item.thumbnail) {
      const thumbContainer = el.querySelector('.queue-item-thumb');
      thumbContainer.innerHTML = `
        <img src="${item.thumbnail}" alt="Thumbnail">
        <span class="preview-duration" style="position: absolute; bottom: 2px; right: 2px; padding: 1px 4px; background: rgba(0,0,0,0.8); border-radius: 2px; font-size: 0.6rem; color: white;">${item.duration}</span>
      `;
    }

    if (item.title) {
      const titleEl = el.querySelector('.queue-item-title');
      titleEl.textContent = item.title;
      titleEl.title = item.title;
    }

    if (item.channel || item.duration) {
      const metaEl = el.querySelector('.queue-item-meta');
      metaEl.textContent = `${item.channel || 'Unknown'} • ${item.duration || 'Unknown'}`;
    }
  }

  // Helper to safely format status messages
  function updateItemStatus(item, status, message) {
    item.status = status;
    const el = document.getElementById(item.id);
    if (!el) return;

    el.className = `queue-item status-${status}`;
    const metaEl = el.querySelector('.queue-item-meta');
    const progressContainer = el.querySelector('.queue-item-progress-container');
    const actionsEl = el.querySelector('.queue-item-actions');

    if (status === 'fetching' || status === 'converting') {
      progressContainer.removeAttribute('hidden');
      if (message) metaEl.textContent = message;
    } else if (status === 'complete') {
      progressContainer.setAttribute('hidden', 'true');
      metaEl.textContent = 'Conversion complete!';
      actionsEl.innerHTML = `
        <button class="queue-item-download-btn" type="button">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"></path>
          </svg>
          Download
        </button>
      `;
      // Attach download action
      actionsEl.querySelector('.queue-item-download-btn').addEventListener('click', () => {
        window.location.href = `/api/download/${item.jobId}`;
      });
    } else if (status === 'error') {
      progressContainer.setAttribute('hidden', 'true');
      metaEl.textContent = message || 'Conversion failed';
      actionsEl.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--error)" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
      `;
    }
  }

  function updateItemProgress(item, progress, message) {
    item.progress = progress;
    const el = document.getElementById(item.id);
    if (!el) return;

    const bar = el.querySelector('.queue-item-progress-bar');
    if (bar) bar.style.width = `${progress}%`;

    const metaEl = el.querySelector('.queue-item-meta');
    if (metaEl && message) {
      metaEl.textContent = `${message} (${Math.round(progress)}%)`;
    }
  }

  // ─── Queue Item Removal ──────────────────────────────────────────────────

  function removeItem(item) {
    item.status = 'removed';
    if (item.eventSource) {
      item.eventSource.close();
      item.eventSource = null;
    }

    const el = document.getElementById(item.id);
    if (el) el.remove();

    queue = queue.filter(it => it.id !== item.id);
    updateGlobalStatus();

    if (queue.length === 0) {
      resetAll();
    } else {
      processNext();
    }
  }

  // ─── Global Progress & Status ────────────────────────────────────────────

  function updateGlobalStatus() {
    const activeJobs = queue.filter(it => it.status !== 'removed');
    const finishedCount = activeJobs.filter(it => it.status === 'complete' || it.status === 'error').length;
    const successCount = activeJobs.filter(it => it.status === 'complete').length;
    const totalCount = activeJobs.length;

    const globalPercent = totalCount > 0 ? (finishedCount / totalCount) * 100 : 0;
    globalProgressBar.style.width = `${globalPercent}%`;
    globalProgressGlow.style.width = `${globalPercent}%`;
    globalStatusRatio.textContent = `${finishedCount} / ${totalCount} Complete`;

    if (finishedCount < totalCount) {
      globalStatusMsg.textContent = 'Converting...';
      globalStatusMsg.style.color = '';
      downloadAllBtn.disabled = true;
    } else {
      if (successCount > 0) {
        globalStatusMsg.textContent = 'Batch conversion completed!';
        globalStatusMsg.style.color = 'var(--success)';
        downloadAllBtn.disabled = false;
      } else {
        globalStatusMsg.textContent = 'All conversions failed.';
        globalStatusMsg.style.color = 'var(--error)';
        downloadAllBtn.disabled = true;
      }
    }
  }

  // ─── Download All ZIP ────────────────────────────────────────────────────

  downloadAllBtn.addEventListener('click', async () => {
    const completedJobs = queue.filter(it => it.status === 'complete' && it.jobId);
    if (completedJobs.length === 0) return;

    downloadAllBtn.disabled = true;
    const originalText = downloadAllBtn.innerHTML;
    downloadAllBtn.innerHTML = `
      <svg class="spinner" width="16" height="16" viewBox="0 0 24 24" style="margin-right: 8px;">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="60 30" stroke-linecap="round"/>
      </svg>
      Archiving...
    `;

    try {
      const res = await fetch('/api/zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIds: completedJobs.map(it => it.jobId) })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create ZIP archive');
      }

      const { zipId } = await res.json();
      window.location.href = `/api/download-zip/${zipId}`;

      // Pulse animation
      downloadAllBtn.style.transform = 'scale(0.95)';
      setTimeout(() => { downloadAllBtn.style.transform = ''; }, 200);

      // Restore button status
      setTimeout(() => {
        downloadAllBtn.disabled = false;
        downloadAllBtn.innerHTML = originalText;
      }, 4000);

    } catch (err) {
      console.error(err);
      globalStatusMsg.textContent = `ZIP Error: ${err.message}`;
      globalStatusMsg.style.color = 'var(--error)';
      downloadAllBtn.disabled = false;
      downloadAllBtn.innerHTML = originalText;
    }
  });

  // ─── Reset interface ─────────────────────────────────────────────────────

  clearQueueBtn.addEventListener('click', resetAll);

  function resetAll() {
    // Close any remaining active SSE streams
    queue.forEach(item => {
      if (item.eventSource) {
        item.eventSource.close();
      }
    });

    queue = [];
    activeWorkers = 0;
    urlInput.value = '';
    globalProgressBar.style.width = '0%';
    globalProgressGlow.style.width = '0%';
    globalStatusRatio.textContent = '0 / 0 Complete';
    globalStatusMsg.textContent = 'Converting...';
    globalStatusMsg.style.color = '';
    downloadAllBtn.disabled = true;

    setUIState('idle');
    urlInput.focus();
  }

  // ─── Micro-animations ────────────────────────────────────────────────────

  function shakeElement(el) {
    el.style.animation = 'none';
    el.offsetHeight; // trigger reflow
    el.style.animation = 'shakeIn 0.4s ease';
    setTimeout(() => { el.style.animation = ''; }, 400);
  }

  // ─── INIT ────────────────────────────────────────────────────────────────

  setUIState('idle');
  urlInput.value = '';
  urlInput.focus();

})();
