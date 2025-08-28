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
import ytdlp from "yt-dlp-exec"; // ✅ yt-dlp

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
mongoose.connection.on("connected", () =>
  console.log("MongoDB connected (yt-server)")
);

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Helper: extract YouTube video ID
function getYouTubeId(url) {
  const regExp =
    /^.*(?:youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return match && match[1].length === 11 ? match[1] : null;
}

// Route: Download from YouTube & upload to Cloudinary + Mongo
app.post("/yt-upload", async (req, res) => {
  try {
    const { url, title, artist, playlistId, newPlaylistName } = req.body;
    console.log("Data Recieved", url, title, artist, playlistId, newPlaylistName);

    if (!url || !title) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Save file with correct extension
    const outputFile = path.join(__dirname, `song-${Date.now()}.%(ext)s`);

    try {
      // ✅ Download best audio directly, no ffmpeg, no conversion
      await ytdlp(url, {
        format: "bestaudio/best",
        output: outputFile,
      });

      // Figure out actual filename (replace %(ext)s with detected extension)
      const files = fs.readdirSync(__dirname);
      const downloadedFile = files.find(f => f.startsWith("song-") && (f.endsWith(".webm") || f.endsWith(".m4a")));
      if (!downloadedFile) {
        return res.status(500).json({ error: "Download failed, no file found" });
      }

      const fullPath = path.join(__dirname, downloadedFile);

      // ✅ Upload to Cloudinary
      const uploadRes = await cloudinary.uploader.upload(fullPath, {
        resource_type: "video", // Cloudinary treats audio as video
        folder: "songs",
      });

      // Delete local file
      fs.unlinkSync(fullPath);

      // --- Auto Thumbnail from YouTube ---
      let coverImage = "";
      const ytId = getYouTubeId(url);
      if (ytId) {
        coverImage = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
      }

      // Save song in DB
      const song = new Song({
        title,
        artist: artist || "Unknown Artist",
        url: uploadRes.secure_url,
        coverImage,
      });
      await song.save();

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

      res.json({
        success: true,
        song,
        playlist,
      });
    } catch (downloadErr) {
      console.error("yt-dlp-exec error:", downloadErr);
      res.status(500).json({ error: "Download failed" });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = 4000;
app.listen(PORT, () =>
  console.log(`YT Upload Server running on http://localhost:${PORT}`)
);
