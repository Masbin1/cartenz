import { REDACTED, redact, redactMetadata } from './redact';

/**
 * The requirement these tests defend is absolute: the audit trail must never
 * contain a password, a token, an API key or a raw secret. Every write to
 * audit_logs, agent_actions and agent_task_events passes through this module, so
 * a gap here is a gap in the whole guarantee.
 */
describe('redaction', () => {
  it('redacts by field name, whatever the value looks like', () => {
    const output = redactMetadata({
      password: 'correct horse battery staple',
      apiKey: 'plain-looking-string',
      api_key: 'plain-looking-string',
      'API-KEY': 'plain-looking-string',
      accessToken: 'abc',
      privateKey: 'abc',
      authorization: 'abc',
      passphrase: 'abc',
    });

    for (const value of Object.values(output)) {
      expect(value).toBe(REDACTED);
    }
  });

  it('keeps the fields an auditor needs', () => {
    const output = redactMetadata({
      secretRef: 'secret:github-credential:0b7f',
      authMethod: 'oauth',
      hasCredentials: true,
      toolName: 'git_push',
    });

    expect(output.secretRef).toBe('secret:github-credential:0b7f');
    expect(output.authMethod).toBe('oauth');
    expect(output.hasCredentials).toBe(true);
    expect(output.toolName).toBe('git_push');
  });

  it('keeps facts about a credential while removing the credential', () => {
    // ADR-023 records whether an organisation's model API key was changed and
    // whether one is stored. Both field names contain "credential", so without
    // the allow list the booleans are blanked and the event says nothing.
    const output = redactMetadata({
      providerId: 'anthropic',
      credentialReplaced: true,
      credentialStored: true,
      apiKey: 'sk-ant-api03-should-not-survive-this',
    });

    expect(output.credentialReplaced).toBe(true);
    expect(output.credentialStored).toBe(true);
    expect(output.apiKey).toBe('[redacted]');
  });

  it('redacts a key-shaped value even under an innocent field name', () => {
    // The key filter is the control relied upon, but a model provider error
    // message is free text under a name like "error", so the value patterns have
    // to hold as well.
    const output = redactMetadata({
      error: 'Request failed for key sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    });

    expect(output.error).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    expect(output.error).toContain('[redacted]');
  });

  it('redacts nested fields at any depth', () => {
    const output = redactMetadata({
      connection: { detail: { githubToken: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
    });

    const detail = (output.connection as Record<string, Record<string, unknown>>).detail;
    expect(detail.githubToken).toBe(REDACTED);
  });

  it('redacts credential shapes found in free text', () => {
    const cases = [
      'Cloning with ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'token glpat-abcdefghijklmnopqrstu failed',
      'using sk-abcdefghijklmnopqrstuvwxyz012345',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef',
    ];

    for (const input of cases) {
      const output = redactMetadata({ message: input });
      expect(output.message).toContain(REDACTED);
    }
  });

  it('redacts a password embedded in a URL but keeps the host', () => {
    const output = redactMetadata({
      remote: 'https://deploy-user:s3cr3tp4ssw0rd@github.com/linkederp/app.git',
    });

    expect(output.remote).not.toContain('s3cr3tp4ssw0rd');
    expect(output.remote).toContain('github.com/linkederp/app.git');
  });

  it('redacts a PEM private key block entirely', () => {
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF0qMTG1ddQ==',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const output = redactMetadata({ deployKey: key });
    expect(output.deployKey).toBe(REDACTED);
  });

  it('leaves ordinary audit detail readable', () => {
    const output = redactMetadata({
      taskReference: 'task_9281',
      branch: 'ai/task_9281-vat-rounding-fix',
      filesChanged: 3,
      passed: true,
      model: 'sale.order',
    });

    expect(output).toEqual({
      taskReference: 'task_9281',
      branch: 'ai/task_9281-vat-rounding-fix',
      filesChanged: 3,
      passed: true,
      model: 'sale.order',
    });
  });

  it('bounds depth, array length and string length', () => {
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let index = 0; index < 12; index += 1) deep = { nested: deep };
    expect(JSON.stringify(redact(deep))).toContain('depth limit');

    const long = Array.from({ length: 250 }, (_, index) => index);
    const redactedArray = redact(long) as unknown[];
    expect(redactedArray.length).toBeLessThanOrEqual(101);
    expect(String(redactedArray[redactedArray.length - 1])).toContain('omitted');

    const huge = 'x'.repeat(5000);
    expect(String((redactMetadata({ note: huge }) as { note: string }).note)).toContain(
      'truncated',
    );
  });

  it('does not throw on unusual values', () => {
    expect(redact(undefined)).toBeUndefined();
    expect(redact(null)).toBeNull();
    expect(redact(() => undefined)).toBeUndefined();
    expect(redact(Buffer.from('binary'))).toContain('binary');
    expect(redact(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' });
  });

  it('returns an empty object for a metadata value that is not an object', () => {
    expect(redactMetadata('a string')).toEqual({});
    expect(redactMetadata([1, 2, 3])).toEqual({});
    expect(redactMetadata(null)).toEqual({});
  });
});
