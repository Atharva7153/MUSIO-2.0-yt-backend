import fs from "fs";
import path from "path";
import ytdlp from "yt-dlp-exec";

const url = process.argv[2] || "https://youtu.be/IpFX2vq8HKw?si=ZvPgUEEQ6IL7yhf6";
const filePath = path.join(process.cwd(), `yt-test-${Date.now()}.webm`);

const downloadOptionsList = [
  { output: filePath, format: "bestaudio", cookies: process.env.YT_COOKIES_PATH || undefined },
  { output: filePath, format: "bestaudio[ext=webm]/bestaudio/best", cookies: process.env.YT_COOKIES_PATH || undefined },
  { output: filePath, format: "bestaudio/best", allow_unplayable_formats: true, no_playlist: true, cookies: process.env.YT_COOKIES_PATH || undefined },
];

(async () => {
  console.log("Testing URL:", url);
  let downloaded = false;
  let lastError = null;

  for (const opts of downloadOptionsList) {
    try {
      console.log("Trying yt-dlp with format:", opts.format || "default");
      await ytdlp(url, opts);
      if (fs.existsSync(filePath)) {
        console.log("Download complete:", filePath);
        downloaded = true;
        break;
      }
    } catch (err) {
      lastError = err;
      console.error("yt-dlp attempt failed:", err && err.stderr ? err.stderr : err);
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { }
    }
  }

  if (!downloaded) {
    console.error("All yt-dlp attempts failed. Last error:", lastError && lastError.stderr ? lastError.stderr : lastError);
    process.exit(1);
  }

  console.log("Test succeeded — cleaning up.");
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { }
  process.exit(0);
})();
