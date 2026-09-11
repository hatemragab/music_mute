import {
  OperationInputError,
  parseAuthOperationArgs,
  safeOperationErrorCode,
} from './cli.js';

describe('auth operations CLI parser', () => {
  it('requires verified ownership and an explicit file/mode for support deletion', () => {
    expect(() =>
      parseAuthOperationArgs([
        'delete-account',
        '--apply',
        '--file',
        '/tmp/case.json',
      ]),
    ).toThrow();
    expect(
      parseAuthOperationArgs([
        'delete-account',
        '--dry-run',
        '--file',
        '/tmp/case.json',
      ]),
    ).toEqual({
      command: 'delete-account',
      apply: false,
      file: '/tmp/case.json',
    });
    expect(
      parseAuthOperationArgs([
        'delete-account',
        '--apply',
        '--ownership-verified',
        '--file',
        '/tmp/case.json',
      ]),
    ).toEqual({
      command: 'delete-account',
      apply: true,
      file: '/tmp/case.json',
    });
  });
  it('requires an explicit dry-run or apply mode for writes', () => {
    expect(() => parseAuthOperationArgs(['indexes'])).toThrow(
      OperationInputError,
    );
    expect(() =>
      parseAuthOperationArgs(['indexes', '--dry-run', '--apply']),
    ).toThrow(OperationInputError);
    expect(parseAuthOperationArgs(['indexes', '--dry-run'])).toEqual({
      command: 'indexes',
      apply: false,
    });
  });

  it('strictly parses policy operands and bounded statistics days', () => {
    expect(
      parseAuthOperationArgs([
        'policy',
        '--apply',
        '--file',
        '/tmp/policy.json',
        '--expected-revision',
        '3',
      ]),
    ).toEqual({
      command: 'policy',
      apply: true,
      file: '/tmp/policy.json',
      expectedRevision: 3,
    });
    expect(parseAuthOperationArgs(['stats'])).toEqual({
      command: 'stats',
      days: 30,
    });
    expect(() => parseAuthOperationArgs(['stats', '--days', '366'])).toThrow();
    expect(() => parseAuthOperationArgs(['indexes', '--force'])).toThrow();
  });

  it('never turns arbitrary error text into operator output', () => {
    expect(
      safeOperationErrorCode(
        new Error('connect mongodb://private-user:private-password@host'),
      ),
    ).toBe('OPERATION_FAILED');
  });

  it('requires a private file and an explicit bootstrap mode', () => {
    expect(
      parseAuthOperationArgs([
        'admin-bootstrap',
        '--dry-run',
        '--file',
        '/tmp/admin.json',
      ]),
    ).toEqual({
      command: 'admin-bootstrap',
      apply: false,
      file: '/tmp/admin.json',
    });
    expect(() =>
      parseAuthOperationArgs(['admin-bootstrap', '--apply']),
    ).toThrow();
  });
});
