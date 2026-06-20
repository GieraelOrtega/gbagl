/**
 * routes/index.js — Home (unlocked) landing page
 */

const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
  res.render('index', {
    title: 'Home — GBAGL',
    page:  'home',
  });
});

module.exports = router;
