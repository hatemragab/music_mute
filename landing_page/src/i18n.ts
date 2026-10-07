export type Language = "en" | "ar";

interface ContentItem {
  title: string;
  body: string;
}

interface FaqItem {
  question: string;
  answer: string;
}

export interface Translation {
  languageName: string;
  languageAction: string;
  openApp: string;
  a11y: {
    skipContent: string;
    home: string;
    primaryNavigation: string;
    highlights: string;
    legalNavigation: string;
  };
  nav: {
    demo: string;
    how: string;
    features: string;
    apps: string;
    faq: string;
  };
  hero: {
    eyebrow: string;
    lead: string;
    accent: string;
    body: string;
    secondaryAction: string;
    rightsNote: string;
    previewLabel: string;
    sourceTrack: string;
    resultTrack: string;
    ready: string;
  };
  proofPoints: string[];
  demoSection: {
    eyebrow: string;
    title: string;
    body: string;
    tabListLabel: string;
    originalLabel: string;
    originalDescription: string;
    voiceLabel: string;
    voiceDescription: string;
    playerLabel: string;
    switchHint: string;
    unavailable: string;
    exampleNote: string;
  };
  sourceSection: {
    eyebrow: string;
    title: string;
    body: string;
    localAudio: string;
    publicLinks: string;
    availabilityNote: string;
  };
  sourceNames: string[];
  howSection: {
    eyebrow: string;
    title: string;
    body: string;
    steps: ContentItem[];
  };
  featuresSection: {
    eyebrow: string;
    title: string;
    body: string;
    features: ContentItem[];
  };
  showcaseSection: {
    eyebrow: string;
    title: string;
    body: string;
    importCaption: string;
    playerCaption: string;
    importAlt: string;
    playerAlt: string;
  };
  trustSection: {
    eyebrow: string;
    title: string;
    body: string;
    points: string[];
    privacyAction: string;
  };
  appsSection: {
    eyebrow: string;
    title: string;
    body: string;
    web: ContentItem & { status: string; action: string };
    mobile: ContentItem & { status: string };
    desktop: ContentItem & { status: string };
    releaseNote: string;
  };
  faqSection: {
    eyebrow: string;
    title: string;
    items: FaqItem[];
  };
  closing: {
    eyebrow: string;
    title: string;
    body: string;
  };
  footer: {
    summary: string;
    privacy: string;
    support: string;
    deleteAccount: string;
    rights: string;
  };
}

