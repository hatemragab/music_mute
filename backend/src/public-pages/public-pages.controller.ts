import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/auth.decorators.js';

interface PublicPageConfiguration {
  email: string;
  developer: string;
  timeframe: string;
  retention: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function page(title: string, developer: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · MusicMute</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.65; }
body { margin: 0; background: Canvas; color: CanvasText; }
main { max-width: 48rem; margin: auto; padding: 2rem 1.25rem 4rem; }
h1,h2 { line-height: 1.2; } h1 { font-size: clamp(2rem, 6vw, 3rem); }
h2 { margin-top: 2rem; } a { color: LinkText; overflow-wrap: anywhere; }
a:focus-visible { outline: 3px solid currentColor; outline-offset: 4px; }
.notice { padding: 1rem; border: 1px solid currentColor; border-radius: .5rem; }
.policy { white-space: pre-line; overflow-wrap: anywhere; }
nav { display: flex; gap: 1rem; flex-wrap: wrap; } li { margin-block: .5rem; }
</style>
</head>
<body><main>
<header><p>MusicMute · ${escapeHtml(developer)}</p><h1>${escapeHtml(title)}</h1></header>
${content}
<footer><nav aria-label="Policies"><a href="/privacy">Privacy</a><a href="/delete-account">Delete account</a></nav></footer>
</main></body></html>`;
}

function contact(configuration: PublicPageConfiguration): string {
  const subject = encodeURIComponent('MusicMute account deletion request');
  const body = encodeURIComponent(
    'I request deletion of my MusicMute account. Please send ownership-verification instructions. I will not send passwords, authentication tokens, or recovery codes.',
  );
  return `<a href="mailto:${escapeHtml(configuration.email)}?subject=${subject}&amp;body=${body}">Email ${escapeHtml(configuration.email)}</a>`;
}

@Public()
@Controller()
export class PublicPagesController {
  constructor(private readonly config: ConfigService) {}

  private configuration(): PublicPageConfiguration {
    const field = (key: string, maximum: number): string => {
      const value = this.config.get<unknown>(key);
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > maximum ||
        Array.from(value).some((character) => {
          const code = character.charCodeAt(0);
          return (
            code === 127 ||
            (code < 32 && code !== 9 && code !== 10 && code !== 13)
          );
        })
      ) {
        throw new ServiceUnavailableException(
          'Public account information is not configured',
        );
      }
      return value.trim();
    };
    const email = field('PUBLIC_SUPPORT_EMAIL', 254);
    if (
      !/^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
        email,
      )
    ) {
      throw new ServiceUnavailableException(
        'Public account information is not configured',
      );
    }
    return {
      email,
      developer: field('PUBLIC_DEVELOPER_NAME', 160),
      timeframe: field('PUBLIC_DELETION_TIMEFRAME', 2000),
      retention: field('PUBLIC_RETENTION_NOTICE', 4000),
    };
  }

  @Get('delete-account')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  )
  deleteAccount(): string {
    const configuration = this.configuration();
    return page(
      'Delete your MusicMute account',
      configuration.developer,
      `
<p>You can request account deletion here without reinstalling or opening the app.</p>
<section aria-labelledby="request"><h2 id="request">Request deletion by email</h2>
<p>${contact(configuration)}</p>
<ol>
<li>Send a message with the subject “MusicMute account deletion request”. If possible, use the email associated with your MusicMute account. If you cannot access that email, explain that you need account-recovery help.</li>
<li>Support will provide ownership-verification instructions. A supplied email address or message alone does not authorize deletion.</li>
<li>After ownership is verified, support submits the request to the same account-deletion process used by the app and provides the request reference.</li>
</ol>
<p class="notice">Never email passwords, ID tokens, access tokens, recovery codes, or audio files. Support does not need these to receive your request.</p>
<p>If your email app does not open, copy <strong>${escapeHtml(configuration.email)}</strong> into your email service and follow the instructions above.</p></section>
<section aria-labelledby="app"><h2 id="app">Delete from the app</h2>
<p>Open Account settings, choose Delete account, authenticate again with a linked sign-in method, then confirm. Account access ends immediately and permanent deletion is automatically scheduled for exactly 15 days later. Email verification for processing is not required to request deletion. A disabled account can use the support route above.</p></section>
<section aria-labelledby="scope"><h2 id="scope">What deletion covers</h2>
<p>When the 15-day recovery period ends, deletion removes the account/profile, associated cloud input audio and vocals-only results, processing history, and account-linked device and push records. The deletion process stops new account work before storage cleanup.</p>
<p>The app clears its private account copies when it receives an accepted deletion response. Other offline installations may retain private local copies until they reconnect or their local app data is cleared. Files originally selected from a document provider and copies you exported to your own storage stay under your control.</p></section>
<section aria-labelledby="timing"><h2 id="timing">Acceptance, completion and retention</h2>
<p>Acceptance ends account access and starts a 15-day recovery period. Account data and cloud media are retained but inaccessible during this period so recovery remains possible. Sign in again before the deadline to send an authenticated recovery request, optionally explain why, and wait for administrator review. If approved, the scheduled deletion is cancelled. After the deadline, permanent cleanup starts automatically and the media can no longer be recovered.</p>
<h3>Processing timeframe</h3><p class="policy">${escapeHtml(configuration.timeframe)}</p>
<p>A pseudonymous security replay fence is retained for 24 hours after deletion to prevent stale authentication from recreating the account.</p>
<h3>Logs and backup retention</h3><p class="policy">${escapeHtml(configuration.retention)}</p>
<p>Contact support with your request reference for status assistance. Do not send authentication credentials.</p></section>`,
    );
  }

  @Get('privacy')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  )
  privacy(): string {
    const configuration = this.configuration();
    return page(
      'MusicMute privacy',
      configuration.developer,
      `
<p>This notice describes MusicMute, operated by ${escapeHtml(configuration.developer)}. For privacy or account requests, contact <a href="mailto:${escapeHtml(configuration.email)}">${escapeHtml(configuration.email)}</a>.</p>
<section aria-labelledby="account"><h2 id="account">Account and device information</h2>
<p>Firebase Authentication handles sign-in identity and credentials. MusicMute uses the Firebase identity, profile name, account email when available, email-verification status, and linked sign-in providers to authenticate and manage your account.</p>
<p>Account-linked installation identifiers, device and operating-system information, app versions, and optional push registration tokens support access checks, session management, notifications, and troubleshooting. Account and job records are stored in MongoDB.</p></section>
<section aria-labelledby="audio"><h2 id="audio">Audio and processing</h2>
<p>Import audio you own or have permission to process. The app prepares a private local copy and shows a review before you confirm cloud processing. Selecting a file alone does not authorize upload.</p>
<p>New cloud-processing submissions are temporarily unavailable while the processing architecture is redesigned. Existing vocals-only results, source metadata, filenames, duration, size, and processing status continue to support your account history and downloads.</p>
<p>The app caches private input/result files locally and lets you explicitly play, save, or share results. Original imported files and copies exported to your chosen storage remain under your control.</p></section>
<section aria-labelledby="youtube"><h2 id="youtube">Secondary YouTube option</h2>
<p>MusicMute also offers a visible secondary YouTube link flow. Source downloading happens on the client after an explicit action and permission guidance. A separate review and cloud-processing confirmation is required before uploading downloaded audio. Your client communicates with YouTube and related source services to retrieve the selected audio; their data practices apply to those interactions.</p>
<p>Rights confirmation is a statement by the user. MusicMute does not verify copyright ownership or grant permission to download or process third-party material.</p></section>
<section aria-labelledby="operations"><h2 id="operations">Operations and security</h2>
<p>Operational logs, bounded error reports and request/security metadata support service reliability, abuse prevention, and recovery. Infrastructure services may process network and request metadata. Firebase/Google supports identity and messaging; MongoDB holds account/job records; S3 holds private media.</p>
<p>These public pages use no analytics scripts, tracking pixels, or public account lookup form. Sending a support email uses your chosen email provider and the configured support mailbox.</p></section>
<section aria-labelledby="retention"><h2 id="retention">Retention and deletion</h2>
<p>Cloud media and history remain associated with your account until you delete the relevant items or the 15-day account-deletion recovery period ends. During that recovery period the account is inaccessible, but you may sign in to submit an authenticated recovery request. Ordinary sign-out does not itself erase retained media.</p>
<p>A pseudonymous security replay fence is retained for 24 hours after deletion to prevent stale authentication from recreating the account.</p>
<p class="policy">${escapeHtml(configuration.retention)}</p>
<p class="policy">${escapeHtml(configuration.timeframe)}</p>
<p>Use <a href="/delete-account">account deletion</a> for in-app and support-assisted options, scope, and completion details. Acceptance and completion are different stages; deletion from backups follows the retention policy above.</p></section>`,
    );
  }
}
