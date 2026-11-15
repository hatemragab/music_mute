# Microsoft Store listing drafts — 15 October 2026

**Draft only — not published.** Local GPU processing needs **two separately
installed apps**: MusicMute provides the interface; MusicMute Worker supplies the
companion runtime. Target systems are **Windows 10 22H2 (build 19045) and Windows
11, Intel/AMD x64 only**; ARM, x64-on-ARM emulation and x86 are unsupported.
Inference requires a successfully qualified DirectML GPU. The Windows migration
retains the existing model, production recipes and quality settings. The shared
Chrome extension is optional and currently supplied as a bundled folder for
manual installation through Chrome's Developer mode and **Load unpacked**.
No Chrome Web Store availability is claimed.

Worker runs only while the user is logged into Windows, as a standard user
without an administrator service. Its standalone window manages Windows startup;
processing controls are in MusicMute. Optional fleet processing requires explicit enrollment, Google sign-in and
administrator approval. Closing the GUI or signing out of its account does not
stop an independently enrolled worker.

These drafts describe implemented source scope, not completed installed
acceptance. Screenshots, privacy disclosures, redistribution/license review,
restricted-capability approval, Store certification and supported-device
acceptance remain pending. Do not paste the review notes below into a listing or
publish these drafts without completing the applicable reviews.

**15 October material checkpoint:** all four description/short-description/
seven-feature records are saved in Partner Center and matched after reopening.
Both products also have saved EN/AR Windows privacy text and reviewer notes.
Listings remain Incomplete for authentic screenshots; no certification or
publication occurred. See the [readiness index](STORE-REVIEW-READINESS-2026-10-15.md).

## MusicMute — English

Store product: `9P7VX8JK8B68` · package identity: `27120VCHATSDK.MusicMute`

### Short description

Separate voice from music using a qualified GPU. Requires MusicMute Worker on
Windows 10 22H2 or Windows 11 x64, with Library, playback and an optional shared
Chrome extension.

### Description

MusicMute requires the separately installed **MusicMute Worker** companion app
for local GPU processing. Both apps are needed to prepare this PC and process
audio locally.

For Windows 10 22H2 and Windows 11 on Intel/AMD x64 PCs. ARM and x86 are not
supported. A qualified DirectML GPU is required; local inference uses the existing
MusicMute voice model and production recipes, with no automatic CPU or cloud
fallback.

Separate voice from background music in audio you have permission to process.
Import supported audio files or audio from supported video files, follow job
progress, compare original and voice playback, and manage saved results in your
Library. Prepare checks the installed Worker, downloads the model when needed
and qualifies GPU processing. Personal local use does not require an account.
Email or Google sign-in enables account features; online features depend on
connectivity and account policy.

Worker runs as a standard user while you are logged into Windows, with controls
for starting, pausing and stopping approved fleet participation. Fleet enrollment
is optional and requires explicit registration, Google sign-in and administrator
approval.

The optional shared Chrome extension adds supported YouTube playback controls.
Setup provides its bundled folder and manual **Load unpacked** instructions in
Chrome's Developer mode. The extension is not installed automatically.

### Feature bullets

- Local voice separation with the existing MusicMute model and processing recipes.
- Home, Library, Account, Setup, Worker, Diagnostics and Settings views.
- Original/voice playback, saved-result management and audio export.
- Prepare progress, cancellation, retry, repair and GPU readiness checks.
- Personal local processing while signed out; optional account and online features.
- English and Arabic interface, including right-to-left layouts.
- Optional shared Chrome extension with a separate manual installation step.

## MusicMute — العربية

### الوصف المختصر

فصل الصوت عن الموسيقى باستخدام بطاقة رسومات مؤهلة. يتطلب التطبيق المرافق MusicMute Worker، ويدعم Windows 10 22H2 وWindows 11 على أجهزة Intel أو AMD ببنية x64، مع المكتبة والتشغيل وإضافة Chrome اختيارية.

### الوصف

