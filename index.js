// sc-server/index.js
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
import scdlModule from "soundcloud-downloader";

dotenv.config();
const scdl = scdlModule.default || scdlModule; // ✅ Fix for ESM

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
  console.log("MongoDB connected (sc-server)")
);

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.get("/health", (req, res) => {
  res.json({ status: "awake" });
});

// --- Route: Download from SoundCloud & upload to Cloudinary + Mongo ---
app.post("/sc-upload", async (req, res) => {
  try {
    const { url, title, artist, playlistId, newPlaylistName } = req.body;
    console.log("Data Received", url, title, artist, playlistId, newPlaylistName);

    if (!url || !title) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Temp file path
    const filePath = path.join(__dirname, `sc-song-${Date.now()}.mp3`);

    try {
      // ✅ Download SoundCloud audio 

      const cleanUrl = url.split("?")[0];

      const clientId = scdl.getClientID()
      const stream = await scdl.download(cleanUrl, clientId);
      await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(filePath);
        stream.pipe(writeStream);
        stream.on("error", reject);
        writeStream.on("finish", resolve);
      });

      // ✅ Upload to Cloudinary
      const uploadRes = await cloudinary.uploader.upload(filePath, {
        resource_type: "video", // Cloudinary treats audio as video
        folder: "songs",
      });

      // Delete local temp file
      fs.unlinkSync(filePath);

      // --- Cover Image from SoundCloud metadata ---
      let coverImage = "";
      try {
        const info = await scdl.getInfo(url);
        coverImage = info?.artwork_url || info?.user?.avatar_url || "";
      } catch (metaErr) {
        console.warn("Could not fetch SoundCloud metadata:", metaErr);
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
      console.error("SoundCloud download error:", downloadErr);
      res.status(500).json({ error: "Download failed" });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = 4000;
app.listen(PORT, () =>
  console.log(`SC Upload Server running on http://localhost:${PORT}`)
);
