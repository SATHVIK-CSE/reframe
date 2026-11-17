const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { PDFDocument } = require("pdfkit");

const API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const ENV_PATH = path.join(__dirname, ".env");

function loadLocalEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadLocalEnv();
const PORT = Number(process.env.PORT || 4173);

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let byteCount = 0;
    let tooLarge = false;
    req.on("data", chunk => {
      if (tooLarge) return;
      byteCount += chunk.length;
      if (byteCount > 300_000) {
        tooLarge = true;
        const error = new Error("Request is too large. Try a shorter text.");
        error.status = 413;
        reject(error);
        req.resume();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        const parseError = new Error("Request body must be valid JSON.");
        parseError.status = 400;
        reject(parseError);
      }
    });
    req.on("error", error => {
      if (!tooLarge) reject(error);
    });
  });
}

function getBinaryBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteCount = 0;
    let tooLarge = false;
    req.on("data", chunk => {
      if (tooLarge) return;
      byteCount += chunk.length;
      if (byteCount > maxBytes) {
        tooLarge = true;
        const error = new Error("This PDF is too large. Choose a file under 20 MB.");
        error.status = 413;
        reject(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
    req.on("error", error => {
      if (!tooLarge) reject(error);
    });
  });
}

async function extractPdfText(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  try {
    if (document.numPages > 250) {
      const error = new Error("This PDF has more than 250 pages. Split it into smaller files.");
      error.status = 413;
      throw error;
    }
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const { items } = await page.getTextContent();
      const lines = [];
      let line = "";
      for (const item of items) {
        if (typeof item.str !== "string" || !item.str) continue;
        if (line) line += " ";
        line += item.str;
        if (item.hasEOL) {
          lines.push(line.trim());
          line = "";
        }
      }
      if (line.trim()) lines.push(line.trim());
      const pageText = lines.join("\n").trim();
      if (pageText) pages.push(pageText);
      page.cleanup();
    }
    return { text: pages.join("\n\n"), pages: document.numPages };
  } finally {
    await document.destroy();
  }
}

function createPdf(text) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: "A4", margins: { top: 54, right: 58, bottom: 54, left: 58 }, info: { Title: "Reframed text" } });
    const chunks = [];
    document.on("data", chunk => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    document.font("Times-Roman").fontSize(12).text(text, { lineGap: 3, paragraphGap: 8 });
    document.end();
  });
}

const requestTimes = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const recent = (requestTimes.get(ip) || []).filter(time => now - time < 60_000);
  if (recent.length >= 20) {
    requestTimes.set(ip, recent);
    return true;
  }
  recent.push(now);
  requestTimes.set(ip, recent);
  if (requestTimes.size > 5000) {
    for (const [address, times] of requestTimes) {
      if (!times.some(time => now - time < 60_000)) requestTimes.delete(address);
    }
  }
  return false;
}

async function callGemini(prompt) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      model: "gemini-3.8-flash",
      input: prompt,
      store: false,
      generation_config: { thinking_level: "low" }
    }),
    signal: AbortSignal.timeout(90_000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || "Gemini returned an error (" + response.status + ").";
    throw new Error(message);
  }
  const output = (data.steps || [])
    .filter(step => step.type === "model_output")
    .flatMap(step => step.content || [])
    .filter(part => part.type === "text")
    .map(part => part.text || "")
    .join("\n")
    .trim();

  if (!output) throw new Error("Gemini returned an empty rewrite. Please try again.");
  return output;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/status") {
    return json(res, 200, { ready: Boolean(process.env.GEMINI_API_KEY) });
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    });
    return fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
  }

  if (req.method === "POST" && url.pathname === "/api/extract-pdf") {
    if (!(req.headers["content-type"] || "").toLowerCase().includes("application/pdf")) {
      return json(res, 415, { error: "Upload a PDF file to import its text." });
    }
    try {
      const buffer = await getBinaryBody(req, 20 * 1024 * 1024);
      if (!buffer.length || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
        return json(res, 400, { error: "This file is not a valid PDF." });
      }
      const result = await extractPdfText(buffer);
      if (!result.text) {
        return json(res, 422, { error: "No selectable text was found. Scanned image PDFs need OCR before upload." });
      }
      return json(res, 200, result);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      return json(res, error.status || 422, { error: error.status ? error.message : "Could not read this PDF. It may be password-protected or damaged." });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/export-pdf") {
    try {
      const body = await getBody(req);
      if (typeof body.text !== "string" || !body.text.trim()) return json(res, 400, { error: "There is no generated text to export." });
      if (body.text.length > 250_000) return json(res, 413, { error: "This rewrite is too long to export as one PDF." });
      const pdf = await createPdf(body.text);
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": pdf.length,
        "content-disposition": 'attachment; filename="reframed-text.pdf"',
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      });
      return res.end(pdf);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      return json(res, error.status || 500, { error: error.message || "Could not create the PDF." });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/rewrite") {
    const ip = req.socket.remoteAddress || "unknown";
    if (isRateLimited(ip)) return json(res, 429, { error: "Too many rewrites in a short time. Please wait a minute and try again." });
    if (!process.env.GEMINI_API_KEY) {
      return json(res, 503, { error: "The site owner needs to configure the Gemini service first." });
    }
    try {
      const body = await getBody(req);
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        return json(res, 400, { error: "A rewrite prompt is required." });
      }
      if (body.prompt.length > 250_000) {
        return json(res, 413, { error: "This text is too long to send. Try a shorter version." });
      }
      const text = await callGemini(body.prompt);
      return json(res, 200, { text });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      return json(res, error.status || 500, { error: error.message || "Could not reach Gemini. Please try again." });
    }
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Reframe is ready at http://localhost:" + PORT);
});