يتطلب MusicMute تثبيت التطبيق المرافق **MusicMute Worker** بشكل مستقل للمعالجة
المحلية باستخدام بطاقة الرسومات. يلزم التطبيقان لإعداد هذا الكمبيوتر ومعالجة
الصوت محليًا.

مخصص لنظامي Windows 10 22H2 وWindows 11 على أجهزة Intel أو AMD ببنية x64.
لا يدعم ARM أو x86 أو محاكاة x64 على ARM. يشترط نجاح تأهيل بطاقة الرسومات
باستخدام DirectML. تستخدم المعالجة المحلية نموذج MusicMute وإعدادات المعالجة
المعتمدة نفسها، دون التحويل التلقائي إلى المعالجة على المعالج المركزي أو السحابة.

افصل الصوت البشري عن الموسيقى الخلفية في المحتوى الذي تملك إذنًا بمعالجته.
استورد ملفات الصوت المدعومة أو الصوت من ملفات الفيديو المدعومة، وتابع تقدم
المهام، وقارن بين تشغيل الأصل والصوت المعزول، ونظّم النتائج المحفوظة في المكتبة.
يتحقق الإعداد من تطبيق Worker المثبّت، وينزّل النموذج عند الحاجة، ويختبر المعالجة
على بطاقة الرسومات. لا يتطلب الاستخدام المحلي الشخصي حسابًا. يتيح تسجيل الدخول
بالبريد الإلكتروني أو Google ميزات الحساب؛ وتعتمد الميزات المتصلة بالإنترنت على
الاتصال وسياسة الحساب.

يعمل Worker بصلاحيات المستخدم العادي أثناء تسجيل الدخول إلى Windows، مع أدوات
لبدء المشاركة المعتمدة في مهام الخدمة وإيقافها مؤقتًا وإيقافها. هذه المشاركة
اختيارية وتتطلب التسجيل الصريح وتسجيل الدخول باستخدام Google وموافقة مسؤول الخدمة.

تضيف إضافة Chrome المشتركة والاختيارية أدوات التحكم المدعومة لتشغيل YouTube.
يوفر قسم الإعداد مجلد الإضافة المرفق وتعليمات تثبيتها يدويًا عبر وضع المطوّر في
Chrome وخيار **Load unpacked**. لا تُثبَّت الإضافة تلقائيًا.

### الميزات

- فصل الصوت محليًا باستخدام نموذج MusicMute وإعدادات المعالجة المعتمدة نفسها.
- أقسام الرئيسية والمكتبة والحساب والإعداد والعامل والتشخيص والإعدادات.
- تشغيل الأصل والصوت المعزول، وإدارة النتائج المحفوظة وتصدير الصوت.
- متابعة الإعداد وإلغاؤه وإعادة المحاولة والإصلاح والتحقق من جاهزية بطاقة الرسومات.
- معالجة محلية شخصية دون تسجيل الدخول، مع ميزات اختيارية للحساب والإنترنت.
- واجهة بالعربية والإنجليزية تدعم العرض من اليمين إلى اليسار.
- إضافة Chrome مشتركة واختيارية تتطلب تثبيتًا يدويًا منفصلًا.

## MusicMute Worker — English

Store product: `9P4GXB0NRJDG` · package identity: `27120VCHATSDK.MusicMuteWorker`

### Short description

Companion GPU processing runtime for MusicMute. Use MusicMute for preparation and
processing controls; use MusicMute Worker to manage Windows sign-in startup.

### Description

MusicMute Worker is the separately installed processing companion for MusicMute.
Install MusicMute too for preparation, local processing, account, Library,
playback and Worker management. Installing Worker does not enroll this PC in
fleet processing.

For Windows 10 22H2 (build 19045) and Windows 11 on Intel/AMD x64 PCs. ARM,
x64-on-ARM emulation and x86 are unsupported. Local inference requires a
successfully qualified DirectML GPU and retains the existing MusicMute model,
production recipes and quality settings, with no automatic CPU or cloud
inference fallback.

Open MusicMute Worker to check Windows startup status, request startup at
sign-in or turn startup off. Startup is initially disabled. Turning startup off
does not stop a worker that is already running, and the app respects choices
enforced by Windows or its administrator.

