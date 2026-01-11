// yt-server/index.js
import express from "express";
import cors from "cors";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import PlaylistSchema from "./models/Playlist.js";
import SongSchema from "./models/Song.js";
import dotenv from "dotenv";
import ytdlp from "yt-dlp-exec";   // ✅ use yt-dlp-exec (kept for capability detection)
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileP = promisify(execFile);
import os from 'os';
import { accessSync } from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
// Serve minimal UI from public/
app.use(express.static(path.join(__dirname, "public")));

// --- Detect yt-dlp binary capabilities once at startup ---
let ytdlpCapabilities = {
  version: null,
  helpText: null,
  flags: {},
};

async function detectYtDlpCapabilities() {
  try {
    // --version is quick and reliable
    const version = await ytdlp("--version");
    // --help may be large but lets us detect supported flags
    let helpText = "";
    try {
      helpText = await ytdlp("--help");
    } catch (e) {
      // Some wrappers/bundles may print help to stderr — try to read stderr if available
      helpText = (e && (e.stderr || e.stdout)) || String(e);
    }

    ytdlpCapabilities.version = (version && String(version).trim()) || null;
    ytdlpCapabilities.helpText = String(helpText || "");

    const ht = ytdlpCapabilities.helpText.toLowerCase();
    // detect a few flags we might want to conditionally pass
    ytdlpCapabilities.flags.no_playlist = ht.includes("--no_playlist") || ht.includes("--no-playlist");
    ytdlpCapabilities.flags.allow_unplayable_formats = ht.includes("--allow_unplayable_formats") || ht.includes("--allow-unplayable-formats") || ht.includes("allow unplayable formats");

    console.log("Detected yt-dlp version:", ytdlpCapabilities.version);
    console.log("Detected yt-dlp flags:", ytdlpCapabilities.flags);
  } catch (e) {
    console.warn("Could not detect yt-dlp capabilities:", e && (e.message || e));
    // leave defaults (empty)
  }
}

// Kick off detection but don't await it here so startup is fast; detection will
// complete before first download in normal cases. We still call it again in
// request flow if not ready.
detectYtDlpCapabilities().catch(() => {});

// Helper: run the bundled yt-dlp binary directly to avoid option-mapping
// performed by wrappers. This ensures we pass only the exact CLI args we want.
function getYtDlpBinaryPath() {
  // node_modules/yt-dlp-exec/bin/yt-dlp(.exe on Windows)
  const binName = os.platform().startsWith('win') ? 'yt-dlp.exe' : 'yt-dlp';
  return path.join(__dirname, 'node_modules', 'yt-dlp-exec', 'bin', binName);
}

async function runYtDlpCli(url, { output, format, cookies, extraArgs } = {}) {
  const bin = getYtDlpBinaryPath();
  const args = [];
  // URL first
  args.push(url);
  if (output) {
    args.push('--output', output);
  }
  if (format) {
    args.push('--format', format);
  }
  if (cookies) {
    args.push('--cookies', cookies);
  }
  // append any additional raw args (array of strings)
  if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs);
  // safe defaults
  args.push('--no-warnings');

  console.log('Running yt-dlp binary:', bin, args.join(' '));
  // execFile returns { stdout, stderr }
  const res = await execFileP(bin, args);
  return res;
}

// List available formats for a URL (returns stdout+stderr)
async function listAvailableFormats(url, cookies) {
  const bin = getYtDlpBinaryPath();
  const args = [url, '--list-formats'];
  if (cookies) args.push('--cookies', cookies);
  args.push('--no-warnings');
  console.log('Listing formats via yt-dlp:', bin, args.join(' '));
  try {
    const res = await execFileP(bin, args);
    return String((res && (res.stdout || '')) + (res && res.stderr || ''));
  } catch (e) {
    // execFile throws on non-zero exit; still return whatever output we have
    return String((e && (e.stdout || '')) || (e && e.stderr) || String(e));
  }
}

