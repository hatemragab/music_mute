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
<p>Permanent cleanup removes the MusicMute account and profile, privately uploaded local input and result audio, processing jobs and history, account-linked installation and push records, and the Firebase identity used by MusicMute. It does not delete the user’s Google or Apple account.</p>
<p>Audio imported from public links and its processed results remain in permanent shared storage. Deletion removes this account’s records and access; it does not remove the shared media used by other accounts.</p>
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
      'How MusicMute handles information across its Android, iOS, web, Mac, and Chrome products.',
      configuration,
      `
  <section class="card" aria-labelledby="operator"><h2 id="operator">Operator and contact</h2>
  <p>MusicMute is operated by ${escapeHtml(configuration.developer)}. This policy covers the Android and iOS apps, the web app, MusicMute Local for Mac, its Chrome extension, and the MusicMute services they use. Features and data handling differ slightly by client. MusicMute is independent of YouTube and Google.</p>
  <p>For privacy, support, access, correction, or deletion questions, email <a href="mailto:${escapeHtml(configuration.email)}">${escapeHtml(configuration.email)}</a> or use the <a href="${PUBLIC_POLICY_PATHS.support}">support page</a>. Do not send passwords, authentication tokens, browser cookies, private audio, or protected download URLs. Support may ask you to verify ownership before acting on an account request.</p></section>
  <section class="card" aria-labelledby="collection"><h2 id="collection">Information MusicMute handles</h2>
  <ul>
  <li><strong>Account and authentication information:</strong> Firebase user ID, profile name, email when available, verification state, linked sign-in providers, and the credentials or session records needed for sign-in. The Mac app stores its sign-in credentials in macOS Keychain; they are not sent to the Chrome extension.</li>
  <li><strong>Audio and user content:</strong> audio you select or upload, prepared audio, voice-only results, filenames, duration, size, processing history, source URLs and identifiers you submit, and source metadata.</li>
  <li><strong>Device and service information:</strong> where supported, a MusicMute installation identifier, Firebase installation and messaging identifiers, push token, device model, operating system, app version and build, IP address, request metadata, and security/session records. These network requests do not give MusicMute GPS or precise-geolocation access.</li>
  <li><strong>Chrome playback and preferences:</strong> on supported YouTube watch pages, the canonical URL and video identifier, duration, playback position and speed, volume, mute state, and player/advertisement state. The extension uses these only to add controls and synchronize vocals. Playback and language preferences and bounded diagnostics are stored in the current Chrome profile.</li>
  <li><strong>Diagnostics:</strong> bounded crash, error, performance, and processing diagnostics needed to operate, secure, and troubleshoot the service. Chrome extension and Mac app diagnostic reports remain on your device unless you choose to share an exported report; other clients and the backend may send privacy-filtered diagnostics to Sentry when enabled.</li>
  </ul>
  <p>The Chrome extension does not read general browsing history, browser cookies, or your Google password, and does not access precise geolocation. It does not log typed text or general keyboard activity. Its access is limited to supported YouTube watch pages and is used only for the selected playback feature; it does not monitor unrelated browsing. MusicMute does not collect health, financial/payment, or personal-communication data for this feature.</p>
  <p>When a client prepares a selected local video for processing, it uploads prepared audio rather than the original video file.</p></section>
  <section class="card" aria-labelledby="uses"><h2 id="uses">Why the information is used</h2>
  <p>MusicMute uses this information to authenticate your account, enforce account and usage policy, prepare and process audio, deliver your private results, maintain your history, send processing notifications you request, support playback and export, prevent abuse, diagnose failures, provide support, and complete account deletion.</p>
  <p>MusicMute does not sell personal information, transfer it to data brokers, use it for advertising, or use it to determine creditworthiness or for lending. Your data is used only for the disclosed features and for necessary service, security, and legal purposes.</p></section>
  <section class="card" aria-labelledby="links"><h2 id="links">Imports from links</h2>
  <p>When you submit a public link in the mobile or web app, MusicMute retrieves the audio you selected and processes it. The mobile app does not fetch media from the link provider itself. Results are never made available to other users.</p>
  <p>Import only material you own or are permitted to process. Confirming your rights is a statement by you; MusicMute does not verify ownership or grant permission to download or process third-party material.</p></section>
  <section class="card" aria-labelledby="local"><h2 id="local">Mac and Chrome local playback</h2>
  <p>The Chrome extension plays a voice-only track synchronized with a supported YouTube watch video through the required MusicMute Mac app, and follows the processing choice saved in that app. With local processing selected, the Mac app obtains the selected audio online when needed, runs separation on your Mac, and keeps originals, vocals, processing metadata, and preferences in its managed storage on your device. Playback uses native messaging and a temporary protected loopback connection on the same Mac. Automatic local preparation is enabled by default for eligible playing videos; you can turn it off or set a shorter duration limit.</p>
  <p>To obtain audio locally, the Mac app contacts YouTube without using your Chrome account, profile, or browser cookies. YouTube and its media servers receive these requests, including your Mac's IP address, and may return anonymous session data for that request. YouTube may refuse access; MusicMute does not bypass login requirements.</p></section>
  <section class="card" aria-labelledby="cloud"><h2 id="cloud">Mac account and cloud processing</h2>
  <p>Signing in to the Mac app connects it to your MusicMute account and Library.</p>
  <p>When MusicMute cloud processing is selected in the Mac app, manually starting a video sends its canonical YouTube watch URL to MusicMute using that saved choice, without a per-video confirmation in Chrome. MusicMute then retrieves the audio and processes it, and the vocals are downloaded to your Mac for playback. Cloud processing uses your account's processing allowance. Automatic preparation never submits new cloud processing.</p></section>
  <section class="card" aria-labelledby="android"><h2 id="android">Android app: permissions, backup, and analytics</h2>
  <ul>
  <li>Android cloud backup is disabled for the app so local session data is not copied into Android backup.</li>
  <li>The Android app uses Internet access, notifications, foreground media playback, and wake lock for its core video and background-playback features.</li>
  <li>The app does not request camera, microphone, contacts, location, calendar, SMS, call log, photos, or broad device file access.</li>
  <li>MusicMute does not use mobile analytics for advertising and does not include an ads SDK.</li>
  </ul></section>
  <section class="card" aria-labelledby="security"><h2 id="security">Security and transfer</h2>
  <p>Service and media transfers use HTTPS or secure WebSockets, as applicable. Your media is stored privately and transferred through short-lived, access-controlled links. Access is authorized through account-scoped records, and storage is not public. Do not share credentials or signed transfer URLs. Native messaging and protected loopback playback stay on the same Mac. No system can guarantee absolute security.</p>
  <p>Browser executable code is bundled with the Chrome extension. The Mac app separately downloads checksum-verified native runtime components and model data, installs them outside the extension, and runs them in the Mac app rather than in Chrome. Each downloaded component ZIP is removed after successful installation. Ordinary app replacement preserves the installed runtime, model, and app data.</p></section>
  <section class="card" aria-labelledby="diagnostics"><h2 id="diagnostics">Local diagnostics and your controls</h2>
  <p>The Chrome extension and Mac app keep diagnostic reports on your device, without automatic upload, telemetry, or analytics. Exporting diagnostics creates a local report, and you choose whether to share it. Reports omit audio, credentials, browser cookies, and private media URLs. Separately, MusicMute's online services retain operational and security records for the requests they receive.</p>
  <p>You can turn automatic preparation on or off, set a duration limit, switch between vocals and original sound, or stop playback. Use "Stop playback and clear local cache" in the extension's local tools to clear its managed local results. The local cache is subject to a managed size budget. Items in your account Library are managed separately and can be deleted by you.</p>
  <p>Removing the Chrome extension removes its Chrome settings; it does not uninstall the Mac app or delete its files or your cloud Library. Contact support for privacy questions or requests about data the available controls do not remove.</p></section>
  <section class="card" aria-labelledby="retention"><h2 id="retention">Retention, local copies, and deletion</h2>
  <p>Your uploaded media, results, and account history remain until you delete the relevant item or your account, subject to processing cleanup and the deletion lifecycle below. When you delete an item or your account, the associated media, results, and records are removed from MusicMute storage as described below. Signing out does not erase retained cloud or local data.</p>
  <p>An accepted account-deletion request blocks access immediately and starts an exact ${PUBLIC_POLICY_DEFAULTS.recoveryPeriodDays}-day recovery period. Permanent cleanup starts after that deadline.</p>
  <p class="policy">${escapeHtml(configuration.retention)}</p>
  <p class="policy">${escapeHtml(configuration.timeframe)}</p>
  <p>Use the <a href="${PUBLIC_POLICY_PATHS.accountDeletion}">account deletion page</a> to request deletion outside the app or review the in-app process. The page explains the data removed, the exact recovery period, and any limited retention.</p></section>
  <section class="card" aria-labelledby="limited-use"><h2 id="limited-use">Chrome Web Store Limited Use</h2>
  <p>MusicMute Local's use and transfer of user data complies with the <a href="https://developer.chrome.com/docs/webstore/program-policies/user-data-faq" rel="noreferrer noopener">Chrome Web Store User Data Policy</a>, including its Limited Use requirements. Data is used and transferred only for the disclosed voice playback, processing, and account Library features, and for the policy's permitted service purposes.</p>
  <p>User data is not used or transferred for personalized, retargeted, or interest-based advertising; it is not sold or transferred to data brokers and is not used for creditworthiness or lending. Human access to user data is limited to the policy's permitted situations, such as your affirmative agreement to specific support access, security investigations, compliance with law, or permitted internal use of aggregated and anonymized data.</p></section>
  <section class="card" aria-labelledby="changes"><h2 id="changes">Policy changes</h2>
  <p>Material changes will be published at this same URL with a new last-updated date. This notice describes current data handling; it does not itself obtain consent for new or unrelated uses. Where a change requires additional notice or affirmative consent under applicable law or store policy, MusicMute must provide that notice and obtain that consent before the new use.</p></section>`,
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
