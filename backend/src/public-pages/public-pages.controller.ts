import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/auth.decorators.js';
import {
  PUBLIC_POLICY_DEFAULTS,
  PUBLIC_POLICY_PATHS,
} from '../config/public-policy.js';

interface PublicPageConfiguration {
  email: string;
  developer: string;
  origin: string;
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

function hasUnsafeControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (
      code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13)
    );
  });
}

function configuredText(
  config: ConfigService,
  key: string,
  fallback: string,
  maximum: number,
): string {
  const configured = config.get<unknown>(key);
  if (configured === undefined) return fallback;
  if (
    typeof configured !== 'string' ||
    !configured.trim() ||
    configured.length > maximum ||
    hasUnsafeControlCharacter(configured)
  ) {
    throw new ServiceUnavailableException(
      'Public account information is not configured',
    );
  }
  return configured.trim();
}

function page(
  title: string,
  description: string,
  configuration: PublicPageConfiguration,
  content: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="description" content="${escapeHtml(description)}">
<title>${escapeHtml(title)} · MusicMute</title>
<style>
:root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; line-height: 1.65; }
* { box-sizing: border-box; }
body { margin: 0; background: Canvas; color: CanvasText; }
main { width: min(100% - 2rem, 52rem); margin: auto; padding: 3rem 0 4rem; }
header { padding-bottom: 1.5rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
h1,h2,h3 { line-height: 1.2; text-wrap: balance; }
h1 { margin: .25rem 0 .75rem; font-size: clamp(2.1rem, 7vw, 3.5rem); }
h2 { margin-top: 0; } h3 { margin-bottom: .25rem; }
p,li { max-width: 72ch; } a { color: LinkText; overflow-wrap: anywhere; }
a:focus-visible { outline: 3px solid currentColor; outline-offset: 4px; }
.eyebrow { margin: 0; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.summary { font-size: 1.1rem; }
.card { margin-top: 1.25rem; padding: 1.25rem; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: .9rem; }
.notice { padding: 1rem; border-inline-start: .3rem solid LinkText; background: color-mix(in srgb, LinkText 8%, Canvas); }
.policy { white-space: pre-line; overflow-wrap: anywhere; }
.button { display: inline-block; padding: .7rem 1rem; border: 1px solid currentColor; border-radius: .6rem; font-weight: 700; text-decoration: none; }
nav { display: flex; gap: 1rem; flex-wrap: wrap; }
footer { margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
li { margin-block: .45rem; }
</style>
</head>
<body><main>
<header><p class="eyebrow">MusicMute · ${escapeHtml(configuration.developer)}</p><h1>${escapeHtml(title)}</h1><p class="summary">${escapeHtml(description)}</p><p>Last updated ${escapeHtml(PUBLIC_POLICY_DEFAULTS.policyVersion)}</p></header>
${content}
<footer><nav aria-label="Public resources"><a href="${PUBLIC_POLICY_PATHS.privacy}">Privacy</a><a href="${PUBLIC_POLICY_PATHS.accountDeletion}">Delete account</a><a href="${PUBLIC_POLICY_PATHS.support}">Support</a></nav></footer>
</main></body></html>`;
}

function emailLink(
  configuration: PublicPageConfiguration,
  subject: string,
  body: string,
  label: string,
): string {
  return `<a class="button" href="mailto:${escapeHtml(configuration.email)}?subject=${encodeURIComponent(subject)}&amp;body=${encodeURIComponent(body)}">${escapeHtml(label)}</a>`;
}

function publicUrl(
  configuration: PublicPageConfiguration,
  path: string,
): string {
  return new URL(path, `${configuration.origin}/`).toString();
}

@Public()
@Controller()
export class PublicPagesController {
  constructor(private readonly config: ConfigService) {}

  private configuration(): PublicPageConfiguration {
    const email = configuredText(
      this.config,
      'PUBLIC_SUPPORT_EMAIL',
      PUBLIC_POLICY_DEFAULTS.supportEmail,
      254,
    );
    if (
      !/^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
        email,
      )
    ) {
      throw new ServiceUnavailableException(
        'Public account information is not configured',
      );
    }
    const origin = configuredText(
      this.config,
      'PUBLIC_SITE_ORIGIN',
      PUBLIC_POLICY_DEFAULTS.publicOrigin,
      2048,
    );
    try {
      const url = new URL(origin);
      if (
        url.protocol !== 'https:' ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw new Error('Unsafe public origin');
      }
    } catch {
      throw new ServiceUnavailableException(
        'Public account information is not configured',
      );
    }
    return {
      email,
      origin,
      developer: configuredText(
        this.config,
        'PUBLIC_DEVELOPER_NAME',
        PUBLIC_POLICY_DEFAULTS.developerName,
        160,
      ),
      timeframe: configuredText(
        this.config,
        'PUBLIC_DELETION_TIMEFRAME',
        PUBLIC_POLICY_DEFAULTS.deletionTimeframe,
        2000,
      ),
      retention: configuredText(
        this.config,
        'PUBLIC_RETENTION_NOTICE',
        PUBLIC_POLICY_DEFAULTS.retentionNotice,
        4000,
      ),
    };
  }

  @Get('delete-account')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store, no-transform')
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  )
  deleteAccount(): string {
    const configuration = this.configuration();
    const deletionContact = emailLink(
      configuration,
      'MusicMute account deletion request',
      'I request deletion of my MusicMute account. Please send ownership-verification instructions. I will not send passwords, authentication tokens, recovery codes, or audio files.',
      `Request deletion by email: ${configuration.email}`,
    );
    return page(
      'Delete your MusicMute account',
      'Request deletion without reinstalling or opening the app, and understand what will be deleted or retained.',
      configuration,
      `
<section class="card" aria-labelledby="request"><h2 id="request">Request deletion</h2>
<p>${deletionContact}</p>
<ol>
<li>Send the request from the email associated with your MusicMute account when possible.</li>
<li>Support sends ownership-verification instructions. An email address alone does not authorize deletion.</li>
<li>After ownership is verified, support submits the request to the same deletion process used by the app and sends the request reference.</li>
</ol>
<p class="notice">Never send passwords, ID tokens, access tokens, recovery codes, or audio files. Support does not need them.</p>
<p>If the email button does not open, write to <strong>${escapeHtml(configuration.email)}</strong> with the subject “MusicMute account deletion request”.</p></section>
<section class="card" aria-labelledby="app"><h2 id="app">Delete from the app</h2>
<p>Open Account, choose Delete account, authenticate again with a linked sign-in method, and confirm. The authenticated route is the fastest option. A disabled account can use the email route above.</p></section>
<section class="card" aria-labelledby="scope"><h2 id="scope">Data that is deleted</h2>
<p>Permanent cleanup removes the MusicMute account and profile, private cloud input and result audio, processing jobs and history, account-linked installation and push records, and the Firebase identity used by MusicMute. It does not delete the user’s Google or Apple account.</p>
<p>The app clears account-owned private copies after it receives an accepted deletion response. An offline installation may retain private local copies until it reconnects or its app data is cleared. Files originally selected from another provider and copies exported by the user remain under that user or provider’s control.</p></section>
<section class="card" aria-labelledby="timing"><h2 id="timing">Timing, recovery, and limited retention</h2>
<p>Acceptance blocks account access and new processing immediately and starts an exact ${PUBLIC_POLICY_DEFAULTS.recoveryPeriodDays}-day recovery period. Before the deadline, sign in to submit an authenticated recovery request for review. After the deadline, permanent cleanup starts automatically and recovery is unavailable.</p>
<h3>Processing timeframe</h3><p class="policy">${escapeHtml(configuration.timeframe)}</p>
<h3>Retention after deletion</h3><p class="policy">${escapeHtml(configuration.retention)}</p>
<p>Contact support with the deletion request reference for status assistance.</p></section>`,
    );
  }

  @Get('privacy')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store, no-transform')
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  )
  privacy(): string {
    const configuration = this.configuration();
    return page(
      'MusicMute privacy policy',
      'How MusicMute collects, uses, protects, retains, and deletes account, device, diagnostic, and audio information.',
      configuration,
      `
<section class="card" aria-labelledby="operator"><h2 id="operator">Operator and contact</h2>
<p>MusicMute is operated by ${escapeHtml(configuration.developer)}. For privacy, support, or account questions, email <a href="mailto:${escapeHtml(configuration.email)}">${escapeHtml(configuration.email)}</a>.</p></section>
<section class="card" aria-labelledby="collection"><h2 id="collection">Information MusicMute handles</h2>
<ul>
<li><strong>Account information:</strong> Firebase user ID, profile name, email when available, verification state, and linked sign-in providers.</li>
<li><strong>Audio and user content:</strong> audio selected for processing, prepared original audio, voice-only results, filenames, duration, size, processing history, source URLs, and source metadata.</li>
<li><strong>Device and service information:</strong> MusicMute installation identifier, Firebase installation and messaging identifiers, push token, device model, operating system, app version and build, IP address, request metadata, and security/session records.</li>
<li><strong>Diagnostics:</strong> bounded crash, error, performance, and processing diagnostics needed to operate, secure, and troubleshoot the service.</li>
</ul>
<p>When a video is selected locally, MusicMute prepares audio on the device and uploads the prepared audio; it does not upload the original video file. Selecting a file or link alone does not authorize a cloud submission.</p></section>
<section class="card" aria-labelledby="uses"><h2 id="uses">Why the information is used</h2>
<p>MusicMute uses this information to authenticate accounts, enforce account and usage policy, prepare and process audio, deliver private results, maintain history, send requested processing notifications, support playback and export, prevent abuse, diagnose failures, provide support, and complete account deletion.</p>
<p>MusicMute does not sell personal information and does not use account or audio data for advertising.</p></section>
<section class="card" aria-labelledby="links"><h2 id="links">Imports from public links</h2>
<p>After the user confirms an import, MusicMute’s server retrieves an available audio-only stream from a supported public link and submits the prepared audio for processing. The mobile app does not fetch provider media. Source URL and metadata, prepared audio, and results remain associated with the account.</p>
<p>Users must import only material they own or are permitted to process. Rights confirmation is a statement by the user; MusicMute does not verify ownership or grant permission to download or process third-party material.</p></section>
<section class="card" aria-labelledby="providers"><h2 id="providers">Service providers and disclosure</h2>
<p>Firebase/Google processes authentication and messaging data. MongoDB stores account and job records. Private S3-compatible storage holds account media. Sentry receives privacy-filtered crash and diagnostic events when enabled. Hosting, network, and security providers may process IP addresses and request metadata to deliver and protect the service.</p>
<p>These providers process data for MusicMute’s service purposes. MusicMute may also disclose limited information when required by law or to protect users, the service, or others. These public pages contain no analytics scripts, advertising trackers, or account lookup form.</p></section>
<section class="card" aria-labelledby="security"><h2 id="security">Security and transfer</h2>
<p>Release clients use HTTPS. Cloud media is private and transferred through authenticated, short-lived grants. Access is account-scoped, and credentials or signed transfer URLs must not be shared. No system can guarantee absolute security.</p></section>
<section class="card" aria-labelledby="retention"><h2 id="retention">Retention, local copies, and deletion</h2>
<p>Cloud media and history remain associated with the account until the user deletes the relevant item or account, subject to processing cleanup and the deletion lifecycle below. Signing out does not erase retained cloud or local data.</p>
<p>An accepted account-deletion request blocks access immediately and starts an exact ${PUBLIC_POLICY_DEFAULTS.recoveryPeriodDays}-day recovery period. Permanent cleanup starts after that deadline.</p>
<p class="policy">${escapeHtml(configuration.retention)}</p>
<p class="policy">${escapeHtml(configuration.timeframe)}</p>
<p>Use the <a href="${PUBLIC_POLICY_PATHS.accountDeletion}">account deletion page</a> to request deletion outside the app or review the in-app process. The page explains the data removed, the exact recovery period, and limited retention.</p></section>
<section class="card" aria-labelledby="changes"><h2 id="changes">Policy changes</h2>
<p>Material changes will be published at this same URL with a new last-updated date. Continued use after an effective change is subject to the updated notice and applicable law.</p></section>`,
    );
  }

  @Get('support')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store, no-transform')
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  )
  support(): string {
    const configuration = this.configuration();
    const supportContact = emailLink(
      configuration,
      'MusicMute support request',
      'I need help with MusicMute. App version/build: __. Device and operating system: __. What happened: __. I will not send passwords, authentication tokens, recovery codes, or private audio.',
      `Email MusicMute support: ${configuration.email}`,
    );
    return page(
      'MusicMute support',
      'Contact MusicMute about account access, processing, privacy, or deletion without sending credentials or private media.',
      configuration,
      `
<section class="card" aria-labelledby="contact"><h2 id="contact">Contact support</h2><p>${supportContact}</p>
<p>Include the app version and build, device and operating-system version, the approximate time of the problem, and a short description. Include a deletion request reference or processing job ID only when it is relevant.</p>
<p class="notice">Do not send passwords, ID tokens, access tokens, recovery codes, signed download URLs, private audio, or screenshots containing personal data.</p></section>
<section class="card" aria-labelledby="account"><h2 id="account">Account and privacy requests</h2>
<p>For account deletion, use the dedicated <a href="${PUBLIC_POLICY_PATHS.accountDeletion}">account deletion page</a>. For collection, use, providers, retention, and security information, read the <a href="${PUBLIC_POLICY_PATHS.privacy}">privacy policy</a>.</p></section>`,
    );
  }

  @Get('public-policy')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  publicPolicy() {
    const configuration = this.configuration();
    return {
      schema_version: 1,
      policy_version: PUBLIC_POLICY_DEFAULTS.policyVersion,
      updated_at: PUBLIC_POLICY_DEFAULTS.policyUpdatedAt,
      app_name: PUBLIC_POLICY_DEFAULTS.appName,
      developer_name: configuration.developer,
      support_email: configuration.email,
      urls: {
        privacy: publicUrl(configuration, PUBLIC_POLICY_PATHS.privacy),
        account_deletion: publicUrl(
          configuration,
          PUBLIC_POLICY_PATHS.accountDeletion,
        ),
        support: publicUrl(configuration, PUBLIC_POLICY_PATHS.support),
      },
      account_deletion: {
        available_in_app: true,
        external_request_available: true,
        recovery_period_days: PUBLIC_POLICY_DEFAULTS.recoveryPeriodDays,
        replay_fence_hours: PUBLIC_POLICY_DEFAULTS.replayFenceHours,
      },
    };
  }
}
