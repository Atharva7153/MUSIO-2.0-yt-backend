const apiBase = ""; // same origin

// DOM Elements
const uploadForm = document.getElementById("uploadForm");
const uploadBtn = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const progressEl = document.getElementById("uploadProgress");
const navItems = document.querySelectorAll(".nav-item");
const contentSections = document.querySelectorAll(".content-section");
const toast = document.getElementById("toast");
const cookieStatusIndicator = document.getElementById("cookieStatusIndicator");
const clearResultsBtn = document.getElementById("clearResults");

// Navigation
navItems.forEach(item => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    
    // Remove active class from all nav items and sections
    navItems.forEach(i => i.classList.remove("active"));
    contentSections.forEach(s => s.classList.remove("active"));
    
    // Add active class to clicked nav item
    item.classList.add("active");
    
    // Show corresponding section
    const targetSectionId = item.getAttribute("data-section");
    document.getElementById(targetSectionId).classList.add("active");
  });
});

// Upload state handling
function setUploadingState(isUploading) {
  const inputs = uploadForm.querySelectorAll('input, button');
  inputs.forEach(i => { if (i !== uploadBtn) i.disabled = isUploading; });
  uploadBtn.disabled = isUploading;
  
  if (isUploading) {
    uploadStatus.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Uploading...';
    progressEl.classList.add('active');
    uploadBtn.innerHTML = '<i class="fas fa-sync fa-spin"></i> Processing...';
  } else {
    uploadStatus.textContent = 'Ready to upload';
    progressEl.classList.remove('active');
    uploadBtn.innerHTML = '<i class="fas fa-upload"></i> Start Upload';
  }
}

