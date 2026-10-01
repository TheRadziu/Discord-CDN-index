// =========================================================
// KONFIGURACJA (ŁATWA ZMIANA HASŁA)
// =========================================================

const API_SECRET = "ja_j4b4_chuj_serniktopedal";
const ACCESS_PASSWORD = "park_przyszlosci";

// =========================================================


const DEMO_DATA = {
  "Filmy-i-Odcinki-Testowe": {
    "Big-Buck-Bunny": [
      {
        name: "Big_Buck_Bunny_1080p_MultiAudio.mkv",
        url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
        size: "158 MB"
      }
    ]
  }
};

// Funkcja pomocnicza do wyszukiwania pliku w strukturze JSON na podstawie tablicy części ścieżki
function findFileByPath(data, pathParts) {
  let current = data;
  for (let i = 0; i < pathParts.length; i++) {
    const part = decodeURIComponent(pathParts[i]);
    if (!current) return null;

    if (Array.isArray(current)) {
      const found = current.find(f => f.name === part);
      if (found) return found;
    } else if (typeof current === 'object') {
      current = current[part];
    }
  }
  return null;
}

// Funkcja do parsowania ciasteczek
function getCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const matches = cookieHeader.match(new RegExp(
    "(?:^|; )" + name.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + "=([^;]*)"
  ));
  return matches ? decodeURIComponent(matches[1]) : null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cookieHeader = request.headers.get("Cookie");
    const clientToken = getCookie(cookieHeader, "access_token");

    // Current full path for post-login redirect (e.g. /Kategoria/Plik.mkv)
    const currentFullPath = url.pathname + url.search;

    // ---------------------------------------------------------
    // 0. OBSŁUGA LOGOWANIA / HASŁA
    // ---------------------------------------------------------
    const pathParts = url.pathname.split("/").filter(p => p.length > 0);
    
    // Sprawdzamy czy to żądanie wymaga hasła:
    const isAssetRequest = pathParts.length > 0 && (url.searchParams.has("download") || url.searchParams.has("stream"));
    const requiresAuth = (pathParts.length === 0 || !isAssetRequest) && url.pathname !== "/cors-proxy" && url.pathname !== "/api/update";

    // Obsługa wysłania hasła metodą POST (z formularza logowania)
    if (request.method === "POST" && url.pathname === "/login") {
      try {
        const formData = await request.formData();
        const password = formData.get("password");
        const redirectTo = formData.get("redirect") || "/";

        if (password === ACCESS_PASSWORD) {
          return new Response(null, {
            status: 302,
            headers: {
              "Location": redirectTo,
              "Set-Cookie": `access_token=${ACCESS_PASSWORD}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`
            }
          });
        } else {
          return new Response(getLoginTemplate("Błędne hasło! Spróbuj ponownie.", redirectTo), {
            status: 401,
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
      } catch (e) {
        return new Response("Błąd autoryzacji", { status: 400 });
      }
    }

    if (requiresAuth && clientToken !== ACCESS_PASSWORD) {
      return new Response(getLoginTemplate("", currentFullPath), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // ---------------------------------------------------------
    // 1. ENDPOINT CORS PROXY
    // ---------------------------------------------------------
    if (url.pathname === "/cors-proxy") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) return new Response("Missing url param", { status: 400 });

      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Content-Type, Authorization",
            "Access-Control-Max-Age": "86400"
          }
        });
      }

      try {
        const fetchHeaders = new Headers();
        if (request.headers.has("Range")) {
          fetchHeaders.set("Range", request.headers.get("Range"));
        }

        const originResponse = await fetch(targetUrl, { 
          headers: fetchHeaders,
          method: request.method
        });

        const newHeaders = new Headers(originResponse.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        newHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
        newHeaders.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");

        return new Response(originResponse.body, {
          status: originResponse.status,
          statusText: originResponse.statusText,
          headers: newHeaders
        });
      } catch (err) {
        return new Response("Error fetching target via proxy: " + err.message, { status: 500 });
      }
    }

    // ---------------------------------------------------------
    // 2. ENDPOINT API DO AKTUALIZACJI BAZY KV
    // ---------------------------------------------------------
    if (url.pathname === "/api/update" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization");
      const validSecret = env.API_SECRET || API_SECRET;
      
      if (authHeader !== `Bearer ${validSecret}`) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { 
          status: 401, 
          headers: { "Content-Type": "application/json" } 
        });
      }

      if (!env.MEDIA_KV) {
        return new Response(JSON.stringify({ error: "Brak podpiętego KV Namespace (env.MEDIA_KV) w ustawieniach Workera!" }), { 
          status: 500, 
          headers: { "Content-Type": "application/json" } 
        });
      }

      const data = await request.json();
      await env.MEDIA_KV.put("STRUCTURE_DATA", JSON.stringify(data));
      
      return new Response(JSON.stringify({ status: "success" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Pobranie aktualnych danych z KV
    let mediaData = null;
    let isDemo = false;

    if (env.MEDIA_KV) {
      mediaData = await env.MEDIA_KV.get("STRUCTURE_DATA", { type: "json" });
    }

    if (!mediaData || Object.keys(mediaData).length === 0) {
      mediaData = DEMO_DATA;
      isDemo = true;
    }

    // ---------------------------------------------------------
    // 3. OBSŁUGA STRUMIENIOWANIA I POBIERANIA BEZ PRZEKIEROWAŃ 302
    // ---------------------------------------------------------
    if (pathParts.length > 0 && (url.searchParams.has("download") || url.searchParams.has("stream"))) {
      const fileObj = findFileByPath(mediaData, pathParts);
      
      if (fileObj) {
        if (request.method === "OPTIONS") {
          return new Response(null, {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
              "Access-Control-Allow-Headers": "Range, Content-Type, Authorization",
              "Access-Control-Max-Age": "86400"
            }
          });
        }

        try {
          const fetchHeaders = new Headers();
          if (request.headers.has("Range")) {
            fetchHeaders.set("Range", request.headers.get("Range"));
          }

          const originResponse = await fetch(fileObj.url, { 
            headers: fetchHeaders,
            method: request.method
          });

          const newHeaders = new Headers(originResponse.headers);
          newHeaders.set("Access-Control-Allow-Origin", "*");
          newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          newHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
          newHeaders.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, Content-Disposition");

          if (url.searchParams.has("download")) {
            const fileNameEncoded = encodeURIComponent(fileObj.name);
            newHeaders.set("Content-Disposition", `attachment; filename="${fileObj.name}"; filename*=UTF-8''${fileNameEncoded}`);
          }

          return new Response(originResponse.body, {
            status: originResponse.status,
            statusText: originResponse.statusText,
            headers: newHeaders
          });
        } catch (err) {
          return new Response("Błąd pobierania/strumieniowania pliku: " + err.message, { status: 500 });
        }
      } else {
        return new Response("Nie znaleziono pliku pod podaną ścieżką", { status: 404 });
      }
    }

    // ---------------------------------------------------------
    // 4. RENDEROOWANIE STRONY HTML
    // ---------------------------------------------------------
    return new Response(getHtmlTemplate(mediaData, isDemo), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

function getLoginTemplate(errorMsg = "", redirectPath = "/") {
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VOD Vault - Logowanie</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
    body {
      background: linear-gradient(135deg, #0d0e1b 0%, #1a102f 50%, #0b0718 100%);
      color: #f3f4f6;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-card {
      background: rgba(23, 20, 41, 0.85);
      border: 1px solid rgba(139, 92, 246, 0.3);
      padding: 2.5rem;
      border-radius: 16px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6), 0 0 20px rgba(139, 92, 246, 0.2);
      backdrop-filter: blur(12px);
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      text-align: center;
    }
    h1 { font-size: 1.5rem; background: linear-gradient(90deg, #a78bfa, #60a5fa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    p { font-size: 0.9rem; color: #9ca3af; }
    input[type="password"] {
      width: 100%;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid rgba(139, 92, 246, 0.3);
      background: rgba(13, 14, 27, 0.8);
      color: #fff;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus { border-color: #8b5cf6; }
    button {
      width: 100%;
      padding: 12px;
      border-radius: 8px;
      border: none;
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      color: #fff;
      font-weight: 600;
      font-size: 1rem;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
    }
    button:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(139, 92, 246, 0.5); }
    .error { color: #ef4444; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="login-card">
    <div>
      <h1>VOD Streaming Vault</h1>
      <p>Wprowadź hasło, aby uzyskać dostęp</p>
    </div>
    <form action="/login" method="POST">
      <input type="hidden" name="redirect" value="${redirectPath}">
      <input type="password" name="password" placeholder="Hasło dostępu..." required autofocus>
      ${errorMsg ? `<div class="error" style="margin-top: 10px;">${errorMsg}</div>` : ''}
      <button type="submit" style="margin-top: 15px;">Wejdź</button>
    </form>
  </div>
</body>
</html>`;
}

function getHtmlTemplate(data, isDemo) {
  const pageTitle = isDemo ? "[DEMO] VOD Streaming Vault" : "VOD Streaming Vault";
  
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer" />
  <title>${pageTitle}</title>
  
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
  
  <script type="module" src="https://cdn.jsdelivr.net/npm/movi-player/dist/element.js"></script>

  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #0d0e1b 0%, #1a102f 50%, #0b0718 100%);
      --card-bg: rgba(23, 20, 41, 0.65);
      --border-color: rgba(139, 92, 246, 0.2);
      --accent-violet: #8b5cf6;
      --accent-blue: #3b82f6;
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }

    body {
      background: var(--bg-gradient);
      background-attachment: fixed;
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    header {
      background: rgba(13, 14, 27, 0.8);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-color);
      padding: 1rem 2rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .logo {
      font-size: 1.4rem;
      font-weight: 700;
      background: linear-gradient(90deg, #a78bfa, #60a5fa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
    }

    .demo-badge {
      background: #ef4444;
      color: #fff;
      font-size: 0.75rem;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-left: 8px;
      -webkit-text-fill-color: initial;
    }

    .layout {
      display: grid;
      grid-template-columns: 340px 1fr;
      flex: 1;
      height: calc(100vh - 65px);
    }

    .sidebar {
      background: var(--card-bg);
      border-right: 1px solid var(--border-color);
      overflow-y: auto;
      padding: 1.2rem;
      backdrop-filter: blur(8px);
    }

    .tree-node { margin-bottom: 0.3rem; }

    .tree-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 8px;
      cursor: pointer;
      user-select: none;
      transition: all 0.2s ease;
      font-size: 0.95rem;
      font-weight: 600;
      color: #e5e7eb;
    }

    .tree-header:hover {
      background: rgba(139, 92, 246, 0.15);
      color: #a78bfa;
    }

    .tree-children {
      margin-left: 16px;
      padding-left: 8px;
      border-left: 1px solid rgba(139, 92, 246, 0.15);
      display: none;
    }

    .tree-children.open { display: block; }

    .file-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: 2px;
      transition: background 0.2s, color 0.2s;
    }

    .file-item:hover, .file-item.active {
      background: linear-gradient(90deg, rgba(139, 92, 246, 0.25), rgba(59, 130, 246, 0.1));
      color: #fff;
    }

    .file-name {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .main-content {
      padding: 2rem;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      align-items: center;
    }

    .player-container {
      width: 100%;
      max-width: 1000px;
      background: #000;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 20px rgba(139, 92, 246, 0.2);
      border: 1px solid var(--border-color);
      aspect-ratio: 16/9;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }

    movi-player {
      width: 100%;
      height: 100%;
      display: block;
    }

    .control-panel {
      width: 100%;
      max-width: 1000px;
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 1.2rem 1.5rem;
      backdrop-filter: blur(10px);
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .panel-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .media-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .media-title { font-size: 1.1rem; font-weight: 600; color: #fff; }
    .media-path { font-size: 0.8rem; color: var(--accent-violet); }

    .action-buttons { display: flex; gap: 12px; }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 18px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.88rem;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
    }

    .btn-vlc {
      background: linear-gradient(135deg, #ff8800, #ea580c);
      color: #fff;
      box-shadow: 0 4px 12px rgba(234, 88, 12, 0.3);
    }

    .btn-vlc:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(234, 88, 12, 0.5); }

    .btn-download {
      background: linear-gradient(135deg, var(--accent-violet), var(--accent-blue));
      color: #fff;
      box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
    }

    .btn-download:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(139, 92, 246, 0.5); }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      gap: 1rem;
    }

    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; height: auto; }
      .sidebar { max-height: 300px; }
    }
  </style>
</head>
<body>

  <header>
    <div class="logo" onclick="navigateTo('/')">
      <i class="fa-solid fa-play-circle"></i> VOD Vault
      ${isDemo ? '<span class="demo-badge">Tryb Demo</span>' : ''}
    </div>
  </header>

  <div class="layout">
    <div class="sidebar" id="treeView"></div>

    <div class="main-content">
      <div class="player-container" id="playerWrapper">
        <div class="empty-state" id="emptyState">
          <i class="fa-solid fa-film" style="font-size: 3rem; color: var(--accent-violet);"></i>
          <p>Wybierz plik z listy po lewej stronie, aby rozpocząć odtwarzanie</p>
        </div>
      </div>

      <div class="control-panel" id="controlPanel" style="display: none;">
        <div class="panel-top">
          <div class="media-info">
            <span class="media-title" id="currentTitle">-</span>
            <span class="media-path" id="currentPath">-</span>
          </div>
          <div class="action-buttons">
            <button id="vlcBtn" class="btn btn-vlc">
              <i class="fa-solid fa-cone"></i> Odtwórz w VLC
            </button>
            <a id="downloadBtn" href="#" download class="btn btn-download">
              <i class="fa-solid fa-download"></i> Pobierz
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const data = ${JSON.stringify(data)};
    let activePath = "";

    function navigateTo(urlPath) {
      window.history.pushState({}, '', urlPath);
      handleRouting();
    }

    function createFileElement(file, fullPath) {
      const fileEl = document.createElement('div');
      fileEl.className = 'file-item';
      fileEl.setAttribute('data-path', fullPath);
      fileEl.innerHTML = '<span class="file-name"><i class="fa-regular fa-file-video" style="margin-right: 6px;"></i>' + file.name + '</span>';
      
      fileEl.onclick = (e) => {
        if (e) e.stopPropagation();
        navigateTo("/" + fullPath.split('/').map(encodeURIComponent).join('/'));
      };
      return fileEl;
    }

    function renderTree(node, container, path = "") {
      for (const key of Object.keys(node).sort()) {
        const currentPath = path ? path + "/" + key : key;
        const target = node[key];

        const dirNode = document.createElement('div');
        dirNode.className = 'tree-node';

        const header = document.createElement('div');
        header.className = 'tree-header';
        header.setAttribute('data-dir-path', currentPath);

        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';

        if (Array.isArray(target)) {
          header.innerHTML = '<i class="fa-solid fa-folder" style="color: #a78bfa;"></i> ' + key;
          const files = target.sort((a, b) => a.name.localeCompare(b.name));
          files.forEach(file => {
            const fileFullPath = currentPath + "/" + file.name;
            childrenContainer.appendChild(createFileElement(file, fileFullPath));
          });
        } else if (typeof target === 'object' && target !== null) {
          header.innerHTML = '<i class="fa-solid fa-folder" style="color: #60a5fa;"></i> ' + key;
          renderTree(target, childrenContainer, currentPath);
        }

        header.onclick = (e) => {
          e.stopPropagation();
          const isOpen = childrenContainer.classList.contains('open');
          const icon = header.querySelector('i');

          if (isOpen) {
            childrenContainer.classList.remove('open');
            if (icon) icon.className = 'fa-solid fa-folder';
          } else {
            childrenContainer.classList.add('open');
            if (icon) icon.className = 'fa-solid fa-folder-open';
          }

          navigateTo("/" + currentPath.split('/').map(encodeURIComponent).join('/'));
        };

        dirNode.appendChild(header);
        dirNode.appendChild(childrenContainer);
        container.appendChild(dirNode);
      }
    }

    function loadMedia(file, path) {
      const wrapper = document.getElementById('playerWrapper');
      const controlPanel = document.getElementById('controlPanel');

      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      const maskedDownloadUrl = window.location.origin + "/" + encodedPath + "?download=true";
      const maskedStreamUrl = window.location.origin + "/" + encodedPath + "?stream=true";

      activePath = path;

      document.getElementById('currentTitle').innerText = file.name;
      document.getElementById('currentPath').innerText = path.replace(/\\//g, " / ");
      document.getElementById('downloadBtn').href = maskedDownloadUrl;

      wrapper.innerHTML = '<movi-player src="' + maskedStreamUrl + '" controls autoplay crossorigin="anonymous"></movi-player>';

      controlPanel.style.display = 'flex';
    }

    function findFileByPathJS(structure, pathParts) {
      let current = structure;
      for (let i = 0; i < pathParts.length; i++) {
        const part = pathParts[i];
        if (!current) return null;

        if (Array.isArray(current)) {
          return current.find(f => f.name === part) || null;
        } else if (typeof current === 'object') {
          current = current[part];
        }
      }
      return null;
    }

    function findFileElement(path) {
      const items = document.querySelectorAll('.file-item');
      for (const item of items) {
        if (item.getAttribute('data-path') === path) return item;
      }
      return null;
    }

    function findHeaderElement(path) {
      const items = document.querySelectorAll('.tree-header');
      for (const item of items) {
        if (item.getAttribute('data-dir-path') === path) return item;
      }
      return null;
    }

    function handleRouting() {
      const rawParts = window.location.pathname.split('/').filter(p => p.length > 0);
      const decodedParts = rawParts.map(p => decodeURIComponent(p));
      const currentUrlPath = decodedParts.join('/');

      document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));

      if (!currentUrlPath) {
        document.querySelectorAll('.tree-children').forEach(el => el.classList.remove('open'));
        document.querySelectorAll('.tree-header i').forEach(icon => icon.className = 'fa-solid fa-folder');
        document.getElementById('playerWrapper').innerHTML = '<div class="empty-state"><i class="fa-solid fa-film" style="font-size: 3rem; color: var(--accent-violet);"></i><p>Wybierz plik z listy po lewej stronie, aby rozpocząć odtwarzanie</p></div>';
        document.getElementById('controlPanel').style.display = 'none';
        return;
      }

      const fileObj = findFileByPathJS(data, decodedParts);

      if (fileObj) {
        const targetFileEl = findFileElement(currentUrlPath);
        if (targetFileEl) {
          targetFileEl.classList.add('active');
          let parent = targetFileEl.closest('.tree-children');
          while (parent) {
            parent.classList.add('open');
            const header = parent.previousElementSibling;
            if (header && header.classList.contains('tree-header')) {
              const icon = header.querySelector('i');
              if (icon) icon.className = 'fa-solid fa-folder-open';
            }
            parent = parent.parentElement.closest('.tree-children');
          }
        }
        loadMedia(fileObj, currentUrlPath);
      } else {
        const targetHeaderEl = findHeaderElement(currentUrlPath);
        if (targetHeaderEl) {
          const children = targetHeaderEl.nextElementSibling;
          if (children && children.classList.contains('tree-children')) {
            children.classList.add('open');
            const icon = targetHeaderEl.querySelector('i');
            if (icon) icon.className = 'fa-solid fa-folder-open';
          }

          let ancestor = targetHeaderEl.closest('.tree-children');
          while (ancestor) {
            ancestor.classList.add('open');
            const h = ancestor.previousElementSibling;
            if (h && h.classList.contains('tree-header')) {
              const icon = h.querySelector('i');
              if (icon) icon.className = 'fa-solid fa-folder-open';
            }
            ancestor = ancestor.parentElement.closest('.tree-children');
          }
        }
      }
    }

    document.getElementById('vlcBtn').onclick = () => {
      if (!activePath) return;
      const encodedPath = activePath.split('/').map(encodeURIComponent).join('/');
      const downloadUrl = window.location.origin + "/" + encodedPath + "?download=true";
      window.location.href = 'vlc://' + downloadUrl;
    };

    const treeView = document.getElementById('treeView');
    renderTree(data, treeView);
    handleRouting();

    window.onpopstate = () => {
      handleRouting();
    };
  </script>
</body>
</html>`;
}