const en: Translation = {
  languageName: "English",
  languageAction: "العربية",
  openApp: "Open web app",
  a11y: {
    skipContent: "Skip to main content",
    home: "MusicMute home",
    primaryNavigation: "Primary navigation",
    highlights: "MusicMute highlights",
    legalNavigation: "Legal and support",
  },
  nav: {
    demo: "Listen",
    how: "How it works",
    features: "What you get",
    apps: "Apps",
    faq: "Questions",
  },
  hero: {
    eyebrow: "AI vocal isolation",
    lead: "Remove the music.",
    accent: "Keep the voice.",
    body: "Import a compatible audio file you have permission to process, or use a supported public link. MusicMute creates a voice-only track you can play, save, and share.",
    secondaryAction: "See how it works",
    rightsNote: "Only process audio you own or have permission to use.",
    previewLabel: "A clearer voice track",
    sourceTrack: "Original mix",
    resultTrack: "Voice only",
    ready: "Ready",
  },
  proofPoints: [
    "Compatible local audio",
    "Supported public links",
    "Live processing progress",
    "English + Arabic",
  ],
  demoSection: {
    eyebrow: "A real comparison",
    title: "Hear the difference yourself.",
    body: "Play the example once, then switch between the original mix and the voice-only result at the same moment.",
    tabListLabel: "Choose which version to hear",
    originalLabel: "Original",
    originalDescription: "Voice and music before processing.",
    voiceLabel: "Voice only",
    voiceDescription: "The MusicMute result after reducing the music.",
    playerLabel: "Original and voice-only comparison player",
    switchHint: "Playback keeps the same position when you switch tracks.",
    unavailable:
      "The listening example is being prepared. Please check back soon.",
    exampleNote:
      "This is one example. Separation results vary with each recording and mix.",
  },
  sourceSection: {
    eyebrow: "Bring your audio",
    title: "Start with the sound you already have.",
    body: "Choose a compatible audio file in the web app or paste a supported, public, single-item link. MusicMute checks the input before processing begins.",
    localAudio: "Local audio",
    publicLinks: "Public links",
    availabilityNote:
      "Link support depends on the individual item and the availability of usable audio. A listed service is not a guarantee that every link can be imported.",
  },
  sourceNames: [
    "YouTube",
    "Instagram / Reels",
    "TikTok",
    "Vimeo",
    "SoundCloud",
    "Facebook / Reels",
  ],
  howSection: {
    eyebrow: "Three clear steps",
    title: "From full mix to focused voice.",
    body: "The workflow stays simple while each processing stage remains visible.",
    steps: [
      {
        title: "Import and review",
        body: "Choose compatible audio or paste a supported link, review the source, and confirm your permission to process it.",
      },
      {
        title: "Remove the music",
        body: "MusicMute prepares the audio and isolates the vocal track while showing live job progress.",
      },
      {
        title: "Listen and save",
        body: "Play the voice-only result, then download, save, share, rename, or remove it from your library.",
      },
    ],
  },
  featuresSection: {
    eyebrow: "Made for real listening",
    title: "Keep the result useful after processing.",
    body: "MusicMute carries the voice-only track from import through playback and your private library.",
    features: [
      {
        title: "One place for your results",
        body: "Keep completed voice tracks and job history together in your MusicMute library.",
      },
      {
        title: "Progress you can follow",
        body: "See live stages and queue status instead of waiting on an unexplained loading screen.",
      },
      {
        title: "Private transfer path",
        body: "Local uploads use authenticated, time-limited transfers to private application storage.",
      },
      {
        title: "English and Arabic",
        body: "Use the same complete journey in English or Arabic, with a true right-to-left layout.",
      },
    ],
  },
  showcaseSection: {
    eyebrow: "Inside the product",
    title: "See the real app.",
    body: "The same calm, dark experience carries you from importing and following live jobs to comparing voice-only with the original.",
    importCaption: "Import & jobs",
    playerCaption: "Now playing",
    importAlt: "MusicMute import and live jobs screen on a phone",
    playerAlt:
      "MusicMute player with voice-only and original-audio switching on a phone",
  },
  trustSection: {
    eyebrow: "Permission first",
    title: "Your audio is not a marketing asset.",
    body: "MusicMute asks you to confirm your rights before processing. Local uploads remain private, and account controls include a documented deletion path.",
    points: [
      "Explicit rights confirmation before submission",
      "Authenticated, short-lived media transfers",
      "Visible privacy, support, and account-deletion resources",
    ],
    privacyAction: "Read the privacy notice",
  },
  appsSection: {
    eyebrow: "Choose your screen",
    title: "MusicMute starts on the web.",
    body: "Use the browser app today. Verified public links for mobile and desktop releases will appear here when those releases are ready.",
    web: {
      status: "Available now",
      title: "Web",
      body: "Import audio or supported links, follow processing, and manage your library in a modern browser.",
      action: "Open MusicMute",
    },
    mobile: {
      status: "Release link pending",
      title: "Android + iPhone",
      body: "Native mobile clients are being prepared and validated independently before public store links are shown.",
    },
    desktop: {
      status: "Release in preparation",
      title: "macOS + Chrome",
      body: "The local Mac and Chrome experience is not yet presented as a public download or store release.",
    },
    releaseNote:
      "No store badge or download link is shown until the exact public release is verified.",
  },
  faqSection: {
    eyebrow: "Good to know",
    title: "Questions before you start.",
    items: [
      {
        question: "What does MusicMute create?",
        answer:
          "MusicMute creates a voice-only MP3 result by reducing background music. Separation quality depends on the source recording and mix.",
      },
      {
        question: "How does the listening example stay in sync?",
        answer:
          "The two public demo files use the same aligned excerpt. When you change tabs, the player keeps the current playback position and continues when the browser allows it.",
      },
      {
        question: "What can I import on the web?",
        answer:
          "The browser accepts compatible local audio and supported public, single-item links. It does not accept local video, and not every public item exposes usable audio.",
      },
      {
        question: "Does the web app work offline?",
        answer:
          "No. The browser journey needs an internet connection, and the tab should remain available while a local file is prepared and uploaded.",
      },
      {
        question: "Is every platform downloadable now?",
        answer:
          "The web app is the current verified destination. Mobile, macOS, and Chrome links will be added only after each public release is independently verified.",
      },
      {
        question: "Can I process any recording?",
        answer:
          "Only process audio you own or have permission to use. MusicMute asks for that confirmation before submission.",
      },
    ],
  },
  closing: {
    eyebrow: "Make room for your voice",
    title: "Ready to hear what matters?",
    body: "Bring a compatible track to MusicMute and create a focused voice-only result.",
  },
  footer: {
    summary: "Remove background music. Keep the voice.",
    privacy: "Privacy",
    support: "Support",
    deleteAccount: "Delete account",
    rights: "Only process audio you own or have permission to use.",
  },
};

