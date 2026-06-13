const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Disable caching for static files during development
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Temp directory for downloads
const TEMP_DIR = path.join(os.tmpdir(), 'yt2mp3');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ─── Cookies configuration ───────────────────────────────────────────────────
const COOKIES_PATH = path.join(TEMP_DIR, 'cookies.txt');
let hasCookies = false;

if (process.env.YOUTUBE_COOKIES) {
  console.log(`[Cookies Setup] Found YOUTUBE_COOKIES env var. Length: ${process.env.YOUTUBE_COOKIES.length} chars`);
  try {
    let cookieContent = process.env.YOUTUBE_COOKIES.trim();
    const startsWithHash = cookieContent.startsWith('#');
    console.log(`[Cookies Setup] Raw value starts with '#': ${startsWithHash}`);
    
    // Auto-detect base64 encoding
    if (!startsWithHash) {
      try {
        const decoded = Buffer.from(cookieContent, 'base64').toString('utf-8');
        console.log(`[Cookies Setup] Decoded string length: ${decoded.length} chars`);
        // Valid cookie files contain comments (#) or tab-delimited columns (\t) and multiple lines (\n)
        if (decoded.includes('\n') && (decoded.includes('\t') || decoded.includes('#'))) {
          cookieContent = decoded;
          console.log('  ✓ [Cookies Setup] Decoded YOUTUBE_COOKIES from base64');
        } else {
          console.log('  ✗ [Cookies Setup] Decoded string did not match cookie pattern, keeping raw');
        }
      } catch (err) {
        console.error('  ✗ [Cookies Setup] Base64 decoding failed:', err.message);
      }
    }
    
    fs.writeFileSync(COOKIES_PATH, cookieContent, 'utf-8');
    console.log(`  ✓ [Cookies Setup] Wrote ${cookieContent.length} bytes to ${COOKIES_PATH}`);
    hasCookies = true;
  } catch (err) {
    console.error('  ✗ [Cookies Setup] Failed to write YOUTUBE_COOKIES file:', err.message);
  }
} else if (fs.existsSync(path.join(__dirname, 'cookies.txt'))) {
  try {
    fs.copyFileSync(path.join(__dirname, 'cookies.txt'), COOKIES_PATH);
    console.log('  ✓ Found local cookies.txt');
    hasCookies = true;
  } catch (err) {
    console.error('  ✗ Failed to copy local cookies.txt:', err.message);
  }
} else {
  console.log('[Cookies Setup] YOUTUBE_COOKIES env var NOT found and no local cookies.txt present');
}

function getYtdlpArgs(customArgs) {
  const args = [...customArgs];
  if (hasCookies && fs.existsSync(COOKIES_PATH)) {
    args.push('--cookies', COOKIES_PATH);
  } else {
    args.push('--extractor-args', 'youtube:player_client=default,-android_sdkless');
  }
  return args;
}

// In-memory job store
const jobs = new Map();

// SSE clients per job
const sseClients = new Map();

// ─── Check dependencies on startup ───────────────────────────────────────────
function checkDependency(cmd, name) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    console.log(`  ✓ ${name} found`);
    return true;
  } catch {
    console.error(`  ✗ ${name} not found. Install it: https://github.com/${name === 'yt-dlp' ? 'yt-dlp/yt-dlp' : 'FFmpeg/FFmpeg'}`);
    return false;
  }
}

console.log('\n🔍 Checking dependencies...');
const hasYtdlp = checkDependency('yt-dlp', 'yt-dlp');
const hasFfmpeg = checkDependency('ffmpeg', 'ffmpeg');

