const express = require('express');
const rateLimit = require('express-rate-limit');

function exportError(res, error) {
  const unavailable = error.code === 'DB_UNAVAILABLE';
  console.error('Keepsake export failed:', error.message);
  res.set('Cache-Control', 'no-store');
  return res.status(unavailable ? 503 : 500).render('error', {
    title: 'Keepsake export unavailable | GBAGL',
    page: 'admin',
    status: unavailable ? 503 : 500,
    message: unavailable
      ? 'The database is unavailable. Try the export again after it reconnects.'
      : 'The keepsake export could not be created.',
  });
}

function createExportRouter(exportService) {
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 4,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      res.set('Cache-Control', 'no-store');
      return res.status(429).render('error', {
        title: 'Export rate limit | GBAGL',
        page: 'admin',
        status: 429,
        message: 'Too many keepsake exports were requested. Please wait 15 minutes.',
      });
    },
  });

  router.get('/', (req, res) => res.render('admin-exports', {
    title: 'Keepsake Exports | GBAGL',
    page: 'admin',
  }));

  router.get('/keepsake.pdf', limiter, async (req, res) => {
    try {
      const pdf = await exportService.createPdf();
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'attachment; filename="gbagl-keepsake.pdf"',
        'Content-Length': pdf.length,
        'Content-Type': 'application/pdf',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.send(pdf);
    } catch (error) {
      return exportError(res, error);
    }
  });

  router.get('/keepsake.zip', limiter, async (req, res) => {
    try {
      const zip = await exportService.createZip();
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'attachment; filename="gbagl-keepsake.zip"',
        'Content-Length': zip.length,
        'Content-Type': 'application/zip',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.send(zip);
    } catch (error) {
      return exportError(res, error);
    }
  });

  return router;
}

module.exports = { createExportRouter, exportError };
