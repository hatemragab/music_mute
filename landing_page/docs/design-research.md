# Landing-page design research

Checked on 2026-10-07 using official repositories and project documentation.

## Strong open-source options

| Project                                                                             | License and stack                                                                                         | Good fit                                                                                                          | Tradeoffs for MusicMute                                                                                                               |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [AstroWind](https://github.com/arthelokyo/astrowind)                                | [MIT](https://github.com/arthelokyo/astrowind/blob/main/LICENSE.md); Astro, TypeScript, Tailwind          | Best foundation for a future multi-page marketing site, blog, SEO-heavy content, dark mode, and RTL-aware layouts | Much larger than this one-page need; its default language/direction configuration is not a complete runtime English/Arabic experience |
| [Landy](https://github.com/Adrinlol/landy-react-template)                           | [MIT](https://github.com/Adrinlol/landy-react-template/blob/master/LICENSE); React, TypeScript, i18next   | Multilingual content structure and reusable landing sections                                                      | Legacy Create React App, older dependencies, generic illustrations, and no complete RTL guarantee                                     |
| [Start Bootstrap New Age](https://github.com/StartBootstrap/startbootstrap-new-age) | [MIT](https://github.com/StartBootstrap/startbootstrap-new-age/blob/master/LICENSE); Bootstrap, Pug, Sass | Clear app-landing structure and simple static deployment                                                          | Mobile-only framing, dated visual baseline, and no localization architecture                                                          |
| [Landwind](https://github.com/themesberg/landwind)                                  | [MIT](https://github.com/themesberg/landwind/blob/main/LICENSE); HTML, Tailwind, Flowbite                 | Fast static start with many conventional marketing sections                                                       | Monolithic template, older dependencies, no tests/RTL structure, and placeholder claims that must be removed                          |

[Cruip Open](https://github.com/cruip/open-react-template) is a useful dark visual
reference, but its repository combines a broad “GPL” statement with additional
redistribution/resale terms. It was not selected as a commercial code base without a
separate license review.

## Decision

Use a custom, small React/Vite implementation aligned with the existing MusicMute
web stack. Reusing a generic template would still require replacing almost every
visual, claim, CTA, platform state, and localization detail. The custom page keeps:

- the real Solo Signal mark and MusicMute palette;
- a product-specific original-mix/voice-only waveform composition;
- accurate web, mobile, and desktop availability;
- English/Arabic browser detection and RTL;
- the stable `#downloads` destination already linked by MusicMute clients;
- the same Node 24, TypeScript, Vite, test, and CapRover patterns used elsewhere in
  the repository.

AstroWind remains the strongest migration candidate if the public site later needs a
blog, documentation, many SEO landing pages, or pre-rendered language routes.
