/**
 * routes/timeline.js — Our Timeline page
 */

const express    = require('express');
const router     = express.Router();
const milestones = require('../data/timeline');

router.get('/', (req, res) => {
  res.render('timeline', {
    title:      'Our Timeline — GBAGL',
    page:       'timeline',
    milestones,
  });
});

module.exports = router;
