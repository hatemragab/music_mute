import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authError } from './auth.errors.js';

export class FirebaseMailQuotaError extends Error {
  constructor() {
    super('Upstream mail temporarily unavailable');
  }
}

@Injectable()
export class FirebaseMailService {
  private readonly url: string;
  constructor(config: ConfigService) {
    const emulator = config.get<string>('FIREBASE_AUTH_EMULATOR_HOST');
    let base = 'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode';
    if (emulator) {
      const candidate = new URL(`http://${emulator}`);
      if (
        config.get('APP_ENV') !== 'test' ||
        !config.getOrThrow<string>('FIREBASE_PROJECT_ID').startsWith('demo-') ||
        !['127.0.0.1', '[::1]', 'localhost'].includes(candidate.hostname) ||
        candidate.username ||
        candidate.password ||
        candidate.pathname !== '/' ||
        candidate.search ||
        candidate.hash
      )
        throw new Error('Invalid isolated Firebase mail configuration');
      base = `${candidate.origin}/identitytoolkit.googleapis.com/v1/accounts:sendOobCode`;
    }
    const url = new URL(base);
    url.searchParams.set(
      'key',
      config.getOrThrow<string>('FIREBASE_WEB_API_KEY'),
    );
    this.url = url.toString();
  }

  sendVerification(idToken: string): Promise<void> {
    return this.send({ requestType: 'VERIFY_EMAIL', idToken });
  }
  sendPasswordReset(email: string): Promise<void> {
    return this.send({ requestType: 'PASSWORD_RESET', email });
  }

  private async send(
    body:
      | { requestType: 'VERIFY_EMAIL'; idToken: string }
      | { requestType: 'PASSWORD_RESET'; email: string },
  ): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (response.ok) return;
      let code = '';
      try {
        const payload: unknown = await response.json();
        if (
          payload &&
          typeof payload === 'object' &&
          'error' in payload &&
          payload.error &&
          typeof payload.error === 'object' &&
          'message' in payload.error &&
          typeof payload.error.message === 'string'
        )
          code = payload.error.message.split(' : ')[0];
      } catch {
        /* A non-JSON upstream error is still unavailable. */
      }
      if (
        response.status === 429 ||
        ['QUOTA_EXCEEDED', 'TOO_MANY_ATTEMPTS_TRY_LATER'].includes(code)
      )
        throw new FirebaseMailQuotaError();
      if (body.requestType === 'PASSWORD_RESET' && code === 'EMAIL_NOT_FOUND')
        return;
      if (
        ['INVALID_ID_TOKEN', 'TOKEN_EXPIRED', 'USER_NOT_FOUND'].includes(code)
      )
        throw authError('UNAUTHENTICATED');
      if (code === 'USER_DISABLED') throw authError('ACCOUNT_DISABLED');
      if (['INVALID_EMAIL', 'MISSING_EMAIL'].includes(code))
        throw authError('INVALID_INPUT');
      throw authError('SERVICE_UNAVAILABLE');
    } catch (error) {
      if (
        error instanceof HttpException ||
        error instanceof FirebaseMailQuotaError
      )
        throw error;
      throw authError('SERVICE_UNAVAILABLE');
    }
  }
}
