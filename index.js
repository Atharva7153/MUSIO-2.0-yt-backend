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
    const ytArgs = {
      output: filePath,
      format: "bestaudio",
      cookies: process.env.YT_COOKIES_PATH || undefined, // ✅ added
    };

    console.log("Downloading with yt-dlp...");
    await ytdlp(url, ytArgs);
    console.log("Download complete:", filePath);

    // 🔹 Step 3: Upload audio to Cloudinary
    const uploadRes = await cloudinary.uploader.upload(filePath, {
      resource_type: "video",
      folder: "songs",
    });

    // Clean up temp file
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

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
    res.status(500).json({ error: "Download failed" });
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
