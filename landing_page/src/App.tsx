import {
  ArrowUpRight,
  Check,
  ChevronDown,
  FileAudio,
  Globe2,
  Headphones,
  Languages,
  Laptop,
  Library,
  Link2,
  LockKeyhole,
  Radio,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Upload,
  Waves,
} from "lucide-react";
import {
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";
import {
  LANGUAGE_STORAGE_KEY,
  messages,
  resolveInitialLanguage,
  type Language,
} from "./i18n";
import { AudioComparison } from "./AudioComparison";
import { PRODUCT_LINKS } from "./product-links";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const inputBars = [28, 52, 74, 38, 86, 58, 34, 72, 90, 44, 62, 30, 76, 48];
const outputBars = [16, 28, 66, 34, 82, 46, 20, 58, 74, 30, 52, 18, 62, 26];
const stepIcons: Icon[] = [Upload, Waves, Headphones];
const featureIcons: Icon[] = [Library, Radio, LockKeyhole, Languages];

function SoloSignalMark() {
  return (
    <svg viewBox="0 0 108 108" aria-hidden="true" focusable="false">
      <rect width="108" height="108" fill="#123c37" />
      <g fill="none" stroke="#96e6c7" strokeLinecap="round">
        <path d="M24 49v10M84 49v10" strokeWidth="6" opacity="0.24" />
        <path d="M34 43v22M74 43v22" strokeWidth="7" opacity="0.38" />
        <path d="M44 36v36M64 36v36" strokeWidth="8" opacity="0.56" />
        <path d="M54 25v58" strokeWidth="12" />
      </g>
    </svg>
  );
}

function Waveform({
  bars,
  result = false,
}: {
  bars: number[];
  result?: boolean;
}) {
  return (
    <div
      className={result ? "waveform waveform-result" : "waveform"}
      aria-hidden="true"
    >
      {bars.map((height, index) => (
        <span className={`waveform-bar-${height}`} key={`${height}-${index}`} />
      ))}
    </div>
  );
}

function routedLanguage(): string | null {
  return document.documentElement.dataset.languageRoute ?? null;
}

function storedLanguage(): string | null {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistLanguage(language: Language) {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Navigation still applies the selected language when storage is unavailable.
  }
}

function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}