// Parse yt-dlp --list-formats output and return array of audio-only format ids (strings)
function parseAudioFormatIds(listFormatsOutput) {
  const lines = String(listFormatsOutput || '').split(/\r?\n/);
  const audioIds = [];
  for (const line of lines) {
    // common format: "    251          webm       audio only  opus @160k" or "140           m4a        audio only"
    const m = line.match(/^\s*(\d+)\s+\S+\s+audio only/i);
    if (m) audioIds.push(m[1]);
  }
  return audioIds;
}

// --- MongoDB connections (DUAL SETUP) ---
// OLD DB: For reading existing/legacy data
const mongoOld = mongoose.createConnection(process.env.MONGO_URI_OLD);
mongoOld.on("connected", () =>
  console.log("MongoDB OLD connected (read-only)")
);
mongoOld.on("error", (err) =>
  console.error("MongoDB OLD connection error:", err)
);

// NEW DB: For writing all new data
const mongoNew = mongoose.createConnection(process.env.MONGO_URI_NEW);
mongoNew.on("connected", () =>
  console.log("MongoDB NEW connected (write operations)")
);
mongoNew.on("error", (err) =>
  console.error("MongoDB NEW connection error:", err)
);

// Create models for each database
const SongOld = mongoOld.model("Song", SongSchema);
const PlaylistOld = mongoOld.model("Playlist", PlaylistSchema);
const SongNew = mongoNew.model("Song", SongSchema);
const PlaylistNew = mongoNew.model("Playlist", PlaylistSchema);

// --- Cloudinary config ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.get("/", (req, res) => {
  res.send("<h1>Welcome to MUSIO backend (YouTube)</h1>");
});

app.get("/health", (req, res) => {
  res.json({ status: "awake" });
});

