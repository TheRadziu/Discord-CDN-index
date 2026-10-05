// =========================================================
// KONFIGURACJA
// =========================================================

const API_SECRET = "ja_j4b4_chuj_serniktopedal";
const ACCESS_PASSWORD = "park_przyszlosci";


// =========================================================
// DEMO DATA
// =========================================================
//
// UWAGA:
// Tych danych NIE zmieniamy.
// Obsługa "size": "950.0 MB" itd. jest realizowana
// przez kod poniżej.
//

const DEMO_DATA = {
  "Filmy-i-Odcinki-Testowe": {
    "Big-Buck-Bunny": [
      {
        name: "Big_Buck_Bunny_1080p_MultiAudio.mkv",
        size: "1.8 GB",
        parts: [
          { url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", size: 50000000 },
          { url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", size: 50000000 },
          { url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", size: 58000000 }
        ]
      }
    ]
  }
};


// =========================================================
// PARSOWANIE ROZMIARÓW
// =========================================================
//
// Obsługuje:
// 950.0 MB
// 1.8 GB
// 584.04 MB
// 500 MB
// 123456789
//
// Dla multipart rzeczywisty rozmiar źródła jest później
// pobierany z HEAD / Range, więc wartość tekstowa jest
// tylko fallbackiem.
//

function parseSizeToBytes(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value !== "string") {
    return 0;
  }

  const normalized = value
    .trim()
    .replace(",", ".");

  // Sam numer = bajty
  if (/^\d+(\.\d+)?$/.test(normalized)) {
    const number = Number(normalized);

    return Number.isFinite(number)
      ? Math.max(0, Math.floor(number))
      : 0;
  }

  const match = normalized.match(
    /^([\d.]+)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)$/i
  );

  if (!match) {
    return 0;
  }

  const number = Number(match[1]);

  if (!Number.isFinite(number)) {
    return 0;
  }

  const unit = match[2].toUpperCase();

  const multipliers = {
    B: 1,

    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,

    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4
  };

  return Math.floor(
    number * (multipliers[unit] || 1)
  );
}


// =========================================================
// NORMALIZACJA PLIKU
// =========================================================

function normalizeFile(fileObj) {
  if (!fileObj) {
    return null;
  }

  // Explicit multipart:
  //
  // {
  //   name: "...mkv",
  //   parts: [...]
  // }
  //
  if (
    Array.isArray(fileObj.parts) &&
    fileObj.parts.length > 0
  ) {
    const parts = fileObj.parts
      .filter(part => part && part.url)
      .map(part => ({
        url: part.url,
        size: part.size
      }));

    if (!parts.length) {
      return null;
    }

    return {
      name: fileObj.name,
      parts
    };
  }

  // Normal single file:
  //
  // {
  //   name: "...mkv",
  //   url: "...",
  //   size: "859.49 MB"
  // }
  //
  if (fileObj.url) {
    return {
      name: fileObj.name,
      parts: [
        {
          url: fileObj.url,
          size: fileObj.size
        }
      ]
    };
  }

  return null;
}


// =========================================================
// PRZETWARZANIE STRUKTURY
// =========================================================
//
// Łączy:
//
// file.mkv.part01
// file.mkv.part02
// file.mkv.part03
//
// w:
//
// file.mkv
//   parts: [...]
//
// Demo data z już istniejącym "parts" pozostaje bez zmian.
//

function processStructure(data) {
  if (!data) {
    return data;
  }

  if (Array.isArray(data)) {
    const partGroups = {};
    const result = [];

    for (const item of data) {
      if (!item || !item.name) {
        continue;
      }

      // Już zdefiniowany multipart.
      if (
        Array.isArray(item.parts) &&
        item.parts.length > 0
      ) {
        result.push(item);
        continue;
      }

      // Rozpoznaj:
      //
      // movie.mkv.part01
      // movie.mkv.part02
      //
      const match = item.name.match(
        /^(.*?)\.part(\d+)$/i
      );

      if (match) {
        const baseName = match[1];

        if (!partGroups[baseName]) {
          partGroups[baseName] = [];
        }

        partGroups[baseName].push(item);
      } else {
        result.push(item);
      }
    }

    // Tworzymy wirtualne pliki.
    for (const [baseName, partsList] of Object.entries(
      partGroups
    )) {
      // Sortowanie NUMERYCZNE:
      //
      // part01
      // part02
      // ...
      // part10
      //
      partsList.sort((a, b) => {
        const aMatch = a.name.match(
          /\.part(\d+)$/i
        );

        const bMatch = b.name.match(
          /\.part(\d+)$/i
        );

        const aNumber = aMatch
          ? Number(aMatch[1])
          : 0;

        const bNumber = bMatch
          ? Number(bMatch[1])
          : 0;

        return aNumber - bNumber;
      });

      const combinedParts = partsList
        .filter(part => part.url)
        .map(part => ({
          url: part.url,

          // Zostawiamy oryginalną wartość.
          //
          // Może być:
          // "950.0 MB"
          //
          // Nie robimy tutaj Number(),
          // ponieważ Number("950.0 MB") === NaN.
          size: part.size
        }));

      result.push({
        name: baseName,
        parts: combinedParts
      });
    }

    return result;
  }

  if (typeof data === "object") {
    const newObj = {};

    for (const key of Object.keys(data)) {
      newObj[key] = processStructure(data[key]);
    }

    return newObj;
  }

  return data;
}


// =========================================================
// SZUKANIE PLIKU PO ŚCIEŻCE
// =========================================================

function findFileByPath(data, pathParts) {
  let current = data;

  for (let i = 0; i < pathParts.length; i++) {
    const part = decodeURIComponent(
      pathParts[i]
    );

    if (!current) {
      return null;
    }

    if (Array.isArray(current)) {
      const found = current.find(
        file => file.name === part
      );

      if (found) {
        return found;
      }

      return null;
    }

    if (
      typeof current === "object" &&
      current !== null
    ) {
      current = current[part];
    } else {
      return null;
    }
  }

  // Musimy zwrócić końcowy obiekt.
  return current;
}


// =========================================================
// COOKIE
// =========================================================

function getCookie(cookieHeader, name) {
  if (!cookieHeader) {
    return null;
  }

  const escapedName = name.replace(
    /([\.$?*|{}\(\)\[\]\\\/\+^])/g,
    "\\$1"
  );

  const matches = cookieHeader.match(
    new RegExp(
      "(?:^|; )" +
      escapedName +
      "=([^;]*)"
    )
  );

  return matches
    ? decodeURIComponent(matches[1])
    : null;
}


// =========================================================
// USTALANIE PRAWDZIWEGO ROZMIARU REMOTE FILE
// =========================================================
//
// Kolejność:
//
// 1. Jeśli size jest liczbą -> użyj jej.
// 2. HEAD -> Content-Length.
// 3. GET Range bytes=0-0 -> Content-Range.
// 4. Fallback -> parsowanie "950.0 MB".
//
// Dzięki temu "950.0 MB" nie staje się 0.
//

async function resolveRemoteSize(part) {
  if (!part || !part.url) {
    throw new Error(
      "Brak URL części pliku"
    );
  }

  // Jeśli mamy dokładny rozmiar numeryczny,
  // możemy go wykorzystać bez requestu.
  if (
    typeof part.size === "number" &&
    Number.isFinite(part.size) &&
    part.size > 0
  ) {
    return Math.floor(part.size);
  }

  // -------------------------------------------------------
  // 1. HEAD
  // -------------------------------------------------------

  try {
    const headResponse = await fetch(
      part.url,
      {
        method: "HEAD",
        redirect: "follow"
      }
    );

    const contentLength =
      headResponse.headers.get(
        "Content-Length"
      );

    if (
      headResponse.ok &&
      contentLength &&
      Number.isFinite(
        Number(contentLength)
      ) &&
      Number(contentLength) > 0
    ) {
      return Number(contentLength);
    }
  } catch (error) {
    console.warn(
      "HEAD size detection failed:",
      error?.message || error
    );
  }

  // -------------------------------------------------------
  // 2. RANGE 0-0
  // -------------------------------------------------------

  try {
    const rangeResponse = await fetch(
      part.url,
      {
        method: "GET",
        headers: {
          Range: "bytes=0-0"
        },
        redirect: "follow"
      }
    );

    const contentRange =
      rangeResponse.headers.get(
        "Content-Range"
      );

    if (contentRange) {
      // Example:
      //
      // bytes 0-0/996147200
      //
      const match = contentRange.match(
        /bytes\s+\d+-\d+\/(\d+)/i
      );

      if (match) {
        const total = Number(
          match[1]
        );

        try {
          await rangeResponse.body?.cancel();
        } catch (_) {}

        if (
          Number.isFinite(total) &&
          total > 0
        ) {
          return total;
        }
      }
    }

    // Serwer mógł zignorować Range i zwrócić 200.
    if (rangeResponse.status === 200) {
      const contentLength =
        rangeResponse.headers.get(
          "Content-Length"
        );

      try {
        await rangeResponse.body?.cancel();
      } catch (_) {}

      if (
        contentLength &&
        Number.isFinite(
          Number(contentLength)
        ) &&
        Number(contentLength) > 0
      ) {
        return Number(contentLength);
      }
    }

    try {
      await rangeResponse.body?.cancel();
    } catch (_) {}
  } catch (error) {
    console.warn(
      "Range size detection failed:",
      error?.message || error
    );
  }

  // -------------------------------------------------------
  // 3. FALLBACK DO SIZE Z JSON
  // -------------------------------------------------------

  const fallback = parseSizeToBytes(
    part.size
  );

  if (fallback > 0) {
    console.warn(
      "Using fallback size for:",
      part.url,
      fallback
    );

    return fallback;
  }

  throw new Error(
    "Nie można ustalić rozmiaru remote file: " +
    part.url
  );
}


// =========================================================
// USTALENIE ROZMIARÓW WSZYSTKICH PARTS
// =========================================================

async function resolveAllPartSizes(parts) {
  const resolved = [];

  for (const part of parts) {
    const size =
      await resolveRemoteSize(part);

    if (
      !Number.isFinite(size) ||
      size <= 0
    ) {
      throw new Error(
        "Nieprawidłowy rozmiar części: " +
        part.url
      );
    }

    resolved.push({
      url: part.url,
      size
    });
  }

  return resolved;
}


// =========================================================
// RANGE PARSER
// =========================================================
//
// Obsługiwane:
//
// bytes=0-100
// bytes=100-
// bytes=-500
//
// Jeden range na request.
//

function parseRangeHeader(
  rangeHeader,
  totalSize
) {
  if (
    !rangeHeader ||
    !rangeHeader.startsWith("bytes=")
  ) {
    return null;
  }

  // Multipart byte ranges nie są tutaj potrzebne.
  if (rangeHeader.includes(",")) {
    return {
      error: "MULTIPLE_RANGES"
    };
  }

  const value =
    rangeHeader
      .substring(6)
      .trim();

  // ---------------------------------------------
  // bytes=-500
  // ---------------------------------------------

  const suffixMatch =
    value.match(/^-(\d+)$/);

  if (suffixMatch) {
    const suffixLength =
      Number(suffixMatch[1]);

    if (
      !suffixLength ||
      totalSize <= 0
    ) {
      return {
        error: "INVALID_RANGE"
      };
    }

    return {
      start: Math.max(
        0,
        totalSize - suffixLength
      ),
      end: totalSize - 1
    };
  }

  // ---------------------------------------------
  // bytes=100-500
  // bytes=100-
  // ---------------------------------------------

  const match =
    value.match(
      /^(\d+)-(\d*)$/
    );

  if (!match) {
    return {
      error: "INVALID_RANGE"
    };
  }

  const start =
    Number(match[1]);

  if (
    !Number.isFinite(start) ||
    start >= totalSize
  ) {
    return {
      error: "OUT_OF_RANGE"
    };
  }

  let end =
    totalSize - 1;

  if (match[2] !== "") {
    end =
      Number(match[2]);

    if (!Number.isFinite(end)) {
      return {
        error: "INVALID_RANGE"
      };
    }

    end =
      Math.min(
        end,
        totalSize - 1
      );
  }

  if (start > end) {
    return {
      error: "OUT_OF_RANGE"
    };
  }

  return {
    start,
    end
  };
}


// =========================================================
// MIME TYPE
// =========================================================

function getMimeType(fileName) {
  const name =
    String(fileName || "")
      .toLowerCase();

  if (name.endsWith(".mp4")) {
    return "video/mp4";
  }

  if (name.endsWith(".mkv")) {
    return "video/x-matroska";
  }

  if (name.endsWith(".webm")) {
    return "video/webm";
  }

  if (name.endsWith(".avi")) {
    return "video/x-msvideo";
  }

  if (name.endsWith(".mov")) {
    return "video/quicktime";
  }

  if (name.endsWith(".m4v")) {
    return "video/x-m4v";
  }

  if (name.endsWith(".ts")) {
    return "video/mp2t";
  }

  return "application/octet-stream";
}


// =========================================================
// STREAM REMOTE RANGE
// =========================================================
//
// Pobiera tylko odpowiedni fragment fizycznej części.
//
// Jeśli CDN respektuje Range:
//
//   206 Partial Content
//
// to dane idą bezpośrednio.
//
// Jeśli CDN ignoruje Range i zwraca:
//
//   200 OK
//
// wtedy pomijamy początkowe bajty lokalnie.
//

async function streamRemoteRange(
  url,
  requestedStart,
  requestedEnd,
  writer
) {
  const wantedBytes =
    requestedEnd -
    requestedStart +
    1;

  if (wantedBytes <= 0) {
    return 0;
  }

  const response =
    await fetch(
      url,
      {
        method: "GET",
        headers: {
          Range:
            `bytes=${requestedStart}-${requestedEnd}`
        },
        redirect: "follow"
      }
    );

  if (
    response.status === 416
  ) {
    throw new Error(
      `Remote server rejected Range ` +
      `${requestedStart}-${requestedEnd}`
    );
  }

  if (
    !response.ok &&
    response.status !== 206
  ) {
    throw new Error(
      `Remote server returned HTTP ` +
      `${response.status}`
    );
  }

  if (!response.body) {
    throw new Error(
      "Remote server returned no body"
    );
  }

  const reader =
    response.body.getReader();

  let received = 0;
  let skipped = 0;

  // true jeśli remote ignorował Range.
  const serverIgnoredRange =
    response.status === 200;

  try {
    while (
      received < wantedBytes
    ) {
      const {
        done,
        value
      } = await reader.read();

      if (done) {
        break;
      }

      if (
        !value ||
        value.byteLength === 0
      ) {
        continue;
      }

      let chunk = value;

      // ---------------------------------------------------
      // Remote zwrócił cały plik mimo Range.
      // Pomijamy początkowe bajty.
      // ---------------------------------------------------

      if (
        serverIgnoredRange &&
        skipped < requestedStart
      ) {
        const bytesToSkip =
          requestedStart -
          skipped;

        if (
          chunk.byteLength <=
          bytesToSkip
        ) {
          skipped +=
            chunk.byteLength;

          continue;
        }

        chunk =
          chunk.subarray(
            bytesToSkip
          );

        skipped =
          requestedStart;
      }

      // ---------------------------------------------------
      // Nigdy nie wyślij więcej niż requested range.
      // ---------------------------------------------------

      const remaining =
        wantedBytes -
        received;

      if (
        chunk.byteLength >
        remaining
      ) {
        chunk =
          chunk.subarray(
            0,
            remaining
          );
      }

      if (
        chunk.byteLength > 0
      ) {
        await writer.write(
          chunk
        );

        received +=
          chunk.byteLength;
      }

      if (
        received >=
        wantedBytes
      ) {
        try {
          await reader.cancel();
        } catch (_) {}

        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (_) {}
  }

  if (
    received !==
    wantedBytes
  ) {
    throw new Error(
      `Remote source returned insufficient data. ` +
      `Expected ${wantedBytes}, got ${received}. ` +
      `URL: ${url}`
    );
  }

  return received;
}


// =========================================================
// VIRTUAL MULTIPART FILE STREAM
// =========================================================
//
// Łączy fizyczne:
//
// part01
// part02
// part03
//
// w jeden logiczny:
//
// movie.mkv
//
// i mapuje Range z browsera na odpowiednią część.
//

async function streamVirtualFile(
  file,
  request
) {
  // -------------------------------------------------------
  // Ustal prawdziwe rozmiary wszystkich części.
  // -------------------------------------------------------

  const parts =
    await resolveAllPartSizes(
      file.parts
    );

  // -------------------------------------------------------
  // Całkowity rozmiar virtual file.
  // -------------------------------------------------------

  const totalSize =
    parts.reduce(
      (sum, part) =>
        sum + part.size,
      0
    );

  if (
    !Number.isFinite(totalSize) ||
    totalSize <= 0
  ) {
    return new Response(
      "Nie można ustalić rozmiaru pliku",
      {
        status: 500
      }
    );
  }

  // -------------------------------------------------------
  // RANGE
  // -------------------------------------------------------

  const rangeHeader =
    request.headers.get(
      "Range"
    );

  let start = 0;
  let end =
    totalSize - 1;

  let isRange = false;

  if (rangeHeader) {
    const parsed =
      parseRangeHeader(
        rangeHeader,
        totalSize
      );

    if (
      !parsed ||
      parsed.error
    ) {
      const headers =
        new Headers();

      headers.set(
        "Access-Control-Allow-Origin",
        "*"
      );

      headers.set(
        "Accept-Ranges",
        "bytes"
      );

      headers.set(
        "Content-Range",
        `bytes */${totalSize}`
      );

      return new Response(
        null,
        {
          status: 416,
          headers
        }
      );
    }

    start =
      parsed.start;

    end =
      parsed.end;

    isRange = true;
  }

  const contentLength =
    end - start + 1;

  // -------------------------------------------------------
  // RESPONSE HEADERS
  // -------------------------------------------------------

  const responseHeaders =
    new Headers();

  responseHeaders.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  responseHeaders.set(
    "Access-Control-Allow-Methods",
    "GET, HEAD, OPTIONS"
  );

  responseHeaders.set(
    "Access-Control-Allow-Headers",
    "Range, Content-Type, Authorization"
  );

  responseHeaders.set(
    "Access-Control-Expose-Headers",
    "Content-Range, Content-Length, Accept-Ranges, Content-Disposition"
  );

  responseHeaders.set(
    "Accept-Ranges",
    "bytes"
  );

  responseHeaders.set(
    "Content-Type",
    getMimeType(file.name)
  );

  responseHeaders.set(
    "Content-Length",
    String(contentLength)
  );

  responseHeaders.set(
    "Cache-Control",
    "no-cache, no-store, must-revalidate"
  );

  // -------------------------------------------------------
  // STATUS
  // -------------------------------------------------------

  let status = 200;

  if (isRange) {
    status = 206;

    responseHeaders.set(
      "Content-Range",
      `bytes ${start}-${end}/${totalSize}`
    );
  }

  // -------------------------------------------------------
  // HEAD
  // -------------------------------------------------------

  if (
    request.method === "HEAD"
  ) {
    return new Response(
      null,
      {
        status,
        headers: responseHeaders
      }
    );
  }

  // -------------------------------------------------------
  // STREAM
  // -------------------------------------------------------
  //
  // FixedLengthStream jest ważny w Cloudflare Workers,
  // ponieważ deklarujemy dokładną długość body.
  //

  const fixedStream =
    new FixedLengthStream(
      contentLength
    );

  const writer =
    fixedStream.writable
      .getWriter();

  // -------------------------------------------------------
  // ASYNCHRONICZNE STREAMOWANIE
  // -------------------------------------------------------

  (async () => {
    try {
      let currentPartStart = 0;

      for (
        const part of parts
      ) {
        const partStart =
          currentPartStart;

        const partEnd =
          currentPartStart +
          part.size -
          1;

        currentPartStart +=
          part.size;

        // Ta część nie przecina
        // żądanego virtual range.
        if (
          end < partStart ||
          start > partEnd
        ) {
          continue;
        }

        // -------------------------------------------------
        // Zakres lokalny wewnątrz konkretnego parta.
        // -------------------------------------------------

        const localStart =
          Math.max(
            0,
            start - partStart
          );

        const localEnd =
          Math.min(
            part.size - 1,
            end - partStart
          );

        await streamRemoteRange(
          part.url,
          localStart,
          localEnd,
          writer
        );
      }

      await writer.close();
    } catch (error) {
      console.error(
        "Błąd podczas streamowania virtual file:",
        error
      );

      try {
        await writer.abort(
          error
        );
      } catch (_) {}
    }
  })();

  return new Response(
    fixedStream.readable,
    {
      status,
      headers:
        responseHeaders
    }
  );
}


// =========================================================
// LOGIN PAGE
// =========================================================

function getLoginTemplate(
  errorMsg = "",
  redirectPath = "/"
) {
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VOD Vault - Logowanie</title>

  <link
    href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap"
    rel="stylesheet"
  >

  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Inter', sans-serif;
    }

    body {
      background:
        linear-gradient(
          135deg,
          #0d0e1b 0%,
          #1a102f 50%,
          #0b0718 100%
        );

      color: #f3f4f6;
      height: 100vh;

      display: flex;
      align-items: center;
      justify-content: center;
    }

    .login-card {
      background:
        rgba(23, 20, 41, 0.85);

      border:
        1px solid
        rgba(139, 92, 246, 0.3);

      padding: 2.5rem;
      border-radius: 16px;

      width: 100%;
      max-width: 400px;

      box-shadow:
        0 20px 40px rgba(0,0,0,0.6),
        0 0 20px rgba(139, 92, 246, 0.2);

      backdrop-filter: blur(12px);

      display: flex;
      flex-direction: column;

      gap: 1.5rem;

      text-align: center;
    }

    h1 {
      font-size: 1.5rem;

      background:
        linear-gradient(
          90deg,
          #a78bfa,
          #60a5fa
        );

      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    p {
      font-size: 0.9rem;
      color: #9ca3af;
    }

    input[type="password"] {
      width: 100%;

      padding: 12px 16px;

      border-radius: 8px;

      border:
        1px solid
        rgba(139, 92, 246, 0.3);

      background:
        rgba(13, 14, 27, 0.8);

      color: #fff;

      font-size: 1rem;

      outline: none;

      transition:
        border-color 0.2s;
    }

    input[type="password"]:focus {
      border-color: #8b5cf6;
    }

    button {
      width: 100%;

      padding: 12px;

      border-radius: 8px;

      border: none;

      background:
        linear-gradient(
          135deg,
          #8b5cf6,
          #3b82f6
        );

      color: #fff;

      font-weight: 600;
      font-size: 1rem;

      cursor: pointer;

      transition:
        transform 0.2s,
        box-shadow 0.2s;

      box-shadow:
        0 4px 12px
        rgba(139, 92, 246, 0.3);
    }

    button:hover {
      transform:
        translateY(-2px);

      box-shadow:
        0 6px 16px
        rgba(139, 92, 246, 0.5);
    }

    .error {
      color: #ef4444;
      font-size: 0.85rem;
    }
  </style>
</head>

<body>

  <div class="login-card">

    <div>
      <h1>VOD Streaming Vault</h1>

      <p>
        Wprowadź hasło, aby uzyskać dostęp
      </p>
    </div>

    <form
      action="/login"
      method="POST"
    >
      <input
        type="hidden"
        name="redirect"
        value="${escapeHtml(redirectPath)}"
      >

      <input
        type="password"
        name="password"
        placeholder="Hasło dostępu..."
        required
        autofocus
      >

      ${
        errorMsg
          ? `
            <div
              class="error"
              style="margin-top: 10px;"
            >
              ${escapeHtml(errorMsg)}
            </div>
          `
          : ""
      }

      <button
        type="submit"
        style="margin-top: 15px;"
      >
        Wejdź
      </button>
    </form>

  </div>

</body>
</html>`;
}


// =========================================================
// HTML ESCAPE
// =========================================================

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


// =========================================================
// MAIN HTML
// =========================================================

function getHtmlTemplate(
  data,
  isDemo
) {
  const pageTitle =
    isDemo
      ? "[DEMO] VOD Streaming Vault"
      : "VOD Streaming Vault";

  const jsonString =
    JSON.stringify(data)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026");

  return `<!DOCTYPE html>
<html lang="pl">

<head>

  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >

  <meta
    name="referrer"
    content="no-referrer"
  />

  <title>${escapeHtml(pageTitle)}</title>

  <link
    rel="stylesheet"
    href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"
  >

  <link
    href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap"
    rel="stylesheet"
  >

  <script
    type="module"
    src="https://cdn.jsdelivr.net/npm/movi-player/dist/element.js"
  ></script>


  <style>

    :root {
      --bg-gradient:
        linear-gradient(
          135deg,
          #0d0e1b 0%,
          #1a102f 50%,
          #0b0718 100%
        );

      --card-bg:
        rgba(23, 20, 41, 0.65);

      --border-color:
        rgba(139, 92, 246, 0.2);

      --accent-violet:
        #8b5cf6;

      --accent-blue:
        #3b82f6;

      --text-main:
        #f3f4f6;

      --text-muted:
        #9ca3af;
    }


    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Inter', sans-serif;
    }


    body {
      background:
        var(--bg-gradient);

      background-attachment:
        fixed;

      color:
        var(--text-main);

      min-height:
        100vh;

      display:
        flex;

      flex-direction:
        column;
    }


    header {
      background:
        rgba(13, 14, 27, 0.8);

      backdrop-filter:
        blur(12px);

      border-bottom:
        1px solid
        var(--border-color);

      padding:
        1rem 2rem;

      display:
        flex;

      align-items:
        center;

      justify-content:
        space-between;

      position:
        sticky;

      top:
        0;

      z-index:
        100;
    }


    .logo {
      font-size:
        1.4rem;

      font-weight:
        700;

      background:
        linear-gradient(
          90deg,
          #a78bfa,
          #60a5fa
        );

      -webkit-background-clip:
        text;

      -webkit-text-fill-color:
        transparent;

      display:
        flex;

      align-items:
        center;

      gap:
        10px;

      cursor:
        pointer;
    }


    .demo-badge {
      background:
        #ef4444;

      color:
        #fff;

      font-size:
        0.75rem;

      font-weight:
        700;

      padding:
        3px 8px;

      border-radius:
        6px;

      text-transform:
        uppercase;

      letter-spacing:
        1px;

      margin-left:
        8px;

      -webkit-text-fill-color:
        initial;
    }


    .layout {
      display:
        grid;

      grid-template-columns:
        340px 1fr;

      flex:
        1;

      height:
        calc(100vh - 65px);
    }


    .sidebar {
      background:
        var(--card-bg);

      border-right:
        1px solid
        var(--border-color);

      overflow-y:
        auto;

      padding:
        1.2rem;

      backdrop-filter:
        blur(8px);
    }


    .tree-node {
      margin-bottom:
        0.3rem;
    }


    .tree-header {
      display:
        flex;

      align-items:
        center;

      gap:
        8px;

      padding:
        8px 12px;

      border-radius:
        8px;

      cursor:
        pointer;

      user-select:
        none;

      transition:
        all 0.2s ease;

      font-size:
        0.95rem;

      font-weight:
        600;

      color:
        #e5e7eb;
    }


    .tree-header:hover {
      background:
        rgba(139, 92, 246, 0.15);

      color:
        #a78bfa;
    }


    .tree-children {
      margin-left:
        16px;

      padding-left:
        8px;

      border-left:
        1px solid
        rgba(139, 92, 246, 0.15);

      display:
        none;
    }


    .tree-children.open {
      display:
        block;
    }


    .file-item {
      display:
        flex;

      align-items:
        center;

      justify-content:
        space-between;

      padding:
        6px 10px;

      border-radius:
        6px;

      cursor:
        pointer;

      font-size:
        0.85rem;

      color:
        var(--text-muted);

      margin-top:
        2px;

      transition:
        background 0.2s,
        color 0.2s;
    }


    .file-item:hover,
    .file-item.active {
      background:
        linear-gradient(
          90deg,
          rgba(139, 92, 246, 0.25),
          rgba(59, 130, 246, 0.1)
        );

      color:
        #fff;
    }


    .file-name {
      white-space:
        nowrap;

      overflow:
        hidden;

      text-overflow:
        ellipsis;
    }


    .main-content {
      padding:
        2rem;

      overflow-y:
        auto;

      display:
        flex;

      flex-direction:
        column;

      gap:
        1.5rem;

      align-items:
        center;
    }


    .player-container {
      width:
        100%;

      max-width:
        1000px;

      background:
        #000;

      border-radius:
        12px;

      overflow:
        hidden;

      box-shadow:
        0 20px 40px rgba(0, 0, 0, 0.6),
        0 0 20px rgba(139, 92, 246, 0.2);

      border:
        1px solid
        var(--border-color);

      aspect-ratio:
        16/9;

      display:
        flex;

      align-items:
        center;

      justify-content:
        center;

      position:
        relative;
    }


    movi-player {
      width:
        100%;

      height:
        100%;

      display:
        block;
    }


    .control-panel {
      width:
        100%;

      max-width:
        1000px;

      background:
        var(--card-bg);

      border:
        1px solid
        var(--border-color);

      border-radius:
        12px;

      padding:
        1.2rem 1.5rem;

      backdrop-filter:
        blur(10px);

      display:
        flex;

      flex-direction:
        column;

      gap:
        1rem;
    }


    .panel-top {
      display:
        flex;

      align-items:
        center;

      justify-content:
        space-between;

      gap:
        1rem;

      flex-wrap:
        wrap;
    }


    .media-info {
      display:
        flex;

      flex-direction:
        column;

      gap:
        4px;

      min-width:
        0;
    }


    .media-title {
      font-size:
        1.1rem;
      font-weight:
        600;

      color:
        #fff;

      overflow:
        hidden;

      text-overflow:
        ellipsis;

      white-space:
        nowrap;
    }


    .media-path {
      font-size:
        0.8rem;

      color:
        var(--accent-violet);

      overflow:
        hidden;

      text-overflow:
        ellipsis;

      white-space:
        nowrap;
    }


    .action-buttons {
      display:
        flex;

      gap:
        12px;

      flex-wrap:
        wrap;
    }


    .btn {
      display:
        inline-flex;

      align-items:
        center;

      gap:
        8px;

      padding:
        10px 18px;

      border-radius:
        8px;

      font-weight:
        600;

      font-size:
        0.88rem;

      text-decoration:
        none;

      cursor:
        pointer;

      border:
        none;

      transition:
        all 0.2s ease;
    }


    .btn-vlc {
      background:
        linear-gradient(
          135deg,
          #ff8800,
          #ea580c
        );

      color:
        #fff;

      box-shadow:
        0 4px 12px
        rgba(234, 88, 12, 0.3);
    }


    .btn-vlc:hover {
      transform:
        translateY(-2px);

      box-shadow:
        0 6px 16px
        rgba(234, 88, 12, 0.5);
    }


    .btn-download {
      background:
        linear-gradient(
          135deg,
          var(--accent-violet),
          var(--accent-blue)
        );

      color:
        #fff;

      box-shadow:
        0 4px 12px
        rgba(139, 92, 246, 0.3);
    }


    .btn-download:hover {
      transform:
        translateY(-2px);

      box-shadow:
        0 6px 16px
        rgba(139, 92, 246, 0.5);
    }


    .empty-state {
      display:
        flex;

      flex-direction:
        column;

      align-items:
        center;

      justify-content:
        center;

      color:
        var(--text-muted);

      gap:
        1rem;

      text-align:
        center;

      padding:
        2rem;
    }


    @media (max-width: 900px) {

      .layout {
        grid-template-columns:
          1fr;

        height:
          auto;
      }

      .sidebar {
        max-height:
          300px;
      }

      .main-content {
        padding:
          1rem;
      }

    }

  </style>

</head>


<body>


<header>

  <div
    class="logo"
    onclick="navigateTo('/')"
  >

    <i class="fa-solid fa-play-circle"></i>

    VOD Vault

    ${
      isDemo
        ? '<span class="demo-badge">Tryb Demo</span>'
        : ''
    }

  </div>

</header>


<div class="layout">


  <div
    class="sidebar"
    id="treeView"
  ></div>


  <div class="main-content">


    <div
      class="player-container"
      id="playerWrapper"
    >

      <div
        class="empty-state"
        id="emptyState"
      >

        <i
          class="fa-solid fa-film"
          style="
            font-size: 3rem;
            color: var(--accent-violet);
          "
        ></i>

        <p>
          Wybierz plik z listy po lewej stronie,
          aby rozpocząć odtwarzanie
        </p>

      </div>

    </div>


    <div
      class="control-panel"
      id="controlPanel"
      style="display: none;"
    >

      <div class="panel-top">


        <div class="media-info">

          <span
            class="media-title"
            id="currentTitle"
          >
            -
          </span>

          <span
            class="media-path"
            id="currentPath"
          >
            -
          </span>

        </div>


        <div class="action-buttons">

          <button
            id="vlcBtn"
            class="btn btn-vlc"
          >

            <i class="fa-solid fa-cone"></i>

            Odtwórz w VLC

          </button>


          <a
            id="downloadBtn"
            href="#"
            class="btn btn-download"
          >

            <i class="fa-solid fa-download"></i>

            Pobierz

          </a>

        </div>


      </div>

    </div>

  </div>

</div>


<script>

  // -------------------------------------------------------
  // DATA
  // -------------------------------------------------------

  const data =
    ${jsonString};


  let activePath = "";


  // -------------------------------------------------------
  // NAVIGATION
  // -------------------------------------------------------

  function navigateTo(
    urlPath
  ) {
    window.history.pushState(
      {},
      "",
      urlPath
    );

    handleRouting();
  }


  // -------------------------------------------------------
  // CREATE FILE ELEMENT
  // -------------------------------------------------------

  function createFileElement(
    file,
    fullPath
  ) {
    const fileEl =
      document.createElement(
        "div"
      );

    fileEl.className =
      "file-item";

    fileEl.setAttribute(
      "data-path",
      fullPath
    );


    const nameSpan =
      document.createElement(
        "span"
      );

    nameSpan.className =
      "file-name";


    const icon =
      document.createElement(
        "i"
      );

    icon.className =
      "fa-regular fa-file-video";

    icon.style.marginRight =
      "6px";


    nameSpan.appendChild(
      icon
    );

    nameSpan.appendChild(
      document.createTextNode(
        file.name
      )
    );


    fileEl.appendChild(
      nameSpan
    );


    fileEl.onclick = (
      event
    ) => {

      if (event) {
        event.stopPropagation();
      }

      navigateTo(
        "/" +
        fullPath
          .split("/")
          .map(
            encodeURIComponent
          )
          .join("/")
      );
    };


    return fileEl;
  }


  // -------------------------------------------------------
  // RENDER TREE
  // -------------------------------------------------------

  function renderTree(
    node,
    container,
    path = ""
  ) {

    for (
      const key of
      Object.keys(node).sort()
    ) {

      const currentPath =
        path
          ? path + "/" + key
          : key;

      const target =
        node[key];


      const dirNode =
        document.createElement(
          "div"
        );

      dirNode.className =
        "tree-node";


      const header =
        document.createElement(
          "div"
        );

      header.className =
        "tree-header";

      header.setAttribute(
        "data-dir-path",
        currentPath
      );


      const childrenContainer =
        document.createElement(
          "div"
        );

      childrenContainer.className =
        "tree-children";


      if (
        Array.isArray(target)
      ) {

        header.innerHTML =
          '<i class="fa-solid fa-folder" style="color: #a78bfa;"></i> ' +
          escapeHtmlClient(key);


        const files =
          [...target].sort(
            (a, b) =>
              a.name.localeCompare(
                b.name,
                undefined,
                {
                  numeric: true,
                  sensitivity: "base"
                }
              )
          );


        files.forEach(
          file => {

            const fileFullPath =
              currentPath +
              "/" +
              file.name;

            childrenContainer.appendChild(
              createFileElement(
                file,
                fileFullPath
              )
            );

          }
        );

      } else if (
        typeof target === "object" &&
        target !== null
      ) {

        header.innerHTML =
          '<i class="fa-solid fa-folder" style="color: #60a5fa;"></i> ' +
          escapeHtmlClient(key);


        renderTree(
          target,
          childrenContainer,
          currentPath
        );
      }


      header.onclick = (
        event
      ) => {

        event.stopPropagation();


        const isOpen =
          childrenContainer.classList.contains(
            "open"
          );


        const icon =
          header.querySelector(
            "i"
          );


        if (isOpen) {

          childrenContainer.classList.remove(
            "open"
          );

          if (icon) {
            icon.className =
              "fa-solid fa-folder";
          }

        } else {

          childrenContainer.classList.add(
            "open"
          );

          if (icon) {
            icon.className =
              "fa-solid fa-folder-open";
          }
        }


        navigateTo(
          "/" +
          currentPath
            .split("/")
            .map(
              encodeURIComponent
            )
            .join("/")
        );
      };


      dirNode.appendChild(
        header
      );

      dirNode.appendChild(
        childrenContainer
      );

      container.appendChild(
        dirNode
      );
    }
  }


  // -------------------------------------------------------
  // CLIENT HTML ESCAPE
  // -------------------------------------------------------

  function escapeHtmlClient(
    value
  ) {
    return String(value ?? "")
      .replace(
        /&/g,
        "&amp;"
      )
      .replace(
        /</g,
        "&lt;"
      )
      .replace(
        />/g,
        "&gt;"
      )
      .replace(
        /"/g,
        "&quot;"
      )
      .replace(
        /'/g,
        "&#039;"
      );
  }


  // -------------------------------------------------------
  // LOAD MEDIA
  // -------------------------------------------------------

  function loadMedia(
    file,
    path
  ) {

    const wrapper =
      document.getElementById(
        "playerWrapper"
      );

    const controlPanel =
      document.getElementById(
        "controlPanel"
      );


    const encodedPath =
      path
        .split("/")
        .map(
          encodeURIComponent
        )
        .join("/");


    const maskedDownloadUrl =
      window.location.origin +
      "/" +
      encodedPath +
      "?download=true";


    const maskedStreamUrl =
      window.location.origin +
      "/" +
      encodedPath +
      "?stream=true";


    activePath =
      path;


    document.getElementById(
      "currentTitle"
    ).innerText =
      file.name;


    document.getElementById(
      "currentPath"
    ).innerText =
      path
        .split("/")
        .join(" / ");


    document.getElementById(
      "downloadBtn"
    ).href =
      maskedDownloadUrl;


    // Recreate player.
    //
    // The player makes normal HTTP Range requests
    // to this virtual endpoint.
    //
    wrapper.innerHTML =
      '<movi-player ' +
      'src="' +
      escapeAttribute(
        maskedStreamUrl
      ) +
      '" ' +
      'controls ' +
      'autoplay ' +
      'crossorigin="anonymous">' +
      '</movi-player>';


    controlPanel.style.display =
      "flex";
  }


  // -------------------------------------------------------
  // ATTRIBUTE ESCAPE
  // -------------------------------------------------------

  function escapeAttribute(
    value
  ) {
    return String(value ?? "")
      .replace(
        /&/g,
        "&amp;"
      )
      .replace(
        /"/g,
        "&quot;"
      )
      .replace(
        /</g,
        "&lt;"
      )
      .replace(
        />/g,
        "&gt;"
      );
  }


  // -------------------------------------------------------
  // FIND FILE
  // -------------------------------------------------------

  function findFileByPathJS(
    structure,
    pathParts
  ) {

    let current =
      structure;


    for (
      let i = 0;
      i < pathParts.length;
      i++
    ) {

      const part =
        pathParts[i];


      if (!current) {
        return null;
      }


      if (
        Array.isArray(current)
      ) {

        return (
          current.find(
            file =>
              file.name === part
          ) || null
        );

      }


      if (
        typeof current === "object"
      ) {

        current =
          current[part];

      } else {

        return null;
      }
    }


    return current;
  }


  // -------------------------------------------------------
  // FIND FILE ELEMENT
  // -------------------------------------------------------

  function findFileElement(
    path
  ) {

    const items =
      document.querySelectorAll(
        ".file-item"
      );


    for (
      const item of items
    ) {

      if (
        item.getAttribute(
          "data-path"
        ) === path
      ) {
        return item;
      }
    }


    return null;
  }


  // -------------------------------------------------------
  // FIND DIRECTORY HEADER
  // -------------------------------------------------------

  function findHeaderElement(
    path
  ) {

    const items =
      document.querySelectorAll(
        ".tree-header"
      );


    for (
      const item of items
    ) {

      if (
        item.getAttribute(
          "data-dir-path"
        ) === path
      ) {
        return item;
      }
    }


    return null;
  }


  // -------------------------------------------------------
  // HANDLE ROUTING
  // -------------------------------------------------------

  function handleRouting() {

    const rawParts =
      window.location.pathname
        .split("/")
        .filter(
          part => part.length > 0
        );


    const decodedParts =
      rawParts.map(
        part =>
          decodeURIComponent(part)
      );


    const currentUrlPath =
      decodedParts.join("/");


    document
      .querySelectorAll(
        ".file-item"
      )
      .forEach(
        element =>
          element.classList.remove(
            "active"
          )
      );


    // -----------------------------------------------------
    // HOME
    // -----------------------------------------------------

    if (!currentUrlPath) {

      document
        .querySelectorAll(
          ".tree-children"
        )
        .forEach(
          element =>
            element.classList.remove(
              "open"
            )
        );


      document
        .querySelectorAll(
          ".tree-header i"
        )
        .forEach(
          icon =>
            icon.className =
              "fa-solid fa-folder"
        );


      document.getElementById(
        "playerWrapper"
      ).innerHTML =
        '<div class="empty-state">' +
        '<i class="fa-solid fa-film" ' +
        'style="font-size: 3rem; color: var(--accent-violet);"></i>' +
        '<p>' +
        'Wybierz plik z listy po lewej stronie, ' +
        'aby rozpocząć odtwarzanie' +
        '</p>' +
        '</div>';


      document.getElementById(
        "controlPanel"
      ).style.display =
        "none";


      activePath =
        "";

      return;
    }


    // -----------------------------------------------------
    // FILE
    // -----------------------------------------------------

    const fileObj =
      findFileByPathJS(
        data,
        decodedParts
      );


    // Plik może być:
    // - zwykłym plikiem z polem url
    // - plikiem wieloczęściowym z polem parts
    // Folder może również być obiektem albo tablicą, więc samo
    // sprawdzenie fileObj błędnie traktuje bezpośredni URL folderu jako plik.
    //
    // Nie zmieniamy obsługi multipart — tylko poprawnie rozróżniamy
    // plik od folderu na potrzeby routingu klienta.
    if (
      fileObj &&
      !Array.isArray(fileObj) &&
      (
        typeof fileObj.url === "string" ||
        Array.isArray(fileObj.parts)
      )
    ) {

      const targetFileEl =
        findFileElement(
          currentUrlPath
        );


      if (targetFileEl) {

        targetFileEl.classList.add(
          "active"
        );


        let parent =
          targetFileEl.closest(
            ".tree-children"
          );


        while (parent) {

          parent.classList.add(
            "open"
          );


          const header =
            parent.previousElementSibling;


          if (
            header &&
            header.classList.contains(
              "tree-header"
            )
          ) {

            const icon =
              header.querySelector(
                "i"
              );


            if (icon) {
              icon.className =
                "fa-solid fa-folder-open";
            }
          }


          parent =
            parent.parentElement
              ?.closest(
                ".tree-children"
              );
        }
      }


      loadMedia(
        fileObj,
        currentUrlPath
      );


    } else {

      // ---------------------------------------------------
      // DIRECTORY
      // ---------------------------------------------------

      const targetHeaderEl =
        findHeaderElement(
          currentUrlPath
        );


      if (targetHeaderEl) {

        const children =
          targetHeaderEl.nextElementSibling;


        if (
          children &&
          children.classList.contains(
            "tree-children"
          )
        ) {

          children.classList.add(
            "open"
          );


          const icon =
            targetHeaderEl.querySelector(
              "i"
            );


          if (icon) {
            icon.className =
              "fa-solid fa-folder-open";
          }
        }


        let ancestor =
          targetHeaderEl.closest(
            ".tree-children"
          );


        while (ancestor) {

          ancestor.classList.add(
            "open"
          );


          const header =
            ancestor.previousElementSibling;


          if (
            header &&
            header.classList.contains(
              "tree-header"
            )
          ) {

            const icon =
              header.querySelector(
                "i"
              );


            if (icon) {
              icon.className =
                "fa-solid fa-folder-open";
            }
          }


          ancestor =
            ancestor.parentElement
              ?.closest(
                ".tree-children"
              );
        }
      }
    }
  }


  // -------------------------------------------------------
  // VLC
  // -------------------------------------------------------

  document.getElementById(
    "vlcBtn"
  ).onclick = () => {

    if (!activePath) {
      return;
    }


    const encodedPath =
      activePath
        .split("/")
        .map(
          encodeURIComponent
        )
        .join("/");


    const streamUrl =
      window.location.origin +
      "/" +
      encodedPath +
      "?stream=true";


    // VLC receives the virtual file endpoint.
    //
    // It can therefore read the multipart file as one
    // continuous resource and issue Range requests itself.
    //
    window.location.href =
      "vlc://" +
      streamUrl;
  };


  // -------------------------------------------------------
  // INITIALIZE
  // -------------------------------------------------------

  const treeView =
    document.getElementById(
      "treeView"
    );


  renderTree(
    data,
    treeView
  );


  handleRouting();


  // Browser back / forward.
  window.onpopstate =
    () => {
      handleRouting();
    };

</script>

</body>
</html>`;
}


// =========================================================
// CLOUDFLARE WORKER
// =========================================================

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    const url =
      new URL(
        request.url
      );


    const cookieHeader =
      request.headers.get(
        "Cookie"
      );


    const clientToken =
      getCookie(
        cookieHeader,
        "access_token"
      );


    const currentFullPath =
      url.pathname +
      url.search;


    const pathParts =
      url.pathname
        .split("/")
        .filter(
          part =>
            part.length > 0
        );


    const isAssetRequest =
      pathParts.length > 0 &&
      (
        url.searchParams.has(
          "download"
        ) ||
        url.searchParams.has(
          "stream"
        )
      );


    const requiresAuth =
      (
        pathParts.length === 0 ||
        !isAssetRequest
      ) &&
      url.pathname !==
        "/cors-proxy" &&
      url.pathname !==
        "/api/update";


    // =====================================================
    // LOGIN
    // =====================================================

    if (
      request.method === "POST" &&
      url.pathname === "/login"
    ) {

      try {

        const formData =
          await request.formData();


        const password =
          formData.get(
            "password"
          );


        const redirectTo =
          formData.get(
            "redirect"
          ) ||
          "/";


        if (
          password ===
          ACCESS_PASSWORD
        ) {

          return new Response(
            null,
            {
              status: 302,

              headers: {

                "Location":
                  redirectTo,

                "Set-Cookie":
                  `access_token=${encodeURIComponent(
                    ACCESS_PASSWORD
                  )}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`

              }
            }
          );

        }


        return new Response(
          getLoginTemplate(
            "Błędne hasło! Spróbuj ponownie.",
            redirectTo
          ),
          {
            status: 401,

            headers: {
              "Content-Type":
                "text/html; charset=utf-8"
            }
          }
        );

      } catch (error) {

        return new Response(
          "Błąd autoryzacji",
          {
            status: 400
          }
        );
      }
    }


    // =====================================================
    // AUTH
    // =====================================================

    if (
      requiresAuth &&
      clientToken !==
        ACCESS_PASSWORD
    ) {

      return new Response(
        getLoginTemplate(
          "",
          currentFullPath
        ),
        {
          headers: {
            "Content-Type":
              "text/html; charset=utf-8"
          }
        }
      );
    }


    // =====================================================
    // CORS PROXY
    // =====================================================

    if (
      url.pathname ===
      "/cors-proxy"
    ) {

      const targetUrl =
        url.searchParams.get(
          "url"
        );


      if (!targetUrl) {

        return new Response(
          "Missing url param",
          {
            status: 400
          }
        );
      }


      // OPTIONS
      if (
        request.method ===
        "OPTIONS"
      ) {

        return new Response(
          null,
          {
            headers: {

              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Methods":
                "GET, HEAD, OPTIONS",

              "Access-Control-Allow-Headers":
                "Range, Content-Type, Authorization",

              "Access-Control-Max-Age":
                "86400"

            }
          }
        );
      }


      try {

        const fetchHeaders =
          new Headers();


        if (
          request.headers.has(
            "Range"
          )
        ) {

          fetchHeaders.set(
            "Range",
            request.headers.get(
              "Range"
            )
          );
        }


        const originResponse =
          await fetch(
            targetUrl,
            {
              headers:
                fetchHeaders,

              method:
                request.method,

              redirect:
                "follow"
            }
          );


        const newHeaders =
          new Headers(
            originResponse.headers
          );


        newHeaders.set(
          "Access-Control-Allow-Origin",
          "*"
        );

        newHeaders.set(
          "Access-Control-Allow-Methods",
          "GET, HEAD, OPTIONS"
        );

        newHeaders.set(
          "Access-Control-Allow-Headers",
          "Range, Content-Type"
        );

        newHeaders.set(
          "Access-Control-Expose-Headers",
          "Content-Range, Content-Length, Accept-Ranges"
        );


        return new Response(
          originResponse.body,
          {
            status:
              originResponse.status,

            statusText:
              originResponse.statusText,

            headers:
              newHeaders
          }
        );

      } catch (error) {

        return new Response(
          "Error fetching target via proxy: " +
          (error?.message || error),
          {
            status: 500
          }
        );
      }
    }


    // =====================================================
    // KV UPDATE API
    // =====================================================

    if (
      url.pathname ===
        "/api/update" &&
      request.method ===
        "POST"
    ) {

      const authHeader =
        request.headers.get(
          "Authorization"
        );


      const validSecret =
        env.API_SECRET ||
        API_SECRET;


      if (
        authHeader !==
        `Bearer ${validSecret}`
      ) {

        return new Response(
          JSON.stringify({
            error:
              "Unauthorized"
          }),
          {
            status: 401,

            headers: {
              "Content-Type":
                "application/json"
            }
          }
        );
      }


      if (!env.MEDIA_KV) {

        return new Response(
          JSON.stringify({
            error:
              "Brak podpiętego KV Namespace (env.MEDIA_KV)!"
          }),
          {
            status: 500,

            headers: {
              "Content-Type":
                "application/json"
            }
          }
        );
      }


      try {

        const data =
          await request.json();


        await env.MEDIA_KV.put(
          "STRUCTURE_DATA",
          JSON.stringify(data)
        );


        return new Response(
          JSON.stringify({
            status:
              "success"
          }),
          {
            headers: {
              "Content-Type":
                "application/json"
            }
          }
        );

      } catch (error) {

        return new Response(
          JSON.stringify({
            error:
              "Invalid JSON",
            message:
              error?.message || String(error)
          }),
          {
            status: 400,

            headers: {
              "Content-Type":
                "application/json"
            }
          }
        );
      }
    }


    // =====================================================
    // LOAD MEDIA DATA
    // =====================================================

    let mediaData =
      null;

    let isDemo =
      false;


    if (env.MEDIA_KV) {

      mediaData =
        await env.MEDIA_KV.get(
          "STRUCTURE_DATA",
          {
            type: "json"
          }
        );
    }


    if (
      !mediaData ||
      Object.keys(
        mediaData
      ).length === 0
    ) {

      mediaData =
        DEMO_DATA;

      isDemo =
        true;
    }


    const processedMediaData =
      processStructure(
        mediaData
      );


    // =====================================================
    // STREAM / DOWNLOAD
    // =====================================================

    if (
      pathParts.length > 0 &&
      (
        url.searchParams.has(
          "download"
        ) ||
        url.searchParams.has(
          "stream"
        )
      )
    ) {

      const rawFileObj =
        findFileByPath(
          processedMediaData,
          pathParts
        );


      if (rawFileObj) {

        // OPTIONS
        if (
          request.method ===
          "OPTIONS"
        ) {

          return new Response(
            null,
            {
              headers: {

                "Access-Control-Allow-Origin":
                  "*",

                "Access-Control-Allow-Methods":
                  "GET, HEAD, OPTIONS",

                "Access-Control-Allow-Headers":
                  "Range, Content-Type, Authorization",

                "Access-Control-Max-Age":
                  "86400"

              }
            }
          );
        }


        // Only GET / HEAD here.
        if (
          request.method !== "GET" &&
          request.method !== "HEAD"
        ) {

          return new Response(
            "Method Not Allowed",
            {
              status: 405,

              headers: {
                Allow:
                  "GET, HEAD, OPTIONS"
              }
            }
          );
        }


        const normalized =
          normalizeFile(
            rawFileObj
          );


        if (!normalized) {

          return new Response(
            "Nieprawidłowa struktura pliku",
            {
              status: 500
            }
          );
        }


        try {

          const response =
            await streamVirtualFile(
              normalized,
              request
            );


          // ------------------------------------------------
          // DOWNLOAD
          // ------------------------------------------------

          if (
            url.searchParams.has(
              "download"
            )
          ) {

            const fileNameEncoded =
              encodeURIComponent(
                normalized.name
              );


            // RFC 5987 compatible filename.
            response.headers.set(
              "Content-Disposition",
              `attachment; filename="${normalized.name.replace(/"/g, '\\"')}"; filename*=UTF-8''${fileNameEncoded}`
            );
          }


          return response;

        } catch (error) {

          console.error(
            "Virtual file error:",
            error
          );


          return new Response(
            "Błąd podczas obsługi pliku: " +
            (
              error?.message ||
              String(error)
            ),
            {
              status: 502,

              headers: {
                "Content-Type":
                  "text/plain; charset=utf-8"
              }
            }
          );
        }

      } else {

        return new Response(
          "Nie znaleziono pliku pod podaną ścieżką",
          {
            status: 404
          }
        );
      }
    }


    // =====================================================
    // HTML
    // =====================================================

    return new Response(
      getHtmlTemplate(
        processedMediaData,
        isDemo
      ),
      {
        headers: {
          "Content-Type":
            "text/html; charset=utf-8"
        }
      }
    );
  }
};
