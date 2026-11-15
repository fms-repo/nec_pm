// Password hashing for personal user accounts. Uses scrypt from Node's built-in crypto — a
// memory-hard KDF recommended for password storage — so no extra dependency is needed.
// Stored format:  scrypt$N$r$p$<salt b64>$<hash b64>   (the parameters travel with each hash, so
// they can be raised later without invalidating existing passwords).
const crypto = require('crypto');

const N = 16384, R = 8, P = 1, KEYLEN = 64;
const MIN_PASSWORD_LENGTH = 10;

function scrypt(password, salt, n, r, p, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P, KEYLEN);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), +n, +r, +p, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Burns the same CPU as a real check, so "no such user" and "wrong password" take the same time.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(KEYLEN).toString('base64');
const verifyDummy = password => verifyPassword(password, DUMMY_HASH).then(() => false);

// Constant-time string comparison (for the shared administrator credentials from the environment).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Returns an error message, or null when the password is acceptable.
function passwordProblem(password, username) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > 200) return 'Password is too long';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must contain both letters and numbers';
  if (username && password.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain the username';
  return null;
}

// A readable one-time password (no look-alike characters) that always satisfies passwordProblem().
function generateTemporaryPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', digits = '23456789';
  const pick = set => set[crypto.randomInt(set.length)];
  const chars = [pick(digits), pick(digits), pick(letters), pick(letters)];
  while (chars.length < 12) chars.push(pick(letters + digits));
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const normalizeUsername = u => String(u || '').trim().toLowerCase();

module.exports = { hashPassword, verifyPassword, verifyDummy, safeEqual, passwordProblem, generateTemporaryPassword, USERNAME_RE, normalizeUsername, MIN_PASSWORD_LENGTH };
