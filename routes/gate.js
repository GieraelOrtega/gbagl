const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  UNLOCK_COOKIE_NAME,
  createUnlockToken,
  isUnlockedRequest,
  isCorrectAnniversaryDate,
} = require('../lib/gate-token');

const router = express.Router();

function renderGate(res, { message = null, messageType = 'error', triggerAnimation = false } = {}) {
  return res.render('gate', {
    title: 'Anniversary Gate — GBAGL',
    page: '',
    message,
    messageType,
    triggerAnimation,
  });
}

// 5 attempts per minute per IP is enough for normal typo correction,
// while slowing down brute-force guessing.
const unlockLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429);
    return renderGate(res, {
      message: 'Slow down 💕, try again in a moment.',
      messageType: 'warning',
      triggerAnimation: true,
    });
  },
});

router.get('/', (req, res) => {
  if (isUnlockedRequest(req)) {
    return res.redirect('/home');
  }

  return renderGate(res);
});

router.post('/unlock', unlockLimiter, (req, res) => {
  const submittedDate =
    typeof req.body.anniversaryDate === 'string' ? req.body.anniversaryDate.trim() : '';

  if (isCorrectAnniversaryDate(submittedDate)) {
    res.cookie(UNLOCK_COOKIE_NAME, createUnlockToken(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      signed: false,
      path: '/',
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });

    return res.redirect('/home');
  }

  res.status(401);
  return renderGate(res, {
    message: "That's not quite it, try again 💔",
    messageType: 'error',
    triggerAnimation: true,
  });
});

module.exports = router;
