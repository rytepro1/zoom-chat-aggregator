import bcrypt from 'bcryptjs';

// bcryptjs is pure JS so there's no native build step on Railway — safer
// across deploys than the native `bcrypt` package. ~5x slower than native
// at hashing, which is irrelevant for our login volume.
const SALT_ROUNDS = 12;

export async function hashPassword(plain) {
  if (!plain || typeof plain !== 'string') {
    throw new Error('Password is required');
  }
  if (plain.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
