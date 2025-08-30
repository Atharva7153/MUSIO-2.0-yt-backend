import scdlModule from "soundcloud-downloader";
const scdl = scdlModule.default || scdlModule;  // fix for ESM

async function downloadTrack(url) {
  try {
    const stream = await scdl.download(url);
    console.log("✅ Track downloaded!");
  } catch (err) {
    console.error("❌ Error:", err);
  }
}

downloadTrack("https://soundcloud.com/forss/flickermood");