if (!hasYtdlp || !hasFfmpeg) {
  console.error('\n⚠️  Missing dependencies. The app will start but conversions will fail.');
  console.error('   Install yt-dlp:  brew install yt-dlp   (or pip install yt-dlp)');
  console.error('   Install ffmpeg:  brew install ffmpeg\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isValidYouTubeUrl(url) {
  const patterns = [
    /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]{11}/,
    /^(https?:\/\/)?youtu\.be\/[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/embed\/[\w-]{11}/,
    /^(https?:\/\/)?m\.youtube\.com\/watch\?v=[\w-]{11}/,
  ];
  return patterns.some(p => p.test(url));
}

function sendProgress(jobId, data) {
  const clients = sseClients.get(jobId) || [];
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  const isFinal = data.status === 'complete' || data.status === 'error';
  clients.forEach(res => {
    try {
      res.write(payload);
      // End the SSE stream after a terminal event so the browser
      // doesn't auto-reconnect and trigger spurious onerror events.
      if (isFinal) res.end();
    } catch { /* client disconnected */ }
  });
  if (isFinal) {
    sseClients.delete(jobId);
  }
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Clean up old files (older than 30 minutes)
function cleanup() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 30 * 60 * 1000) {
        fs.unlinkSync(filePath);
      }
    });
  } catch { /* ignore */ }
}
setInterval(cleanup, 5 * 60 * 1000);

// ─── API: Get video info ────────────────────────────────────────────────────

app.post('/api/info', (req, res) => {
  const { url } = req.body;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const ytdlp = spawn('yt-dlp', getYtdlpArgs([
    '-v',
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    url
  ]));

  let data = '';
  let errorData = '';

  ytdlp.stdout.on('data', chunk => { data += chunk; });
  ytdlp.stderr.on('data', chunk => { errorData += chunk; });

  ytdlp.on('close', code => {
    if (code !== 0) {
      console.error('yt-dlp info error:', errorData);
      return res.status(500).json({ error: `Failed to fetch video info: ${errorData.trim() || 'Unknown error'}` });
    }

    try {
      const info = JSON.parse(data);
      res.json({
        title: info.title || 'Unknown',
        thumbnail: info.thumbnail || '',
        duration: info.duration ? formatDuration(info.duration) : 'Unknown',
        durationSeconds: info.duration || 0,
        channel: info.uploader || info.channel || 'Unknown',
        viewCount: info.view_count || 0,
      });
    } catch (e) {
      console.error('JSON parse error:', e.message);
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

// ─── API: Start conversion ──────────────────────────────────────────────────

app.post('/api/convert', (req, res) => {
  const { url, quality = '192' } = req.body;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const validQualities = ['128', '192', '320'];
  const audioQuality = validQualities.includes(quality) ? quality : '192';

  const jobId = uuidv4();
  const outputTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);

  jobs.set(jobId, {
    status: 'starting',
    progress: 0,
    filename: null,
    title: null,
    error: null,
    createdAt: Date.now(),
  });

  res.json({ jobId });

  // Start conversion in background
  // Note: yt-dlp sends progress & status info to stderr, not stdout
  const ytdlp = spawn('yt-dlp', getYtdlpArgs([
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', audioQuality,
    '--no-playlist',
    '--newline',
    '-o', outputTemplate,
    url
  ]));

  let title = '';

  // Shared handler — yt-dlp may send progress to stdout or stderr depending
  // on version and flags, so we parse both streams identically.
  function handleOutput(chunk) {
    const lines = chunk.toString().split('\n');
    lines.forEach(line => {
      line = line.trim();
      if (!line) return;

      // Parse download progress: "[download]  61.0% of    3.27MiB ..."
      if (line.includes('%')) {
        const percentMatch = line.match(/([\d.]+)%/);
        if (percentMatch) {
          const percent = parseFloat(percentMatch[1]);
          const job = jobs.get(jobId);
          if (job) {
            job.status = 'downloading';
            job.progress = Math.min(percent, 99);
          }
          sendProgress(jobId, {
            status: 'downloading',
            progress: Math.min(percent, 99),
            message: `Downloading... ${percent.toFixed(1)}%`
          });
        }
      }

      // Extract audio conversion step
      if (line.includes('[ExtractAudio]')) {
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'converting';
          job.progress = 95;
        }
        sendProgress(jobId, {
          status: 'downloading',
          progress: 95,
          message: 'Converting to MP3...'
        });
      }

      // Extract title from destination line
      if (line.includes('[download] Destination:')) {
        const match = line.match(/Destination:\s*(.+)/);
        if (match) title = match[1];
      }
    });
  }

  ytdlp.stdout.on('data', handleOutput);
  ytdlp.stderr.on('data', handleOutput);

  ytdlp.on('close', code => {
    const job = jobs.get(jobId);
    if (!job) return;

    if (code !== 0) {
      job.status = 'error';
      job.error = 'Conversion failed. Please try a different video.';
      sendProgress(jobId, { status: 'error', message: job.error });
      return;
    }

    // Find the output mp3 file
    const mp3File = path.join(TEMP_DIR, `${jobId}.mp3`);

    if (fs.existsSync(mp3File)) {
      job.status = 'complete';
      job.progress = 100;
      job.filename = mp3File;

      // Try to read title from yt-dlp metadata
      try {
        const infoResult = spawn('yt-dlp', getYtdlpArgs([
          '--dump-json',
          '--no-playlist',
          '--no-warnings',
          url
        ]));
        let infoData = '';
        infoResult.stdout.on('data', d => infoData += d);
        infoResult.on('close', () => {
          try {
            const info = JSON.parse(infoData);
            job.title = info.title;
          } catch { /* use default */ }
        });
      } catch { /* ignore */ }

      sendProgress(jobId, {
        status: 'complete',
        progress: 100,
        message: 'Conversion complete! Ready to download.'
      });
    } else {
      job.status = 'error';
      job.error = 'MP3 file not found after conversion.';
      sendProgress(jobId, { status: 'error', message: job.error });
    }
  });

  ytdlp.on('error', err => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = 'yt-dlp not found. Please install it.';
      sendProgress(jobId, { status: 'error', message: job.error });
    }
  });
});

// ─── API: SSE Progress ─────────────────────────────────────────────────────

app.get('/api/progress/:id', (req, res) => {
  const { id } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!sseClients.has(id)) {
    sseClients.set(id, []);
  }
  sseClients.get(id).push(res);

  // Send current status immediately
  const job = jobs.get(id);
  if (job) {
    res.write(`data: ${JSON.stringify({
      status: job.status,
      progress: job.progress,
      message: job.status === 'complete' ? 'Ready to download!' : `Status: ${job.status}`
    })}\n\n`);
  }

  req.on('close', () => {
    const clients = sseClients.get(id) || [];
    sseClients.set(id, clients.filter(c => c !== res));
  });
});

