import { deriveDisplayName } from './display-name.js';

describe('automatic display names', () => {
  it('uses the email prefix and preserves its spelling', () => {
    expect(
      deriveDisplayName('fixture-user', ' Example.Name@gmail.com '),
    ).toEqual({
      displayName: 'Example.Name',
      nameSource: 'email_prefix',
    });
  });

  it('produces stable numeric names for Apple relay and missing email', () => {
    const relay = deriveDisplayName(
      'fixture-apple',
      'hidden@PrivateRelay.AppleID.com',
    );
    expect(relay.displayName).toMatch(/^\d{12}$/);
    expect(relay.nameSource).toBe('numeric_alias');
    expect(deriveDisplayName('fixture-apple', null)).toEqual(relay);
    expect(deriveDisplayName('another-fixture', null)).not.toEqual(relay);
  });

  it('removes control characters and bounds stored names', () => {
    expect(
      deriveDisplayName('fixture', '\u0000ex\u202eample@gmail.com').displayName,
    ).toBe('example');
    expect(
      deriveDisplayName('fixture', `${'a'.repeat(200)}@gmail.com`).displayName,
    ).toHaveLength(128);
    expect(deriveDisplayName('fixture', '@gmail.com').nameSource).toBe(
      'numeric_alias',
    );
  });
});
