// /api/upload-image.js
// Uploads an image file to Vercel Blob storage and returns its public URL.
// Used by the admin panel for posting events with images.
//
// Requires the BLOB_READ_WRITE_TOKEN env var (auto-set by Vercel when you
// enable Blob storage in the project's Storage tab).

const ADMIN_SECRET = process.env.DRIPPY_EVENTS_SECRET || '2026Drippyrewards';

// Vercel Blob has a put() function but their SDK requires the package.
// To stay zero-deps we POST directly to their REST API.
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_API = 'https://blob.vercel-storage.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Admin-Secret');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  // Auth — same admin secret as events.js
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== ADMIN_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (!BLOB_TOKEN) {
    res.status(500).json({
      error: 'Vercel Blob not configured. Enable Blob storage in Vercel project settings (Storage tab) and redeploy.'
    });
    return;
  }

  // Filename from header (sanitized) — fall back to a timestamp
  const rawName = req.headers['x-filename'] || 'image';
  // Strip path bits + non-safe chars
  const safeName = String(rawName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const ts = Date.now();
  const blobPath = 'events/' + ts + '-' + safeName;

  try {
    // Collect the raw body (binary)
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    if (body.length === 0) {
      res.status(400).json({ error: 'empty body' });
      return;
    }
    // 8 MB cap — Vercel serverless functions have a 4.5MB request body limit
    // on Hobby plan; we'll be a bit conservative
    if (body.length > 4 * 1024 * 1024) {
      res.status(413).json({ error: 'file too large (4 MB max)' });
      return;
    }

    // Upload to Vercel Blob via REST API
    const blobUrl = BLOB_API + '/' + encodeURIComponent(blobPath);
    const contentType = req.headers['content-type'] || 'application/octet-stream';

    const uploadRes = await fetch(blobUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + BLOB_TOKEN,
        'Content-Type': contentType,
        'x-content-type': contentType,
        'x-api-version': '7'
      },
      body
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error('[blob] upload failed:', uploadRes.status, errText);
      res.status(502).json({
        error: 'Blob upload failed',
        status: uploadRes.status,
        detail: errText.slice(0, 200)
      });
      return;
    }

    const result = await uploadRes.json();
    // result.url is the public URL we want
    res.status(200).json({
      success: true,
      url: result.url || result.downloadUrl,
      pathname: result.pathname || blobPath
    });

  } catch (err) {
    console.error('[upload-image]', err);
    res.status(500).json({ error: 'upload failed', detail: err.message });
  }
};
