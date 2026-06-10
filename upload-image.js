// /api/upload-image.js
// Uploads an image file to Vercel Blob storage and returns its public URL.
// Used by the admin panel for posting events with images.

const ADMIN_SECRET = process.env.DRIPPY_EVENTS_SECRET;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_API = 'https://blob.vercel-storage.com';

// Vercel Node.js runtime — disable body parsing so we get the raw stream
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Admin-Secret');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!BLOB_TOKEN) {
    return res.status(500).json({
      error: 'Vercel Blob not configured. Enable Blob storage in Vercel project settings.'
    });
  }

  const rawName = req.headers['x-filename'] || ('image_' + Date.now());
  const safeName = String(rawName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const blobPath = 'events/' + Date.now() + '-' + safeName;
  const contentType = (req.headers['content-type'] || 'image/jpeg').split(';')[0].trim();

  try {
    // Read body into buffer using Promise — avoids ReadableStream close issues
    const body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

    if (!body || body.length === 0) {
      return res.status(400).json({ error: 'empty body — no file received' });
    }
    if (body.length > 4 * 1024 * 1024) {
      return res.status(413).json({ error: 'file too large (4 MB max)' });
    }

    // PUT to Vercel Blob REST API
    const uploadRes = await fetch(`${BLOB_API}/${encodeURIComponent(blobPath)}`, {
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
      return res.status(502).json({
        error: 'Blob upload failed',
        status: uploadRes.status,
        detail: errText.slice(0, 300)
      });
    }

    const result = await uploadRes.json();
    return res.status(200).json({
      success: true,
      url: result.url || result.downloadUrl,
      pathname: result.pathname || blobPath
    });

  } catch (err) {
    console.error('[upload-image]', err);
    return res.status(500).json({ error: 'upload failed', detail: err.message });
  }
};

// Tell Vercel NOT to pre-parse the body — we need the raw stream
module.exports.config = { api: { bodyParser: false } };
