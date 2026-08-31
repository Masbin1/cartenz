import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Promise wrapper for scrypt. Written out rather than promisified because
 * promisify collapses the overloads and loses the options argument, which is
 * where the cost parameters live.
 */
function derive(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * scrypt parameters. N=16384 with r=8 gives roughly 16 MB of memory per hash,
 * which is the standard interactive-login setting: expensive enough to make
 * offline cracking costly, cheap enough that a login is not noticeably slow.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const FORMAT_VERSION = 'scrypt$1';

/**
 * Password hashing (ADR-015).
 *
 * scrypt from node:crypto rather than bcrypt or argon2, both of which are native
 * modules: this removes a compilation step from every install and container
 * build, and the platform is not making a claim it needs argon2 to support.
 *
 * The stored format is self-describing - version, parameters, salt, key - so
 * that parameters can be raised later and existing hashes still verify.
 */
@Injectable()
export class PasswordService {
  async hash(plaintext: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const derived = await derive(plaintext, salt, KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });

    return [
      FORMAT_VERSION,
      SCRYPT_N,
      SCRYPT_R,
      SCRYPT_P,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  /**
   * Verifies a password against a stored hash. Returns false rather than
   * throwing on a malformed hash, so a corrupt row denies access rather than
   * producing a 500 that distinguishes it from a wrong password.
   */
  async verify(plaintext: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 7 || parts[0] !== 'scrypt') return false;

    const N = Number(parts[2]);
    const r = Number(parts[3]);
    const p = Number(parts[4]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(parts[5], 'base64');
      expected = Buffer.from(parts[6], 'base64');
    } catch {
      return false;
    }
    if (salt.length === 0 || expected.length === 0) return false;

    let derived: Buffer;
    try {
      derived = await derive(plaintext, salt, expected.length, { N, r, p });
    } catch {
      return false;
    }

    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }
}
