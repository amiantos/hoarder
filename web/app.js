const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const statusEl = document.getElementById("status");
const recentEl = document.getElementById("recent");

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"]);

function showStatus(message, kind) {
  statusEl.hidden = false;
  statusEl.className = "status" + (kind ? " " + kind : "");
  statusEl.innerHTML = message;
}

function clearStatus() {
  statusEl.hidden = true;
  statusEl.innerHTML = "";
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatDate(ms) {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function uploadFile(file) {
  if (!file) return;
  dropzone.classList.add("uploading");
  showStatus(`uploading ${file.name || "file"}…`);

  const form = new FormData();
  form.append("file", file, file.name || "pasted");

  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      showStatus(`error: ${err.error || res.statusText}`, "error");
      return;
    }
    const data = await res.json();
    const copied = await copyToClipboard(data.url);
    showStatus(
      `<a href="${data.url}" target="_blank" rel="noopener">${data.url}</a>${copied ? " — copied to clipboard" : ""}`,
      "success"
    );
    await loadRecent();
  } catch (err) {
    showStatus(`error: ${err.message}`, "error");
  } finally {
    dropzone.classList.remove("uploading");
  }
}

async function loadRecent() {
  try {
    const res = await fetch("/api/uploads?limit=50");
    if (!res.ok) return;
    const { items, auth_enabled } = await res.json();
    renderRecent(items, auth_enabled);
  } catch {
    /* ignore */
  }
}

function renderRecent(items, authEnabled) {
  recentEl.innerHTML = "";
  if (!items.length) {
    recentEl.innerHTML = '<li style="color:var(--muted);border:none;">no uploads yet</li>';
    return;
  }

  for (const item of items) {
    const li = document.createElement("li");

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (item.thumb_url) {
      thumb.style.backgroundImage = `url('${item.thumb_url}')`;
    } else if (IMAGE_MIMES.has(item.mime)) {
      // SVG and any image where thumbnail generation failed — fall back to the original
      thumb.style.backgroundImage = `url('${item.url}')`;
    } else {
      thumb.textContent = item.ext;
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const link = document.createElement("a");
    link.className = "url";
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = item.url;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `${formatSize(item.size)} · ${formatDate(item.created_at)}${item.filename ? " · " + item.filename : ""}`;
    meta.appendChild(link);
    meta.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "actions";

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "copy";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyToClipboard(item.url);
      copyBtn.textContent = ok ? "copied" : "failed";
      setTimeout(() => (copyBtn.textContent = "copy"), 1200);
    });

    actions.appendChild(copyBtn);

    if (authEnabled) {
      const delBtn = document.createElement("button");
      delBtn.className = "danger";
      delBtn.textContent = "delete";
      let armed = false;
      let armTimer = null;
      delBtn.addEventListener("click", async () => {
        if (!armed) {
          armed = true;
          delBtn.classList.add("confirming");
          delBtn.textContent = "confirm?";
          armTimer = setTimeout(() => {
            armed = false;
            delBtn.classList.remove("confirming");
            delBtn.textContent = "delete";
          }, 3000);
          return;
        }
        clearTimeout(armTimer);
        delBtn.disabled = true;
        delBtn.textContent = "deleting…";
        try {
          const res = await fetch(`/api/uploads/${item.id}`, { method: "DELETE" });
          if (res.ok) {
            li.remove();
          } else {
            delBtn.textContent = "failed";
            delBtn.disabled = false;
          }
        } catch {
          delBtn.textContent = "failed";
          delBtn.disabled = false;
        }
      });
      actions.appendChild(delBtn);
    }

    li.appendChild(thumb);
    li.appendChild(meta);
    li.appendChild(actions);
    recentEl.appendChild(li);
  }
}

// Drop / drag events
["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev !== "drop" && e.target !== dropzone) return;
    dropzone.classList.remove("drag");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) uploadFile(file);
});

// Click to choose
dropzone.addEventListener("click", (e) => {
  if (e.target.tagName === "LABEL") return;
  fileInput.click();
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) uploadFile(file);
  fileInput.value = "";
});

// Paste from clipboard
document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) {
        uploadFile(file);
        return;
      }
    }
  }
});

loadRecent();
