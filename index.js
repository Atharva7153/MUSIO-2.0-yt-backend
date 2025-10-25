// yt-server/index.js
import express from "express";
import cors from "cors";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Playlist from "./models/Playlist.js";
import Song from "./models/Song.js";
import dotenv from "dotenv";
import ytdlp from "yt-dlp-exec";   // ✅ use yt-dlp-exec

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
// Serve minimal UI from public/
app.use(express.static(path.join(__dirname, "public")));

// --- MongoDB connection ---
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
mongoose.connection.on("connected", () =>
  console.log("MongoDB connected (yt-server)")
);

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

// Read-only helper for UI: list playlists (no mutation)
app.get('/playlists', async (req, res) => {
  try {
    const lists = await Playlist.find().populate('songs').lean();
    res.json(lists);
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
    const downloadOptionsList = [
      // preferred: best audio (no playlist)
      { output: filePath, format: "bestaudio", no_playlist: true, cookies: process.env.YT_COOKIES_PATH || undefined },
      // fallback: bestaudio with ffmpeg conversion to webm container (no playlist)
      { output: filePath, format: "bestaudio[ext=webm]/bestaudio/best", no_playlist: true, cookies: process.env.YT_COOKIES_PATH || undefined },
      // last resort: bestaudio/best (no playlist). Note: don't pass unknown flags like
      // --allow_unplayable_formats here because some yt-dlp binaries (or wrappers)
      // may not support them and will exit with error. If you control the runtime,
      // consider updating yt-dlp to a newer version instead.
      { output: filePath, format: "bestaudio/best", no_playlist: true, cookies: process.env.YT_COOKIES_PATH || undefined },
    ];

    console.log("Downloading with yt-dlp (resilient mode)...");
    let downloaded = false;
    let lastError = null;

    for (const opts of downloadOptionsList) {
      try {
        // build args for yt-dlp-exec; pass unknown boolean flags as true
        const execOpts = { ...opts };
        // log which format we're trying
        console.log("Trying yt-dlp with format:", execOpts.format || "default");
        await ytdlp(url, execOpts);
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
    try {
      const stats = fs.statSync(filePath);
      console.log(`Uploading file to Cloudinary: ${filePath} (${stats.size} bytes)`);

      try {
        uploadRes = await cloudinary.uploader.upload(filePath, {
          resource_type: "video",
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
      // Clean up temp file regardless of upload outcome
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { }
    }

    // 🔹 Step 4: Save song in DB
    const song = new Song({
      title,
      artist: artist || metadata.uploader || "Unknown Artist",
      url: uploadRes.secure_url,
      coverImage,
    });
    await song.save();

    // 🔹 Step 5: Playlist logic
    let playlist;
    if (newPlaylistName) {
      playlist = new Playlist({
        name: newPlaylistName,
        songs: [song._id],
      });
      await playlist.save();
    } else if (playlistId) {
      playlist = await Playlist.findById(playlistId);
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