Use the Worker view inside MusicMute for enrollment, processing status, start,
pause, finish accepted jobs, resume, stop and advanced tools. Preparation and
runtime diagnostics are also accessed through MusicMute.

Worker runs as the standard Windows user while that user remains signed in,
without an administrator service. It can continue independently of MusicMute's
window; Windows sign-out ends its session. Personal local processing does not
require fleet enrollment or a MusicMute account.

Optional fleet participation requires explicit PC enrollment, Google sign-in and
administrator approval. Approved fleet work uses this PC's processing, storage
and network resources. Closing MusicMute or signing out of its account does not
revoke an independently enrolled worker. Stop and drain wait for accepted work
to finish.

The optional shared Chrome extension is supplied through MusicMute's Prepare
view for manual **Load unpacked** installation in Chrome's Developer mode.

### Feature bullets

- Separately installed GPU processing runtime for MusicMute.
- Existing model and production recipes; qualified DirectML GPU inference.
- Standalone Windows sign-in startup status and controls.
- Preparation, processing, diagnostics and fleet controls through MusicMute.
- Optional fleet enrollment requires Google sign-in and administrator approval.
- Standard-user session; Windows sign-out ends Worker operation.
- Bundled executable runtime updates through Microsoft Store.

## MusicMute Worker — العربية

### الوصف المختصر

بيئة المعالجة المرافقة لتطبيق MusicMute. استخدم MusicMute للإعداد والتحكم بالمعالجة، وMusicMute Worker لإدارة بدء التشغيل عند الدخول إلى Windows.

### الوصف

MusicMute Worker هو بيئة المعالجة المرافقة لتطبيق MusicMute، ويُثبَّت بشكل مستقل.
ثبّت MusicMute أيضًا للوصول إلى الإعداد والمعالجة المحلية والحساب والمكتبة
والتشغيل وإدارة العامل. ولا يؤدي تثبيت Worker إلى تسجيل هذا الكمبيوتر تلقائيًا
للمشاركة في معالجة مهام الخدمة.

مخصص لنظامي Windows 10 22H2 (الإصدار 19045) وWindows 11 على أجهزة Intel أو AMD ببنية x64.
لا يدعم ARM أو x86 أو محاكاة x64 على ARM. يشترط نجاح تأهيل بطاقة الرسومات
باستخدام DirectML، مع الاحتفاظ بنموذج MusicMute وإعدادات المعالجة والجودة نفسها،
دون التحويل التلقائي إلى المعالجة على المعالج المركزي أو السحابة.

افتح MusicMute Worker لفحص حالة بدء التشغيل في Windows، أو طلب تشغيل العامل عند
تسجيل الدخول، أو إيقاف بدء التشغيل. يكون بدء التشغيل معطّلًا في البداية. إيقاف
بدء التشغيل لا يوقف العامل الذي يعمل بالفعل، ويحترم التطبيق اختيارات Windows
والسياسات التي يفرضها مسؤول النظام.

استخدم قسم Worker داخل MusicMute للتسجيل وعرض حالة المعالجة والبدء والإيقاف
المؤقت وإنهاء المهام المقبولة والاستئناف والإيقاف والأدوات المتقدمة. تتوفر أدوات
الإعداد وتشخيص بيئة التشغيل أيضًا داخل MusicMute.

يعمل Worker ضمن جلسة مستخدم Windows المسجّل دخوله، دون خدمة تتطلب صلاحيات
مسؤول. يمكنه الاستمرار بشكل مستقل عن نافذة MusicMute؛ وينتهي تشغيل جلسته عند
تسجيل الخروج من Windows. لا تتطلب المعالجة المحلية الشخصية التسجيل للمشاركة
في مهام الخدمة أو امتلاك حساب MusicMute.

