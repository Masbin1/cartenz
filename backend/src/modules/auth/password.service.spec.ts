import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('verifies a correct password', async () => {
    const hash = await passwords.hash('a-perfectly-good-password');
    await expect(passwords.verify('a-perfectly-good-password', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await passwords.hash('a-perfectly-good-password');
    await expect(passwords.verify('a-perfectly-good-passwore', hash)).resolves.toBe(false);
  });

  it('never stores the plaintext', async () => {
    const hash = await passwords.hash('sentinel-value-not-in-hash');
    expect(hash).not.toContain('sentinel-value-not-in-hash');
  });

  it('salts each hash, so identical passwords hash differently', async () => {
    const first = await passwords.hash('same-password-both-times');
    const second = await passwords.hash('same-password-both-times');
    expect(first).not.toBe(second);
    await expect(passwords.verify('same-password-both-times', first)).resolves.toBe(true);
    await expect(passwords.verify('same-password-both-times', second)).resolves.toBe(true);
  });

  it('records its parameters, so they can be raised later', async () => {
    const hash = await passwords.hash('any-password-at-all');
    const [algorithm, version, N, r, p] = hash.split('$');
    expect(algorithm).toBe('scrypt');
    expect(version).toBe('1');
    expect(Number(N)).toBe(16384);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    for (const malformed of [
      '',
      'not-a-hash',
      'scrypt$1$16384$8$1$onlyfiveparts',
      'bcrypt$1$16384$8$1$c2FsdA==$a2V5',
      'scrypt$1$notanumber$8$1$c2FsdA==$a2V5',
    ]) {
      await expect(passwords.verify('any-password', malformed)).resolves.toBe(false);
    }
  });

  it('handles a long password and unicode', async () => {
    const long = 'ä'.repeat(200);
    const hash = await passwords.hash(long);
    await expect(passwords.verify(long, hash)).resolves.toBe(true);
    await expect(passwords.verify('ä'.repeat(199), hash)).resolves.toBe(false);
  });
});