// UI landing page (static)
app.get('/ui', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Read-only helper for UI: list playlists (reads from BOTH databases and merges)
app.get('/playlists', async (req, res) => {
  try {
    // Fetch from both OLD and NEW databases
    const [oldLists, newLists] = await Promise.all([
      PlaylistOld.find().populate('songs').lean(),
      PlaylistNew.find().populate('songs').lean()
    ]);
    
    // Merge results - NEW database takes priority
    const allLists = [...newLists, ...oldLists];
    res.json(allLists);
  } catch (e) {
    console.error('Failed to list playlists for UI', e);
    res.status(500).json({ error: 'Failed to list playlists' });
  }
});

// --- Route: Download from YouTube & upload to Cloudinary + Mongo ---
app.post("/yt-upload", async (req, res) => {
  try {
    const { url, title, artist, playlistId, newPlaylistName } = req.body;
    console.log("Data Received", url, title, artist, playlistId, newPlaylistName);

    if (!url || !title) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 🔹 Step 1: Get video metadata (with cookies if provided)
    console.log("Fetching metadata...");
    const metadata = await ytdlp(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      cookies: process.env.YT_COOKIES_PATH || undefined, // ✅ added
    });
    const coverImage = metadata.thumbnail || "";

    // 🔹 Step 2: Download audio (with cookies if provided)
    const filePath = path.join(__dirname, `yt-song-${Date.now()}.webm`);

    // resilient download: try a sequence of formats and flags that help on Render
    let downloadOptionsList = [
      // preferred: best audio
      { output: filePath, format: "bestaudio", cookies: process.env.YT_COOKIES_PATH || undefined },
      // fallback: bestaudio with ffmpeg conversion to webm container
      { output: filePath, format: "bestaudio[ext=webm]/bestaudio/best", cookies: process.env.YT_COOKIES_PATH || undefined },
      // last resort: bestaudio/best
      { output: filePath, format: "bestaudio/best", cookies: process.env.YT_COOKIES_PATH || undefined },
    ];

    // Try to list formats and prefer a concrete audio-only format id if available
    try {
      const lf = await listAvailableFormats(url, process.env.YT_COOKIES_PATH || undefined);
      const audioIds = parseAudioFormatIds(lf);
      if (audioIds && audioIds.length) {
        // prefer the first detected audio-only numeric format id
        const fmt = audioIds[0];
        downloadOptionsList.unshift({ output: filePath, format: fmt, cookies: process.env.YT_COOKIES_PATH || undefined });
        console.log('Auto-selected audio-only format id for download fallback:', fmt);
      } else {
        console.log('No explicit audio-only numeric formats found in --list-formats output');
      }
    } catch (e) {
      console.warn('Could not list formats, proceeding with defaults:', e && (e.message || e));
    }

    console.log("Downloading with yt-dlp (resilient mode)...");
    let downloaded = false;
    let lastError = null;

    for (const opts of downloadOptionsList) {
      try {
        // ensure capabilities were detected (best-effort). If detection hasn't
        // completed yet, run it synchronously so we don't pass unsupported flags.
        if (!ytdlpCapabilities.helpText) {
          try { await detectYtDlpCapabilities(); } catch (e) { }
        }

        // build args for yt-dlp-exec. Deliberately avoid adding boolean flags
        // like `no_playlist` or `allow_unplayable_formats` which may be named
        // differently in the underlying binary/wrapper and cause an immediate
        // exit with "no such option". We only pass: output, format, cookies.
        const execOpts = { output: opts.output, format: opts.format, cookies: opts.cookies };
        // log which format we're trying and the exact options sent to ytdlp
  console.log("Trying yt-dlp with format:", execOpts.format || "default");
  console.log("ytdlp exec options:", execOpts);
        // Use the direct binary invocation to ensure we control the exact CLI args
        try {
          await runYtDlpCli(url, execOpts);
        } catch (innerErr) {
          // If we see HLS-specific error about data blocks, retry with HLS ffmpeg prefs
          const stderr = (innerErr && (innerErr.stderr || innerErr.stdout)) || String(innerErr);
          if (String(stderr).includes('Did not get any data blocks') || String(stderr).toLowerCase().includes('did not get any data blocks')) {
            console.log('Detected HLS data block error — retrying download with HLS/ffmpeg flags');
            await runYtDlpCli(url, { ...execOpts, extraArgs: ['--hls-prefer-ffmpeg', '--hls-use-mpegts'] });
          } else {
            throw innerErr;
          }
        }
        if (fs.existsSync(filePath)) {
          console.log("Download complete:", filePath);
          downloaded = true;
          break;
        }
      } catch (err) {
        lastError = err;
        console.error("yt-dlp attempt failed:", err && err.stderr ? err.stderr : err);
        // clean up partial file if present
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { }
      }
    }

    if (!downloaded) {
      // rethrow the last error so outer catch handles response
      throw lastError || new Error("yt-dlp failed for unknown reason");
    }

    // 🔹 Step 3: Upload audio to Cloudinary (resilient - fallback to chunked upload_large on 413)
    let uploadRes;
    // If ffmpeg exists, transcode to mp3 for widest browser compatibility
    const mp3Path = filePath.replace(/\.[^.]+$/, ".mp3");
    let uploadFilePath = filePath; // actual file we will upload
    async function transcodeToMp3(input, output) {
      try {
        // Check ffmpeg exists on PATH by trying to run `ffmpeg -version`
        await execFileP('ffmpeg', ['-version']);
      } catch (e) {
        console.warn('ffmpeg not found on PATH; skipping transcode to mp3');
        throw new Error('ffmpeg-not-found');
      }
      console.log('Transcoding to mp3:', input, '->', output);
      // -y overwrite, -i input, -vn no video, -ab bitrate, -ar sample rate
      await execFileP('ffmpeg', ['-y', '-i', input, '-vn', '-ab', '192k', '-ar', '44100', '-f', 'mp3', output]);
      return output;
    }
      try {
        // Attempt transcode (best-effort). If it succeeds we'll upload MP3.
        try {
          await transcodeToMp3(filePath, mp3Path);
          uploadFilePath = mp3Path;
        } catch (tErr) {
          if (String(tErr.message || '').includes('ffmpeg-not-found')) {
            // Skip, will upload original
          } else {
            console.warn('Transcode to mp3 failed; will upload original file:', tErr && (tErr.message || tErr));
          }
        }

        const stats = fs.statSync(uploadFilePath);
        console.log(`Uploading file to Cloudinary: ${uploadFilePath} (${stats.size} bytes)`);

        try {
          // Choose resource_type based on file extension to avoid Cloudinary
          // auto-transcoding audio to MP4/TS. For audio files (mp3, webm,
          // wav, m4a) prefer 'raw' so Cloudinary stores them as-is and
          // serves the correct content-type. For other files fall back to
          // 'video'.
          const ext = path.extname(uploadFilePath || '').toLowerCase();
          const audioExts = new Set(['.mp3', '.webm', '.wav', '.m4a', '.aac', '.flac', '.ogg']);
          const resourceType = audioExts.has(ext) ? 'raw' : 'video';
          uploadRes = await cloudinary.uploader.upload(uploadFilePath, {
            resource_type: resourceType,
            folder: "songs",
          });
        } catch (uploadErr) {
        // Detect 413 (Request Entity Too Large) or UnexpectedResponse with http_code 413
        const code = uploadErr && (uploadErr.http_code || (uploadErr.statusCode || uploadErr.status));
        const is413 = code === 413 || (uploadErr && typeof uploadErr === 'object' && JSON.stringify(uploadErr).includes('413'));
        console.error('Cloudinary upload failed:', uploadErr && (uploadErr.message || uploadErr));

        if (is413) {
          console.log('Detected 413 - retrying with chunked upload_large (recommended for big files)');
          // upload_large will perform a chunked multipart upload which works around request size limits
          uploadRes = await cloudinary.uploader.upload_large(filePath, {
            resource_type: "video",
            folder: "songs",
            // chunk_size in bytes - 10 MB is a reasonable default for large uploads
            chunk_size: 10 * 1024 * 1024,
          });
        } else {
          throw uploadErr;
        }
      }
      } finally {
      // Clean up temp files regardless of upload outcome
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { }
      try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path); } catch (e) { }
    }

    // 🔹 Step 4: Save song in DB (NEW database)
    const song = new SongNew({
      title,
      artist: artist || metadata.uploader || "Unknown Artist",
      url: uploadRes.secure_url,
      coverImage,
    });
    await song.save();

    // 🔹 Step 5: Playlist logic (NEW database)
    let playlist;
    if (newPlaylistName) {
      playlist = new PlaylistNew({
        name: newPlaylistName,
        songs: [song._id],
      });
      await playlist.save();
    } else if (playlistId) {
      playlist = await PlaylistNew.findById(playlistId);
      if (playlist) {
        playlist.songs.push(song._id);
        await playlist.save();
      }
    }

    res.json({ success: true, song, playlist });
  } catch (e) {
    console.error("YouTube download error:", e);
    // Include the original error message to aid debugging (non-sensitive)
    res.status(500).json({ error: "Download failed", message: e && (e.message || String(e)) });
  }
});