تتطلب المشاركة الاختيارية في معالجة مهام الخدمة تسجيل هذا الكمبيوتر صراحةً،
وتسجيل الدخول باستخدام Google، وموافقة مسؤول الخدمة. تستخدم المهام المعتمدة
موارد المعالجة والتخزين والشبكة على هذا الكمبيوتر. لا يؤدي إغلاق MusicMute
أو تسجيل الخروج من حسابه إلى إلغاء تسجيل العامل المستقل. ينتظر
الإيقاف وإنهاء المهام اكتمال العمل المقبول.

تتوفر إضافة Chrome المشتركة والاختيارية ضمن قسم الإعداد في MusicMute، لتثبيتها
يدويًا عبر وضع المطوّر في Chrome وخيار **Load unpacked**.

### الميزات

- بيئة معالجة ببطاقة الرسومات تُثبَّت بشكل مستقل وترافق MusicMute.
- النموذج وإعدادات المعالجة نفسها، باستخدام بطاقة رسومات مؤهلة عبر DirectML.
- نافذة مستقلة لفحص بدء التشغيل عند الدخول إلى Windows والتحكم به.
- الإعداد والمعالجة والتشخيص والتحكم بمهام الخدمة من داخل MusicMute.
- المشاركة الاختيارية تتطلب Google وموافقة مسؤول الخدمة.
- العمل بصلاحيات المستخدم؛ وتنتهي جلسة العامل عند الخروج من Windows.
- تحديث ملفات بيئة التشغيل المضمّنة عبر Microsoft Store.

## Review checklist — internal, not listing copy

- [ ] Obtain and test genuine Store-signed delivery of both independent products;
      package builds alone do not establish installability or feature acceptance.
- [ ] Confirm restricted-capability approval for the actual manifest profile and
      disclose independent background GPU/network processing during certification.
- [ ] Capture authentic screenshots of the current Windows candidate in the
      advertised languages. Both current executables require actual Store-origin
      authority before creating their windows; no supported unpackaged screenshot
      route exists. Do not bypass those gates or present mockups/prototypes as
      product evidence. Worker screenshots must show its own startup controls;
      the MusicMute Worker view belongs to the GUI product.
- [ ] Review the privacy policy destination and actual data disclosures for local
      processing, accounts, cloud features, Library synchronization and fleet work.
      No privacy URL is supplied or invented here.
- [ ] Complete model/dependency redistribution and license/notice review, plus
      acquisition/content-rights review. This copy grants no commercial or
      third-party content rights; users must have permission to process inputs.
- [ ] Confirm the extension delivery instructions against the final candidate.
      The current source supplies a development-install folder, not a verified
      public Chrome Web Store listing.
- [ ] Complete signed-out Prepare, GPU, account, Library, shared-extension and
      independent-worker lifecycle acceptance. Record Windows 10 22H2 and Windows
      11 separately; do not claim every GPU or an unmeasured VRAM/speed minimum.
- [ ] Review EN/AR copy against actual accepted behavior before submission.
      No public release or publication is authorized by this document.

## Source basis

- [Product invariants and S18 acceptance](MSIX-MIGRATION.md)
- [Independent package ownership and compatibility](PACKAGE-OWNERSHIP.md)
- [Policy, capability and redistribution review inputs](POLICY-REVIEW-2026-10-12.md)
- [Current package-build evidence and remaining gates](IMPLEMENTATION-2026-10-12.md#15-october-package-first-resume)
- [Windows component support](../../../windows-desktop/README.md)
- [Standalone Worker startup UI](../../../worker/native/windows-consumer/store_controls.cpp)
- [Actual bundled-extension instructions](../../../windows-desktop/src/renderer/setup-assistance-view.tsx)
- [Prepare UI](../../../windows-desktop/src/renderer/prepare-view.tsx),
  [Store model preparation](../../../windows-desktop/src/main/prepare/store-model.ts)
- [Personal processing UI](../../../windows-desktop/src/renderer/personal-view.tsx),
  [account UI](../../../windows-desktop/src/renderer/account-view.tsx),
  [Library UI](../../../windows-desktop/src/renderer/library-view.tsx),
  [Worker controls](../../../windows-desktop/src/renderer/worker-view.tsx)
