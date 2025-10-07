const apiBase = ""; // same origin

const uploadForm = document.getElementById("uploadForm");
const uploadBtn = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const progressWrap = document.getElementById("uploadProgress");

function setUploadingState(isUploading) {
  const inputs = uploadForm.querySelectorAll('input, button');
  inputs.forEach(i => { if (i !== uploadBtn) i.disabled = isUploading; });
  uploadBtn.disabled = isUploading;
  uploadStatus.textContent = isUploading ? 'Uploading...' : 'Idle';
  if (isUploading) progressWrap.classList.add('active'); else progressWrap.classList.remove('active');
}

uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = document.getElementById("url").value;
  const title = document.getElementById("title").value;
  const artist = document.getElementById("artist").value;
  const playlistId = document.getElementById("playlistId").value;
  const newPlaylistName = document.getElementById("newPlaylistName").value;

  const payload = { url, title };
  if (artist) payload.artist = artist;
  if (playlistId) payload.playlistId = playlistId;
  if (newPlaylistName) payload.newPlaylistName = newPlaylistName;

  const resultEl = document.getElementById("uploadResult");
  resultEl.textContent = "";
  try {
    setUploadingState(true);
    resultEl.textContent = "Uploading... this may take a while depending on yt-dlp and cloudinary.";
    const res = await fetch(`${apiBase}/yt-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    resultEl.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    resultEl.textContent = "Request failed: " + err;
  } finally {
    setUploadingState(false);
  }
});

document.getElementById("checkCookie").addEventListener("click", async () => {
  const el = document.getElementById("cookieResult");
  el.textContent = "Checking...";
  try {
    const res = await fetch(`${apiBase}/cookie-expiry`);
    const data = await res.json();
    el.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    el.textContent = "Request failed: " + err;
  }
});

document.getElementById("listPlaylists").addEventListener("click", async () => {
  const ul = document.getElementById("playlists");
  ul.innerHTML = "Loading...";
  try {
    const res = await fetch(`${apiBase}/playlists`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    ul.innerHTML = "";
    if (!Array.isArray(data) || data.length === 0) {
      ul.innerHTML = "<li>No playlists</li>";
      return;
    }
    for (const p of data) {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${escapeHtml(p.name)}</strong> — ${p.songs?.length || 0} songs<br/><small>id: ${p._id}</small>`;
      ul.appendChild(li);
    }
  } catch (err) {
    ul.innerHTML = "Request failed: " + err;
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
