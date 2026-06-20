const { isUnlockedRequest } = require('../lib/gate-token');

function requireUnlocked(req, res, next) {
  if (isUnlockedRequest(req)) {
    return next();
  }

  return res.redirect('/');
}

module.exports = requireUnlocked;