// --- Route: Check YouTube cookie expiry ---
app.get("/cookie-expiry", async (req, res) => {
  try {
    const cookieFile = process.env.YT_COOKIES_PATH;
    if (!cookieFile || !fs.existsSync(cookieFile)) {
      return res.status(400).json({ error: "Cookie file not found" });
    }

    const content = fs.readFileSync(cookieFile, "utf8");
    const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
    const expiryTimestamps = [];

    for (const line of lines) {
      const parts = line.split("\t");
      const expiry = parts[4]; // expiry is usually column 5 in Netscape format
      if (expiry && !isNaN(expiry)) {
        expiryTimestamps.push(Number(expiry));
      }
    }

    if (expiryTimestamps.length === 0) {
      return res.json({ expiresAt: null, message: "No expiry info in cookie" });
    }

    const latestExpiry = new Date(Math.max(...expiryTimestamps) * 1000);
    res.json({ expiresAt: latestExpiry, message: `Cookie expires at ${latestExpiry}` });
  } catch (e) {
    console.error("Cookie expiry check error:", e);
    res.status(500).json({ error: "Failed to check cookie expiry" });
  }
});

// --- Start server ---
const PORT = 4000;
app.listen(PORT, () =>
  console.log(`YT Upload Server running on http://localhost:${PORT}`)
);
