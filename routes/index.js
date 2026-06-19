/**
 * routes/index.js — Landing page
 */

const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
  res.render('index', {
    title: 'GBAGL — Gunna Be a Great Life',
    page:  'home',
  });
});

module.exports = router;