export function App() {
  const [language] = useState<Language>(() =>
    resolveInitialLanguage(
      routedLanguage(),
      storedLanguage(),
      navigator.languages,
    ),
  );
  const t = messages[language];

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    document.title =
      language === "ar"
        ? "ميوزك ميوت | احتفظ بالصوت"
        : "MusicMute | Keep the voice";
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", t.hero.body);
  }, [language, t.hero.body]);

  const nextLanguage: Language = language === "en" ? "ar" : "en";
  const nextLanguagePath = nextLanguage === "ar" ? "/ar/" : "/";

  return (
    <div className="site-shell" id="top">
      <a className="skip-link" href="#main-content">
        {t.a11y.skipContent}
      </a>
      <header className="site-header">
        <a className="brand" href="#top" aria-label={t.a11y.home}>
          <span className="brand-mark">
            <SoloSignalMark />
          </span>
          <span>MusicMute</span>
        </a>

        <nav className="primary-nav" aria-label={t.a11y.primaryNavigation}>
          <a href="#demo">{t.nav.demo}</a>
          <a href="#how-it-works">{t.nav.how}</a>
          <a href="#features">{t.nav.features}</a>
          <a href="#downloads">{t.nav.apps}</a>
          <a href="#faq">{t.nav.faq}</a>
        </nav>

        <div className="header-actions">
          <a
            className="language-button"
            href={nextLanguagePath}
            onClick={(event) => {
              persistLanguage(nextLanguage);
              event.currentTarget.href = `${nextLanguagePath}${window.location.hash}`;
            }}
            aria-label={`${t.languageName}. ${t.languageAction}`}
          >
            <Globe2 aria-hidden="true" />
            {t.languageAction}
          </a>
          <ExternalLink
            className="button button-small"
            href={PRODUCT_LINKS.webApp}
          >
            {t.openApp}
            <ArrowUpRight aria-hidden="true" />
          </ExternalLink>
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">
              <Sparkles aria-hidden="true" />
              {t.hero.eyebrow}
            </p>
            <h1 id="hero-title">
              <span>{t.hero.lead}</span>
              <strong>{t.hero.accent}</strong>
            </h1>
            <p className="hero-body">{t.hero.body}</p>
            <div className="hero-actions">
              <ExternalLink className="button" href={PRODUCT_LINKS.webApp}>
                {t.openApp}
                <ArrowUpRight aria-hidden="true" />
              </ExternalLink>
              <a className="button button-secondary" href="#how-it-works">
                {t.hero.secondaryAction}
              </a>
            </div>
            <p className="rights-note">
              <Check aria-hidden="true" />
              {t.hero.rightsNote}
            </p>
          </div>

          <div className="signal-stage" aria-label={t.hero.previewLabel}>
            <div className="stage-glow" aria-hidden="true" />
            <div className="result-window">
              <div className="window-heading">
                <div>
                  <span className="window-kicker">MusicMute</span>
                  <h2>{t.hero.previewLabel}</h2>
                </div>
                <span className="ready-badge">
                  <Check aria-hidden="true" />
                  {t.hero.ready}
                </span>
              </div>
              <div className="track track-source">
                <span>{t.hero.sourceTrack}</span>
                <Waveform bars={inputBars} />
              </div>
              <div className="separation-line" aria-hidden="true">
                <span />
                <Sparkles />
                <span />
              </div>
              <div className="track track-result">
                <span>{t.hero.resultTrack}</span>
                <Waveform bars={outputBars} result />
              </div>
              <div className="result-complete" aria-hidden="true">
                <Check />
              </div>
            </div>
          </div>
        </section>

        <section className="proof-strip" aria-label={t.a11y.highlights}>
          {t.proofPoints.map((point) => (
            <span key={point}>
              <Check aria-hidden="true" />
              {point}
            </span>
          ))}
        </section>

        <section
          className="section demo-section"
          id="demo"
          aria-labelledby="demo-title"
        >
          <div className="section-heading centered-heading demo-heading">
            <p className="eyebrow">{t.demoSection.eyebrow}</p>
            <h2 id="demo-title">{t.demoSection.title}</h2>
            <p>{t.demoSection.body}</p>
          </div>
          <AudioComparison copy={t.demoSection} isRtl={language === "ar"} />
        </section>

        <section
          className="section source-section"
          aria-labelledby="sources-title"
        >
          <div className="section-heading split-heading">
            <div>
              <p className="eyebrow">{t.sourceSection.eyebrow}</p>
              <h2 id="sources-title">{t.sourceSection.title}</h2>
            </div>
            <p>{t.sourceSection.body}</p>
          </div>

          <div className="source-board">
            <article className="source-card local-source-card">
              <span className="source-icon">
                <FileAudio aria-hidden="true" />
              </span>
              <div>
                <h3>{t.sourceSection.localAudio}</h3>
                <p dir="ltr">MP3 · AAC / M4A · Ogg / Opus · WebM</p>
              </div>
            </article>
            <article className="source-card link-source-card">
              <span className="source-icon">
                <Link2 aria-hidden="true" />
              </span>
              <div>
                <h3>{t.sourceSection.publicLinks}</h3>
                <div className="source-chips" dir="ltr">
                  {t.sourceNames.map((source) => (
                    <span key={source}>{source}</span>
                  ))}
                </div>
              </div>
            </article>
          </div>
          <p className="availability-note">
            {t.sourceSection.availabilityNote}
          </p>
        </section>

        <section
          className="section showcase-section"
          id="showcase"
          aria-labelledby="showcase-title"
        >
          <div className="section-heading split-heading showcase-heading">
            <div>
              <p className="eyebrow">{t.showcaseSection.eyebrow}</p>
              <h2 id="showcase-title">{t.showcaseSection.title}</h2>
            </div>
            <p>{t.showcaseSection.body}</p>
          </div>

          <div className="showcase-devices">
            <figure className="showcase-device showcase-device-import">
              <svg
                viewBox="455 410 690 1400"
                role="img"
                aria-labelledby="showcase-import-title"
                focusable="false"
              >
                <title id="showcase-import-title">
                  {t.showcaseSection.importAlt}
                </title>
                <image
                  href="/screenshots/musicmute-app-showcase.png"
                  width="2030"
                  height="2002"
                />
              </svg>
              <figcaption>{t.showcaseSection.importCaption}</figcaption>
            </figure>
            <figure className="showcase-device showcase-device-player">
              <svg
                viewBox="1170 500 690 1340"
                role="img"
                aria-labelledby="showcase-player-title"
                focusable="false"
              >
                <title id="showcase-player-title">
                  {t.showcaseSection.playerAlt}
                </title>
                <image
                  href="/screenshots/musicmute-app-showcase.png"
                  width="2030"
                  height="2002"
                />
              </svg>
              <figcaption>{t.showcaseSection.playerCaption}</figcaption>
            </figure>
          </div>
        </section>

        <section
          className="section how-section"
          id="how-it-works"
          aria-labelledby="how-title"
        >
          <div className="section-heading centered-heading">
            <p className="eyebrow">{t.howSection.eyebrow}</p>
            <h2 id="how-title">{t.howSection.title}</h2>
            <p>{t.howSection.body}</p>
          </div>
          <div className="steps-grid">
            {t.howSection.steps.map((step, index) => {
              const StepIcon = stepIcons[index];
              return (
                <article className="step-card" key={step.title}>
                  <div className="step-topline">
                    <span className="step-number">0{index + 1}</span>
                    <span className="step-icon">
                      <StepIcon aria-hidden="true" />
                    </span>
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section
          className="section features-section"
          id="features"
          aria-labelledby="features-title"
        >
          <div className="section-heading split-heading">
            <div>
              <p className="eyebrow">{t.featuresSection.eyebrow}</p>
              <h2 id="features-title">{t.featuresSection.title}</h2>
            </div>
            <p>{t.featuresSection.body}</p>
          </div>
          <div className="features-grid">
            {t.featuresSection.features.map((feature, index) => {
              const FeatureIcon = featureIcons[index];
              return (
                <article className="feature-card" key={feature.title}>
                  <span className="feature-icon">
                    <FeatureIcon aria-hidden="true" />
                  </span>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section
          className="section trust-section"
          aria-labelledby="trust-title"
        >
          <div className="trust-visual" aria-hidden="true">
            <div className="privacy-orbit orbit-one" />
            <div className="privacy-orbit orbit-two" />
            <span className="privacy-core">
              <ShieldCheck />
            </span>
          </div>
          <div className="trust-copy">
            <p className="eyebrow">{t.trustSection.eyebrow}</p>
            <h2 id="trust-title">{t.trustSection.title}</h2>
            <p>{t.trustSection.body}</p>
            <ul className="check-list">
              {t.trustSection.points.map((point) => (
                <li key={point}>
                  <Check aria-hidden="true" />
                  {point}
                </li>
              ))}
            </ul>
            <ExternalLink className="text-link" href={PRODUCT_LINKS.privacy}>
              {t.trustSection.privacyAction}
              <ArrowUpRight aria-hidden="true" />
            </ExternalLink>
          </div>
        </section>

        <section
          className="section apps-section"
          id="downloads"
          aria-labelledby="apps-title"
        >
          <div className="section-heading centered-heading">
            <p className="eyebrow">{t.appsSection.eyebrow}</p>
            <h2 id="apps-title">{t.appsSection.title}</h2>
            <p>{t.appsSection.body}</p>
          </div>
          <div className="apps-grid">
            <article className="app-card app-card-featured">
              <div className="app-card-heading">
                <span className="app-icon">
                  <Globe2 aria-hidden="true" />
                </span>
                <span className="status-chip status-live">
                  {t.appsSection.web.status}
                </span>
              </div>
              <h3>{t.appsSection.web.title}</h3>
              <p>{t.appsSection.web.body}</p>
              <ExternalLink className="card-action" href={PRODUCT_LINKS.webApp}>
                {t.appsSection.web.action}
                <ArrowUpRight aria-hidden="true" />
              </ExternalLink>
            </article>
            <article className="app-card">
              <div className="app-card-heading">
                <span className="app-icon">
                  <Smartphone aria-hidden="true" />
                </span>
                <span className="status-chip">
                  {t.appsSection.mobile.status}
                </span>
              </div>
              <h3>{t.appsSection.mobile.title}</h3>
              <p>{t.appsSection.mobile.body}</p>
            </article>
            <article className="app-card">
              <div className="app-card-heading">
                <span className="app-icon">
                  <Laptop aria-hidden="true" />
                </span>
                <span className="status-chip">
                  {t.appsSection.desktop.status}
                </span>
              </div>
              <h3>{t.appsSection.desktop.title}</h3>
              <p>{t.appsSection.desktop.body}</p>
            </article>
          </div>
          <p className="release-note">
            <ShieldCheck aria-hidden="true" />
            {t.appsSection.releaseNote}
          </p>
        </section>

        <section
          className="section faq-section"
          id="faq"
          aria-labelledby="faq-title"
        >
          <div className="section-heading faq-heading">
            <p className="eyebrow">{t.faqSection.eyebrow}</p>
            <h2 id="faq-title">{t.faqSection.title}</h2>
          </div>
          <div className="faq-list">
            {t.faqSection.items.map((item) => (
              <details key={item.question}>
                <summary>
                  {item.question}
                  <ChevronDown aria-hidden="true" />
                </summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="closing-section" aria-labelledby="closing-title">
          <div className="closing-mark" aria-hidden="true">
            <SoloSignalMark />
          </div>
          <p className="eyebrow">{t.closing.eyebrow}</p>
          <h2 id="closing-title">{t.closing.title}</h2>
          <p>{t.closing.body}</p>
          <ExternalLink className="button" href={PRODUCT_LINKS.webApp}>
            {t.openApp}
            <ArrowUpRight aria-hidden="true" />
          </ExternalLink>
        </section>
      </main>

      <footer className="site-footer">
        <div className="footer-brand">
          <span className="brand-mark">
            <SoloSignalMark />
          </span>
          <div>
            <strong>MusicMute</strong>
            <p>{t.footer.summary}</p>
          </div>
        </div>
        <nav className="footer-links" aria-label={t.a11y.legalNavigation}>
          <ExternalLink href={PRODUCT_LINKS.privacy}>
            {t.footer.privacy}
          </ExternalLink>
          <ExternalLink href={PRODUCT_LINKS.support}>
            {t.footer.support}
          </ExternalLink>
          <ExternalLink href={PRODUCT_LINKS.deleteAccount}>
            {t.footer.deleteAccount}
          </ExternalLink>
        </nav>
        <p className="footer-rights">{t.footer.rights}</p>
      </footer>
    </div>
  );
}
