import { isLoopbackUrl } from './enums';

/**
 * What counts as "this machine" (ADR-023).
 *
 * Two rules depend on this and must agree: plain http is accepted only here, and
 * an API key is required only when the endpoint is somewhere else. A gateway on
 * loopback may legitimately have no key — ollama and llama.cpp have none to give
 * — while one reached over a network always needs both TLS and a credential.
 */
describe('isLoopbackUrl', () => {
  it('recognises the forms a local gateway is written in', () => {
    for (const url of [
      'http://localhost:20128/v1',
      'http://127.0.0.1:20128/v1',
      'http://127.0.0.1:11434/v1',
      'https://localhost:8443/v1',
      'http://[::1]:8080/v1',
    ]) {
      expect(isLoopbackUrl(url)).toBe(true);
    }
  });

  it('rejects anything that leaves the machine', () => {
    for (const url of [
      'https://api.deepseek.com',
      'https://api.openai.com/v1',
      'http://192.168.1.10:20128/v1',
      'http://10.0.0.5/v1',
    ]) {
      expect(isLoopbackUrl(url)).toBe(false);
    }
  });

  it('is not fooled by a hostname that merely contains localhost', () => {
    // The failure this prevents: a key requirement waived for a third party
    // because its domain happened to read as local.
    for (const url of [
      'https://localhost.example.com/v1',
      'https://notlocalhost/v1',
      'https://127.0.0.1.example.com/v1',
    ]) {
      expect(isLoopbackUrl(url)).toBe(false);
    }
  });

  it('treats an unparseable or absent value as not local', () => {
    // The safe direction: an unreadable URL keeps both requirements rather than
    // dropping them.
    for (const url of ['', '   ', 'api.deepseek.com', null, undefined]) {
      expect(isLoopbackUrl(url)).toBe(false);
    }
  });
});