// Upload form submission
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
    // Set uploading state
    setUploadingState(true);
    
    // Show initial message
    resultEl.textContent = "Starting upload process...\nThis may take a while depending on the length of the track and your connection speed.\n\n- Downloading from YouTube\n- Processing audio\n- Uploading to Cloudinary";
    
    // Make API request
    const res = await fetch(`${apiBase}/yt-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    
    const data = await res.json();
    resultEl.textContent = JSON.stringify(data, null, 2);
    
    // Show toast with result
    if (data.success) {
      showToast('Upload completed successfully!', 'success');
      
      // Clear form if successful
      if (data.success) {
        document.getElementById("url").value = '';
        document.getElementById("title").value = '';
        
        // Don't clear playlist ID if it was used (for batch uploads)
        if (!playlistId) {
          document.getElementById("artist").value = '';
          document.getElementById("newPlaylistName").value = '';
        }
      }
      
      // Refresh playlists if a new one was created
      if (newPlaylistName) {
        fetchPlaylists();
      }
    } else {
      showToast('Upload failed', 'error');
    }
  } catch (err) {
    resultEl.textContent = "Request failed: " + err;
    showToast('Upload failed: Network error', 'error');
  } finally {
    setUploadingState(false);
  }
});

// Check cookie status
document.getElementById("checkCookie").addEventListener("click", async () => {
  const cookieResultEl = document.getElementById("cookieResult");
  const btn = document.getElementById("checkCookie");
  const cookieStatusIndicator = document.getElementById("cookieStatusIndicator");
  
  btn.innerHTML = '<i class="fas fa-sync fa-spin"></i>';
  btn.disabled = true;
  cookieResultEl.textContent = "Checking cookie status...";
  
  try {
    const res = await fetch(`${apiBase}/cookie-expiry`);
    const data = await res.json();
    cookieResultEl.textContent = JSON.stringify(data, null, 2);
    
    // Update cookie status indicator
    if (data.valid) {
      cookieStatusIndicator.innerHTML = `<span class="status-dot active" title="Cookie valid until ${data.expiry}"></span>`;
      showToast('Cookie is valid', 'success');
    } else {
      cookieStatusIndicator.innerHTML = `<span class="status-dot expired" title="Cookie expired"></span>`;
      showToast('Cookie has expired', 'error');
    }
  } catch (err) {
    cookieResultEl.textContent = "Request failed: " + err;
    cookieStatusIndicator.innerHTML = `<span class="status-dot" title="Cookie status unknown"></span>`;
    showToast('Failed to check cookie status', 'error');
  } finally {
    btn.innerHTML = '<i class="fas fa-cookie"></i>';
    btn.disabled = false;
  }
});

// Fetch playlists
function fetchPlaylists() {
  const playlistsContainer = document.getElementById("playlists");
  const btn = document.getElementById("listPlaylists");
  btn.innerHTML = '<i class="fas fa-sync fa-spin"></i> Loading...';
  btn.disabled = true;
  
  playlistsContainer.innerHTML = `
    <div class="playlist-loading">
      <i class="fas fa-circle-notch fa-spin"></i>
      <p>Loading playlists...</p>
    </div>
  `;
  
  fetch(`${apiBase}/playlists`)
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      playlistsContainer.innerHTML = "";
      
      if (!Array.isArray(data) || data.length === 0) {
        playlistsContainer.innerHTML = `
          <div class="card" style="grid-column: 1/-1">
            <div class="card-body" style="text-align: center;">
              <p><i class="fas fa-info-circle"></i> No playlists found</p>
            </div>
          </div>
        `;
        return;
      }
      
      // Render each playlist as a card
      data.forEach(playlist => {
        const playlistCard = document.createElement("div");
        playlistCard.className = "playlist-card";
        
        playlistCard.innerHTML = `
          <div class="playlist-header">
            <h3 class="playlist-name">${escapeHtml(playlist.name)}</h3>
            <div class="playlist-count">${playlist.songs?.length || 0} tracks</div>
          </div>
          <div class="playlist-id">
            <span class="text-muted">ID: ${playlist._id}</span>
          </div>
          <div class="playlist-actions">
            <button class="btn-copy" data-id="${playlist._id}">
              <i class="fas fa-copy"></i> Copy ID
            </button>
          </div>
        `;
        
        playlistsContainer.appendChild(playlistCard);
      });
      
      // Add event listeners to copy buttons
      document.querySelectorAll('.btn-copy').forEach(btn => {
        btn.addEventListener('click', function() {
          const id = this.getAttribute('data-id');
          copyToClipboard(id);
        });
      });
    })
    .catch(err => {
      playlistsContainer.innerHTML = `
        <div class="card" style="grid-column: 1/-1">
          <div class="card-body">
            <p class="text-danger"><i class="fas fa-exclamation-triangle"></i> Failed to load playlists: ${err.message}</p>
          </div>
        </div>
      `;
    })
    .finally(() => {
      btn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh';
      btn.disabled = false;
    });
}

// Initialize playlist loading
document.getElementById("listPlaylists").addEventListener("click", fetchPlaylists);

// Copy to clipboard
function copyToClipboard(text) {
  navigator.clipboard.writeText(text)
    .then(() => {
      showToast('Copied to clipboard!', 'success');
    })
    .catch(err => {
      console.error('Failed to copy: ', err);
      showToast('Failed to copy to clipboard', 'error');
    });
}

// Toast notification
function showToast(message, type = 'success') {
  const toastEl = document.getElementById('toast');
  const toastIcon = toastEl.querySelector('.toast-icon');
  const toastMessage = toastEl.querySelector('.toast-message');
  const toastProgress = toastEl.querySelector('.toast-progress');
  
  // Set icon based on type
  if (type === 'success') {
    toastIcon.className = 'toast-icon fas fa-check-circle';
    toastIcon.style.color = 'var(--success)';
    toastProgress.style.background = 'var(--success)';
  } else {
    toastIcon.className = 'toast-icon fas fa-exclamation-circle';
    toastIcon.style.color = 'var(--danger)';
    toastProgress.style.background = 'var(--danger)';
  }
  
  // Set message
  toastMessage.textContent = message;
  
  // Show toast
  toastEl.classList.add('show');
  
  // Reset animation
  toastProgress.style.animation = 'none';
  void toastProgress.offsetWidth; // Trigger reflow
  toastProgress.style.animation = 'toast-timer 3s linear forwards';
  
  // Hide toast after animation completes
  setTimeout(() => {
    toastEl.classList.remove('show');
  }, 3000);
}

// Helper function to escape HTML
function escapeHtml(s) {
  return String(s).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Initialize app
document.addEventListener('DOMContentLoaded', function() {
  // Check cookie status on load
  document.getElementById("checkCookie").click();
  
  // Load playlists on navigation to playlists section
  document.querySelector('[data-section="playlists-section"]').addEventListener('click', function() {
    fetchPlaylists();
  });
  
  // Add click listener to clear results button
  if (clearResultsBtn) {
    clearResultsBtn.addEventListener('click', () => {
      document.getElementById('uploadResult').textContent = '';
    });
  }
});
