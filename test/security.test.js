const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSignedValue,
  safeEqual,
  verifySignedValue,
} = require('../lib/cookies');
const { createAccountAuth } = require('../middleware/accountAuth');
const { createPasscodeAuth } = require('../middleware/passcode');

const config = {
  accountCookieHours: 12,
  accounts: [
    {
      username: 'gierael',
      displayName: 'Gierael',
      role: 'admin',
      password: 'local-gierael-passphrase',
    },
    {
      username: 'kim',
      displayName: 'Kim',
      role: 'member',
      password: 'local-kim-passphrase',
    },
  ],
  cookieSecret: 'local-cookie-secret-for-test-use',
  production: false,
  sitePasscode: '8462',
};

function cookieResponse() {
  const headers = {};
  return {
    headers,
    response: {
      getHeader: (name) => headers[name],
      setHeader: (name, value) => { headers[name] = value; },
    },
  };
}

test('signed values reject tampering and timing-safe comparison handles lengths', () => {
  const signed = createSignedValue('payload', config.cookieSecret);
  assert.equal(verifySignedValue(signed, config.cookieSecret), 'payload');
  assert.equal(verifySignedValue(`${signed}x`, config.cookieSecret), null);
  assert.equal(safeEqual('same', 'same'), true);
  assert.equal(safeEqual('short', 'longer'), false);
});

test('site unlock grants viewer access but no account privileges', () => {
  const passcode = createPasscodeAuth(config);
  const accounts = createAccountAuth(config);
  const { headers, response } = cookieResponse();
  passcode.setUnlockCookie(response);
  const request = { headers: { cookie: headers['Set-Cookie'].split(';')[0] } };

  assert.equal(passcode.isUnlocked(request), true);
  assert.equal(accounts.currentUser(request), null);
  assert.equal(accounts.isMember(request), false);
  assert.equal(accounts.isAdmin(request), false);
});

test('named credentials resolve only their configured server-side roles', () => {
  const auth = createAccountAuth(config);
  assert.deepEqual(auth.authenticate('Gierael', config.accounts[0].password), {
    username: 'gierael',
    displayName: 'Gierael',
    role: 'admin',
  });
  assert.deepEqual(auth.authenticate(' kim ', config.accounts[1].password), {
    username: 'kim',
    displayName: 'Kim',
    role: 'member',
  });
  assert.equal(auth.authenticate('gierael', config.accounts[1].password), null);
  assert.equal(auth.authenticate('unknown', config.accounts[0].password), null);

  const { headers, response } = cookieResponse();
  auth.setAccountCookie(response, auth.authenticate('kim', config.accounts[1].password));
  const request = { headers: { cookie: headers['Set-Cookie'].split(';')[0] } };
  assert.equal(auth.currentUser(request).role, 'member');
  assert.equal(auth.isMember(request), true);
  assert.equal(auth.isAdmin(request), false);
});

test('account cookies reject unknown users and expired sessions', () => {
  const auth = createAccountAuth(config);
  const unknown = createSignedValue(
    `v1:intruder:not-a-real-tag:${Date.now() + 60000}`,
    config.cookieSecret,
  );
  assert.equal(auth.currentUser({ headers: { cookie: `gbagl_account=${unknown}` } }), null);

  const { headers, response } = cookieResponse();
  auth.setAccountCookie(response, auth.authenticate('gierael', config.accounts[0].password));
  const encoded = headers['Set-Cookie'].split(';')[0].split('=')[1];
  const value = verifySignedValue(decodeURIComponent(encoded), config.cookieSecret);
  const parts = value.split(':');
  parts[3] = String(Date.now() - 1);
  const expired = createSignedValue(parts.join(':'), config.cookieSecret);
  assert.equal(auth.currentUser({ headers: { cookie: `gbagl_account=${expired}` } }), null);
});

test('changing an account password invalidates its existing signed session', () => {
  const original = createAccountAuth(config);
  const { headers, response } = cookieResponse();
  original.setAccountCookie(
    response,
    original.authenticate('kim', config.accounts[1].password),
  );
  const request = { headers: { cookie: headers['Set-Cookie'].split(';')[0] } };
  assert.equal(original.currentUser(request).role, 'member');

  const rotated = createAccountAuth({
    ...config,
    accounts: config.accounts.map((account) => (
      account.username === 'kim'
        ? { ...account, password: 'rotated-kim-passphrase' }
        : account
    )),
  });
  assert.equal(rotated.currentUser(request), null);
});
