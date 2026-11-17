# Reframe

A small text rewriting website. Paste text or import a PDF, describe a new subject, then copy the rewrite or download it as a PDF.

## Preview it locally

You need Node.js 22.13 or newer and npm.

From PowerShell opened at the project root, run:

```powershell
Set-Location .\outputs
npm install
npm start
```

Leave that PowerShell window open and open [http://localhost:4173](http://localhost:4173) in a browser on the same computer. Close the server with **Ctrl+C**. If the browser says `ERR_CONNECTION_REFUSED`, the server is not running on that computer yet.

You can preview the page without a Gemini key. Rewriting stays disabled until the server key is configured. PDFs must contain selectable text; scanned image PDFs need OCR first. Uploads are limited to 20 MB and 250 pages.

## Enable rewrites

1. Copy `.env.example` to `.env` in the `outputs` folder.
2. Replace the example value with a Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey).
3. Start or restart the server with `npm start`.

The API key stays on the server and is not included in the web page. Extracted text is sent to Google Gemini only when you generate a rewrite. The app does not save uploaded files, pasted text, or generated output.

## Hosting

Set `GEMINI_API_KEY` as a server environment variable on your host, then run `npm start`. Visitors do not need their own API key. Add your host's rate limits and usage monitoring before opening the service to the public.

PDF input uses Mozilla PDF.js. Downloadable output PDFs are created with PDFKit. The app uses Google's Gemini Interactions API with the `gemini-3.8-flash` model.