// ─── API: Download file ─────────────────────────────────────────────────────

app.get('/api/download/:id', (req, res) => {
  const { id } = req.params;
  const job = jobs.get(id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'complete' || !job.filename) {
    return res.status(400).json({ error: 'File not ready yet' });
  }

  if (!fs.existsSync(job.filename)) {
    return res.status(404).json({ error: 'File has expired. Please convert again.' });
  }

  const downloadName = job.title
    ? `${job.title.replace(/[^a-zA-Z0-9\s-_]/g, '').trim()}.mp3`
    : `download-${id.slice(0, 8)}.mp3`;

  res.download(job.filename, downloadName, err => {
    if (err) {
      console.error('Download error:', err.message);
    }
    // Clean up after download
    setTimeout(() => {
      try {
        if (fs.existsSync(job.filename)) fs.unlinkSync(job.filename);
        jobs.delete(id);
        sseClients.delete(id);
      } catch { /* ignore */ }
    }, 5000);
  });
});


// ─── API: Create ZIP archive ────────────────────────────────────────────────

app.post('/api/zip', (req, res) => {
  const { jobIds } = req.body;

  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return res.status(400).json({ error: 'Invalid or empty jobIds array' });
  }

  // Verify all files exist and jobs are complete
  const validFiles = [];
  const nameCounts = new Map();

  for (const id of jobIds) {
    const job = jobs.get(id);
    if (!job || job.status !== 'complete' || !job.filename || !fs.existsSync(job.filename)) {
      return res.status(400).json({ error: `Job ${id} is not complete or file has expired` });
    }

    // Determine unique name for this file inside the zip to avoid duplicates
    const base = job.title
      ? job.title.replace(/[^a-zA-Z0-9\s-_]/g, '').trim()
      : `download-${id.slice(0, 8)}`;
    const sanitizedBase = base || 'download';
    
    let uniqueName = `${sanitizedBase}.mp3`;
    if (nameCounts.has(sanitizedBase)) {
      const count = nameCounts.get(sanitizedBase);
      nameCounts.set(sanitizedBase, count + 1);
      uniqueName = `${sanitizedBase} (${count}).mp3`;
    } else {
      nameCounts.set(sanitizedBase, 1);
    }

    validFiles.push({
      originalPath: job.filename,
      zipName: uniqueName
    });
  }

  const zipId = uuidv4();
  const zipDir = path.join(TEMP_DIR, `zip-${zipId}`);
  const zipPath = path.join(TEMP_DIR, `${zipId}.zip`);

  try {
    // Create temp subdirectory
    fs.mkdirSync(zipDir, { recursive: true });

    // Copy files to their user-friendly names in the temp subdirectory
    const copiedFiles = [];
    validFiles.forEach(file => {
      const destPath = path.join(zipDir, file.zipName);
      fs.copyFileSync(file.originalPath, destPath);
      copiedFiles.push(file.zipName);
    });

    // Run system zip command
    // -j: junk paths (do not record directory names)
    const zipProcess = spawn('zip', ['-j', zipPath, ...copiedFiles.map(name => path.join(zipDir, name))]);

    zipProcess.on('close', code => {
      // Clean up the temp subdirectory immediately
      try {
        fs.rmSync(zipDir, { recursive: true, force: true });
      } catch { /* ignore */ }

      if (code !== 0) {
        console.error(`zip process exited with code ${code}`);
        return res.status(500).json({ error: 'Failed to create ZIP archive' });
      }

      res.json({ zipId });
    });

    zipProcess.on('error', err => {
      console.error('zip spawn error:', err.message);
      try {
        fs.rmSync(zipDir, { recursive: true, force: true });
      } catch { /* ignore */ }
      res.status(500).json({ error: 'ZIP utility not available or failed' });
    });

  } catch (err) {
    console.error('ZIP preparation error:', err.message);
    try {
      fs.rmSync(zipDir, { recursive: true, force: true });
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    } catch { /* ignore */ }
    res.status(500).json({ error: 'Failed to prepare ZIP files' });
  }
});

// ─── API: Download ZIP archive ──────────────────────────────────────────────

app.get('/api/download-zip/:zipId', (req, res) => {
  const { zipId } = req.params;
  const zipFile = path.join(TEMP_DIR, `${zipId}.zip`);

  if (!fs.existsSync(zipFile)) {
    return res.status(404).json({ error: 'ZIP archive not found or expired' });
  }

  res.download(zipFile, 'YT2MP3-Batch.zip', err => {
    if (err) {
      console.error('ZIP download error:', err.message);
    }
    // Clean up zip file after a delay to ensure transfer finished
    setTimeout(() => {
      try {
        if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);
      } catch { /* ignore */ }
    }, 15000);
  });
});

// ─── API: Health check ──────────────────────────────────────────────────────


app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ytdlp: hasYtdlp,
    ffmpeg: hasFfmpeg,
    activeJobs: jobs.size
  });
});

// ─── Start server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🎵 YT-2-MP3 is running at http://localhost:${PORT}\n`);
});