const ar: Translation = {
  languageName: "العربية",
  languageAction: "English",
  openApp: "افتح تطبيق الويب",
  a11y: {
    skipContent: "انتقل إلى المحتوى الرئيسي",
    home: "الصفحة الرئيسية لميوزك ميوت",
    primaryNavigation: "التنقل الرئيسي",
    highlights: "مميزات ميوزك ميوت",
    legalNavigation: "الروابط القانونية والدعم",
  },
  nav: {
    demo: "اسمع الفرق",
    how: "كيف يعمل",
    features: "ما الذي تحصل عليه",
    apps: "التطبيقات",
    faq: "الأسئلة",
  },
  hero: {
    eyebrow: "عزل الصوت بالذكاء الاصطناعي",
    lead: "أزل الموسيقى.",
    accent: "واحتفظ بالصوت.",
    body: "استورد ملفاً صوتياً متوافقاً لديك إذن بمعالجته، أو استخدم رابطاً عاماً مدعوماً. ينشئ ميوزك ميوت مقطعاً صوتياً فقط يمكنك تشغيله وحفظه ومشاركته.",
    secondaryAction: "تعرّف على الطريقة",
    rightsNote: "عالج فقط الصوت الذي تملكه أو لديك إذن باستخدامه.",
    previewLabel: "مقطع صوت أوضح",
    sourceTrack: "المقطع الأصلي",
    resultTrack: "الصوت فقط",
    ready: "جاهز",
  },
  proofPoints: [
    "ملفات صوتية محلية متوافقة",
    "روابط عامة مدعومة",
    "تقدم مباشر للمعالجة",
    "العربية والإنجليزية",
  ],
  demoSection: {
    eyebrow: "مقارنة حقيقية",
    title: "اسمع الفرق بنفسك.",
    body: "شغّل المثال مرة واحدة، ثم بدّل بين المقطع الأصلي ونتيجة الصوت فقط عند اللحظة نفسها.",
    tabListLabel: "اختر المقطع الذي تريد سماعه",
    originalLabel: "المقطع الأصلي",
    originalDescription: "الصوت والموسيقى قبل المعالجة.",
    voiceLabel: "الصوت فقط",
    voiceDescription: "نتيجة ميوزك ميوت بعد تقليل الموسيقى.",
    playerLabel: "مشغّل مقارنة المقطع الأصلي والصوت فقط",
    switchHint: "يستمر التشغيل من الموضع نفسه عند تبديل المقطع.",
    unavailable: "يجري تجهيز المثال الصوتي. عُد قريباً للاستماع إلى المقارنة.",
    exampleNote: "هذا مثال واحد؛ تختلف نتيجة العزل باختلاف التسجيل والمزيج.",
  },
  sourceSection: {
    eyebrow: "أضف صوتك",
    title: "ابدأ بالصوت الموجود لديك.",
    body: "اختر ملفاً صوتياً متوافقاً في تطبيق الويب أو الصق رابطاً عاماً مدعوماً لعنصر واحد. يتحقق ميوزك ميوت من المصدر قبل بدء المعالجة.",
    localAudio: "صوت محلي",
    publicLinks: "روابط عامة",
    availabilityNote:
      "يعتمد دعم الرابط على العنصر نفسه وتوفر صوت صالح للاستخدام. ظهور الخدمة في القائمة لا يضمن إمكانية استيراد كل رابط.",
  },
  sourceNames: [
    "YouTube",
    "Instagram / Reels",
    "TikTok",
    "Vimeo",
    "SoundCloud",
    "Facebook / Reels",
  ],
  howSection: {
    eyebrow: "ثلاث خطوات واضحة",
    title: "من المقطع الكامل إلى صوتٍ مركز.",
    body: "تبقى الخطوات بسيطة، مع إظهار كل مرحلة من مراحل المعالجة.",
    steps: [
      {
        title: "استورد وراجع",
        body: "اختر صوتاً متوافقاً أو الصق رابطاً مدعوماً، وراجع المصدر ثم أكد أن لديك إذناً بمعالجته.",
      },
      {
        title: "أزل الموسيقى",
        body: "يجهز ميوزك ميوت الصوت ويعزل المقطع الصوتي مع عرض تقدم المهمة مباشرة.",
      },
      {
        title: "استمع واحفظ",
        body: "شغّل نتيجة الصوت فقط، ثم نزّلها أو احفظها أو شاركها أو أعد تسميتها أو احذفها من مكتبتك.",
      },
    ],
  },
  featuresSection: {
    eyebrow: "مصمم للاستماع الحقيقي",
    title: "احتفظ بنتيجة مفيدة بعد المعالجة.",
    body: "يرافق ميوزك ميوت مقطع الصوت فقط من الاستيراد حتى التشغيل والحفظ في مكتبتك الخاصة.",
    features: [
      {
        title: "مكان واحد لنتائجك",
        body: "احتفظ بمقاطع الصوت المكتملة وسجل المهام معاً في مكتبة ميوزك ميوت.",
      },
      {
        title: "تقدم يمكنك متابعته",
        body: "شاهد المراحل وحالة الانتظار مباشرة بدلاً من شاشة تحميل بلا تفسير.",
      },
      {
        title: "نقل خاص للملفات",
        body: "تستخدم الملفات المحلية عمليات نقل موثقة ومحدودة المدة إلى مساحة التطبيق الخاصة.",
      },
      {
        title: "العربية والإنجليزية",
        body: "استخدم الرحلة الكاملة نفسها بالإنجليزية أو العربية مع تخطيط حقيقي من اليمين إلى اليسار.",
      },
    ],
  },
  showcaseSection: {
    eyebrow: "داخل التطبيق",
    title: "شاهد تطبيق ميوزك ميوت الحقيقي.",
    body: "واجهة هادئة ومظلمة ترافقك من الاستيراد وتحديثات المهام المباشرة إلى مقارنة الصوت الأصلي بنتيجة الصوت فقط.",
    importCaption: "الاستيراد والمهام",
    playerCaption: "التشغيل الآن",
    importAlt: "شاشة ميوزك ميوت للاستيراد ومتابعة المهام على هاتف",
    playerAlt:
      "شاشة مشغل ميوزك ميوت مع التبديل بين الصوت فقط والمقطع الأصلي على هاتف",
  },
  trustSection: {
    eyebrow: "الإذن أولاً",
    title: "صوتك ليس مادة تسويقية.",
    body: "يطلب منك ميوزك ميوت تأكيد حقوقك قبل المعالجة. تبقى الملفات المحلية خاصة، وتتضمن أدوات الحساب مساراً واضحاً للحذف.",
    points: [
      "تأكيد صريح للحقوق قبل الإرسال",
      "نقل وسائط موثق ومحدود المدة",
      "روابط واضحة للخصوصية والدعم وحذف الحساب",
    ],
    privacyAction: "اقرأ إشعار الخصوصية",
  },
  appsSection: {
    eyebrow: "اختر شاشتك",
    title: "يبدأ ميوزك ميوت على الويب.",
    body: "استخدم تطبيق المتصفح اليوم. ستظهر هنا روابط الإصدارات الموثقة للهاتف وسطح المكتب عندما تصبح جاهزة.",
    web: {
      status: "متاح الآن",
      title: "الويب",
      body: "استورد الصوت أو الروابط المدعومة، وتابع المعالجة وأدر مكتبتك في متصفح حديث.",
      action: "افتح ميوزك ميوت",
    },
    mobile: {
      status: "رابط الإصدار قيد الانتظار",
      title: "Android و iPhone",
      body: "يجري تجهيز تطبيقات الهاتف الأصلية والتحقق من كل إصدار قبل عرض روابط المتاجر العامة.",
    },
    desktop: {
      status: "الإصدار قيد التجهيز",
      title: "macOS و Chrome",
      body: "تجربة Mac المحلية وChrome غير معروضة حالياً كتنزيل عام أو إصدار متجر.",
    },
    releaseNote:
      "لا نعرض شارة متجر أو رابط تنزيل حتى يتم التحقق من الإصدار العام نفسه.",
  },
  faqSection: {
    eyebrow: "معلومات مهمة",
    title: "أسئلة قبل أن تبدأ.",
    items: [
      {
        question: "ما النتيجة التي ينشئها ميوزك ميوت؟",
        answer:
          "ينشئ ميوزك ميوت ملف MP3 للصوت فقط عبر تقليل الموسيقى الخلفية. تختلف جودة العزل بحسب التسجيل والمزيج الأصلي.",
      },
      {
        question: "كيف يبقى مثال الاستماع متزامناً؟",
        answer:
          "يستخدم الملفان العامان المقطع نفسه مع محاذاة التوقيت. عند تبديل علامة التبويب، يحتفظ المشغّل بموضع التشغيل الحالي ويستمر عندما يسمح المتصفح بذلك.",
      },
      {
        question: "ما الذي يمكنني استيراده على الويب؟",
        answer:
          "يقبل المتصفح صوتاً محلياً متوافقاً وروابط عامة مدعومة لعنصر واحد. لا يقبل الفيديو المحلي، ولا يوفر كل عنصر عام صوتاً صالحاً للاستخدام.",
      },
      {
        question: "هل يعمل تطبيق الويب دون اتصال؟",
        answer:
          "لا. تحتاج تجربة المتصفح إلى اتصال بالإنترنت، ويجب إبقاء علامة التبويب متاحة أثناء تجهيز الملف المحلي ورفعه.",
      },
      {
        question: "هل يمكن تنزيل كل المنصات الآن؟",
        answer:
          "تطبيق الويب هو الوجهة الموثقة حالياً. ستُضاف روابط الهاتف وmacOS وChrome بعد التحقق المستقل من كل إصدار عام.",
      },
      {
        question: "هل يمكنني معالجة أي تسجيل؟",
        answer:
          "عالج فقط الصوت الذي تملكه أو لديك إذن باستخدامه. يطلب ميوزك ميوت هذا التأكيد قبل الإرسال.",
      },
    ],
  },
  closing: {
    eyebrow: "أفسح المجال لصوتك",
    title: "هل أنت مستعد لسماع ما يهم؟",
    body: "أضف مقطعاً متوافقاً إلى ميوزك ميوت وأنشئ نتيجة تركز على الصوت فقط.",
  },
  footer: {
    summary: "أزل الموسيقى. واحتفظ بالصوت.",
    privacy: "الخصوصية",
    support: "الدعم",
    deleteAccount: "حذف الحساب",
    rights: "عالج فقط الصوت الذي تملكه أو لديك إذن باستخدامه.",
  },
};

export const messages: Record<Language, Translation> = { en, ar };

export const LANGUAGE_STORAGE_KEY = "musicmute.landing.language.v1";

export function resolveInitialLanguage(
  routeLanguage: string | null,
  stored: string | null,
  browserLanguages: readonly string[],
): Language {
  if (routeLanguage === "en" || routeLanguage === "ar") return routeLanguage;
  if (stored === "en" || stored === "ar") return stored;
  for (const language of browserLanguages) {
    const normalized = language.toLowerCase();
    if (normalized === "ar" || normalized.startsWith("ar-")) return "ar";
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
  }
  return "en";
}
