import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const blockedPasswords = new Set(['password','password123','123456789','1234567890','qwerty123','admin123','letmein','welcome','welcome123','contraseña','contraseña123','nexo123456']);

export function isValidPassword(password: string): boolean { return password.length >= 6; }

export function validateNewPassword(password: string) {
  if (password.length < 15) throw new Error('La nueva contraseña debe tener al menos 15 caracteres.');
  if (password.length > 128) throw new Error('La nueva contraseña no puede exceder 128 caracteres.');
  if (blockedPasswords.has(password.trim().toLocaleLowerCase('es'))) throw new Error('La contraseña es demasiado común o predecible. Elija otra.');
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, 64) as Buffer;
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, , , , saltValue, hashValue] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, 'base64url');
  const derived = await scrypt(password.normalize('NFKC'), Buffer.from(saltValue, 'base64url'), expected.length) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
