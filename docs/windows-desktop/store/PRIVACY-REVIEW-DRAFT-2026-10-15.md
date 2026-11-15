# Windows privacy review draft — 15 October 2026

**Publication pending.** This document supplies reviewable English and Arabic
Windows coverage for both Store products. It is not a published policy, a Store
approval, a consent record, or evidence that either Store app has been installed.
No public page, app, account, feature, model, processing recipe or permission is
changed by this draft. The owner will submit the separate Microsoft support
request later.

| Product          | Store product ID | Package identity                |
| ---------------- | ---------------- | ------------------------------- |
| MusicMute        | `9P7VX8JK8B68`   | `27120VCHATSDK.MusicMute`       |
| MusicMute Worker | `9P4GXB0NRJDG`   | `27120VCHATSDK.MusicMuteWorker` |

Both target Windows 10 22H2/build 19045 or Windows 11, native x64. Their shared
Chrome extension is a separate browser component, not another Windows package.

## Existing policy and proposed integration

Read-only HTTPS requests on 15 October 2026 returned HTTP 200 for
[`/privacy`](https://api.music-mute.com/privacy) and
[`/public-policy`](https://api.music-mute.com/public-policy). The metadata reports
policy version `2026-10-08`, developer/operator name `MusicMute`, support email
`hatemragapdev@gmail.com`, a 15-day account recovery period and a 24-hour security
replay fence. The current privacy HTML does not mention Windows or DPAPI. Those
are observed publication facts, not a deployment of this draft. Operator
configuration can override repository defaults; retain the verified live values
unless the owner explicitly changes them.

Use the following integration when publication is separately authorized:

1. Extend the existing policy's scope sentence to include “MusicMute for Windows
   and MusicMute Worker for Windows.” Keep Android, iOS, web, Mac and Chrome
   coverage. Extend its summary and service-provider/diagnostic wording to match.
2. Insert the complete English section below into the same policy. Publish its
   Arabic equivalent through a real, accessible Arabic policy route or language
   switch; this Markdown file is not such a route. Both Store products must link
   to the published policy covering their own behavior.
3. Scope the existing “when a client prepares a selected local video … it uploads
   prepared audio” sentence to cloud submission. A local Windows import does not
   necessarily upload at all. Scope existing Mac-only Keychain, external runtime
   download, loopback and extension-companion statements to Mac; Windows uses the
   behavior below. Do not replace the Mac runtime description with the Windows
   Store description.
4. In the existing Sentry paragraphs, include Windows personal/Chrome diagnostics
   among the reports that remain local unless exported and shared. Keep separate
   backend/fleet request, processing, security and operational reporting.
5. Retain the existing account-deletion and permanent shared-media sections. Do
   not promise that deleting an account or clearing a local cache removes shared
   originals/results or revokes an independently enrolled Worker.
6. Change the actual policy version/last-updated date only at authorized
   publication. Read back the policy and `/public-policy`, both Store privacy
   fields and the installed in-app destinations before certification. A draft
   URL or a future date does not establish public coverage.

The reference requirements are Microsoft's
[MSIX privacy/support fields](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/support-info)
and [Store policies, section 10.5](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies#105-personal-information):
describe information, purposes, security, recipients and user controls, and keep
the policy current. The policy page currently displays version 7.20 with an
effective date of **22 October 2026**; that future effective date must not be
described as already effective on this review date. Recheck the applicable
version on the actual certification date.

Microsoft's MSIX support guidance also permits entering policy text directly
instead of supplying a hosted-policy URL. If the actual Partner Center draft
offers that control, the English and Arabic customer sections below can be used
for the two Windows products' draft privacy text, subject to the real field
limits and the review gates below. Saving draft text does not deploy the public
policy, submit certification or publish a product. Include both languages when
one text field is shared across markets; do not assume market-specific language
selection exists. The draft's internal status/source sections are not customer
policy copy. Direct Store text also does not repair a Windows in-app link that
still opens the older hosted policy.

## English text for policy integration

### Windows applications and information they handle

MusicMute is operated by MusicMute. This section covers MusicMute for Windows,
MusicMute Worker for Windows, and their use of the shared MusicMute Chrome
extension and MusicMute services. MusicMute provides the interface, account,
Library, playback and export features. The separately installed MusicMute Worker
provides the device's processing tools and background session functions.
The standalone Worker window manages Windows startup; full processing controls
and diagnostics are available in MusicMute. Local processing uses the prepared
model on a qualified GPU on your Windows device and
does not silently switch inference to cloud processing.

MusicMute handles media you select, prepared audio, originals and voice-only
results, filenames, media identifiers and source URLs you submit, titles and
available thumbnails, duration, size, hashes, processing and playback history,
preferences, account sessions, local job and pending-save records, and model and
GPU qualification data needed for these features. A selected local video is
prepared as audio for separation; cloud submission sends prepared audio rather
than the original video file.

Signing in also uses your Firebase identity, available profile name and email,
verification and provider information, and authentication/session records. The
Windows app reports its installation identifier, Windows platform and OS version,
app version/build, metadata revision and device model when available to the
account service. MusicMute's services receive network, request and security
metadata for the connections they handle.

### On-device storage and credential protection

MusicMute keeps managed media, results, Library/history, preferences, temporary
work and model data in its per-user Windows storage. MusicMute Worker keeps
separate per-user enrollment, control and work data. These products cooperate
through local native messaging and authenticated local process channels. The
Chrome playback connection is a temporary protected loopback connection on the
same computer.

Sign-in/session credentials, installation guest credentials and separately
enrolled Worker credentials use Windows Data Protection API protection for the
current Windows user, in separate credential namespaces. This protection does
not mean all cached media is encrypted, and it does not isolate credentials from
every hostile process running as the same Windows user. The app does not send
its sign-in credentials or guest capabilities to the Chrome extension.

### Local processing and online connections

Local GPU processing can be used without signing into a MusicMute account after
preparation. Local inference is distinct from network activity: model downloads,
public policy checks, online audio acquisition, shared-catalog lookup/download,
background saving and account features can contact network services. A prepared
model can remain loaded between songs during the Windows login session to avoid
reloading it for every song; this does not change the processing recipe or give
another account access to your media.

For supported YouTube playback, the native processing tools acquire audio as a
logged-out guest of the source platform. They do not import your Chrome profile,
browser cookies or Google sign-in credentials. The source platform and its media
servers receive acquisition requests and ordinary network metadata, and can
return anonymous session data or refuse access. Signing into MusicMute does not
sign these acquisition requests into YouTube. MusicMute does not bypass a
source's login restriction.

### Shared catalog and saving to an account

For eligible YouTube media, MusicMute can send its video identifier and technical
media information to look up an existing original/voice-only pair. It can
download a verified matching result instead of acquiring and processing it again.
This uses an installation-scoped guest credential and can operate while signed
out of the app.

Eligible locally processed, untrimmed YouTube pairs can also contribute original
audio, voice-only audio, media-identifying metadata and hashes to MusicMute's
shared catalog in the background. Declaration metadata can be sent before
playback; media upload waits until the client verifies first voice-only playback.
Pending saving can resume later. This contribution is separate from signing in
or saving to your account. There is no separate per-video opt-in control for
this shared contribution in the current implementation, and signing out does
not disable it. Local file imports are excluded from this shared-catalog
contribution path. Accepted shared originals and results have no automatic
expiry and may be reused by other authorized accounts or scoped guests. Local
cache clearing, job deletion or account/guest deletion does not remove accepted
shared media.

Eligible local completions captured for a signed-in account can be queued to
save original/voice-only audio and job information to that account. A result
created while signed out requires an explicit save-to-account action; signing
in later does not automatically assign it to that account. Saving local-file
audio to an account uses the account-private path rather than the shared
YouTube catalog.

### Account Library and cloud processing

Signing in connects MusicMute to your account and Library. Cloud processing is a
separate selected processing mode and uses your account's current processing
allowance. When you choose and confirm cloud processing in the Windows app, it
sends selected prepared audio or an online source link and associated job
information to MusicMute's service, which acquires audio when needed, processes
it remotely and delivers the result. Current Windows cloud submission requires
MusicMute account sign-in. For Chrome, manually starting a video follows the
processing choice saved in the Windows app; a saved cloud choice does not add a
new per-video confirmation in Chrome. Automatic preparation does not submit new
cloud processing.

Library operations use authorized MusicMute service records and temporary media
transfer grants. Available public YouTube thumbnails may be fetched directly
from the allowed thumbnail host and cached on the device; that host receives
the image request and network metadata. Exporting or opening a result in another
app gives the chosen app or provider the copy you select.

### Shared Chrome extension and its controls

Windows uses the same MusicMute Chrome extension and `com.musicmute.local`
native-messaging identity as the supported Mac route. On supported YouTube watch
pages it uses the video identifier/canonical source URL, duration, playback
position and speed, volume and mute state, and player/advertisement state to
prepare audio and synchronize voice playback. The extension exchanges playback,
processing and account commands with the native app; credentials remain native.
Preferences and bounded browser diagnostics are kept in the current Chrome
profile.

Automatic local preparation is enabled by default for eligible playing videos;
you can turn it off or shorten its duration limit. You can switch between original
and voice-only sound, pause or stop playback, and use the available managed-cache
controls. Stopping playback or clearing a local cache does not undo a background
save that was already released or remove accepted shared media. The extension
does not read general browsing history, browser cookies, typed text or general
keyboard activity, and does not request browser geolocation. Its page access is
limited to supported YouTube pages and its local playback connection.

### Independent Worker, enrollment and startup

MusicMute Worker runs as the logged-in Windows user. It can remain active after
the MusicMute window closes. Its Windows login startup task is initially
disabled and remains subject to the user's Windows startup controls. Windows
sign-out ends the Worker login-session lifetime; this differs from signing out
of the MusicMute account.

Fleet work requires an explicit enrollment action and approval. Enrollment sends
the machine label, installation/hardware/runtime and GPU qualification
information, supported processing capabilities and qualification evidence needed
to register and approve that machine, including CPU model, system memory and the
qualified GPU's technical identity and memory information. An enrolled Worker then receives assigned
processing work, downloads the required audio, processes it locally and sends
results, status and operational information to the MusicMute service using its
own machine credential. Fleet work can concern service jobs other than your
personal Library. Worker pause, stop and enrollment/removal controls are separate
from app-account controls. Closing MusicMute or signing out of its account does
not itself revoke an independently enrolled Worker.

### Preparation, updates and service providers

For the Windows Store versions, executable native, Node, Python and processing
tools are bundled with the installed packages and executable updates use the
Store route. Prepare downloads and verifies the model when needed and creates
qualification/readiness data. It does not install the Mac-style external
executable runtime archive. The existing audio acquisition tools may obtain and
evaluate source challenge code as part of acquiring the selected audio; bundled
runtime code does not imply that all fetched content is non-executable.

Microsoft provides Store distribution and updates and handles that interaction
under its own terms and privacy information. The model's approved GitHub release
and its download infrastructure receive the request metadata needed to deliver
model data. Firebase/Google handles MusicMute authentication. MusicMute uses
MongoDB for account, session, job, usage and Worker records, private Cloudflare R2
for media, and hosting/network providers for service operation and delivery.
Source platforms/media servers receive local acquisition and thumbnail requests;
private acquisition providers receive submitted public links and relevant
request metadata for cloud imports. These acquisition providers are not the
destination for private local-file uploads. The existing policy's provider
section describes these service functions. Support receives information you
choose to send.

Service and media transfers use HTTPS or secure WebSockets as applicable, apart
from protected loopback playback on the same computer. Private storage and
temporary authorized grants restrict media access; no system guarantees absolute
security. MusicMute's existing policy states that personal information is not
sold, transferred to data brokers, used for advertising, or used to determine
creditworthiness or for lending. User-directed exports and support sharing, and
necessary service, security or legally required disclosures, remain as described
in that policy.

### Diagnostics, retention and deletion

Windows personal/Chrome diagnostic reports remain on your device without an
automatic telemetry upload. Exporting diagnostics creates a local report that
you choose whether to share. These reports exclude audio, credentials, browser
cookies and private media URLs. This local-diagnostic behavior does not mean
MusicMute's online services or an enrolled Worker make no operational reports:
the service receives the requests, status, processing and security information
needed to perform those functions.

Your local Library, retained media and queued saving records are not erased
merely by closing the app or signing out. Use the relevant local Library/cache
and account controls; local and cloud copies are managed separately. Deleting a
MusicMute account does not delete a source file you selected, a copy you exported,
the Google account used for sign-in, accepted shared media, or an independent
Worker enrollment. The two Windows packages and Chrome extension have separate
removal controls; removal of one must not be treated as confirmation that all
other components and retained data were removed.

For service-side account deletion, an accepted request blocks account access and
starts the existing exact 15-day recovery period. Permanent active-system cleanup
starts after that deadline and is retried until complete. It removes the account
profile, privately uploaded local input/result audio, processing history and
account-linked device/push records. Shared public-link originals/results remain
in private permanent shared storage; deletion removes that account's records and
access. A pseudonymous security replay fence remains for 24 hours. Restricted
operational logs and backup copies may remain until their normal service
lifecycle expires or preservation is required for security, fraud prevention or
law. There is no additional fixed backup/log expiry promise in this Windows
section. An offline installation can retain private local copies until it
reconnects or its app data is cleared. See the
[account deletion page](https://api.music-mute.com/delete-account) for the
authenticated in-app and external request routes.

For privacy, access, correction, deletion or help with retained data, contact
**hatemragapdev@gmail.com** or the
[support page](https://api.music-mute.com/support). Ownership verification may be
required. Do not send passwords, authentication tokens, browser cookies, private
audio or protected transfer URLs to support.

## النص العربي المقترح لدمجه في سياسة الخصوصية

### تطبيقا Windows والمعلومات التي يتعاملان معها

تُشغّل MusicMute خدمة MusicMute. يشمل هذا القسم تطبيق MusicMute على Windows
وتطبيق MusicMute Worker على Windows، واستخدامهما لإضافة MusicMute المشتركة في
Chrome وخدمات MusicMute. يوفّر MusicMute الواجهة والحساب والمكتبة والتشغيل
والتصدير. ويوفّر MusicMute Worker، الذي يُثبّت بصورة مستقلة، أدوات المعالجة
ووظائف جلسة العمل في الخلفية. تدير نافذة Worker المستقلة بدء التشغيل في Windows،
وتتوفر عناصر التحكم الكاملة في المعالجة والتشخيص داخل MusicMute. تستخدم المعالجة المحلية النموذج المُجهّز على
معالج الرسومات المؤهّل في جهاز Windows، ولا تتحول المعالجة بالنموذج تلقائيًا
إلى السحابة.

يتعامل MusicMute مع الوسائط التي تختارها، والصوت المُجهّز، والصوت الأصلي ونتائج
الصوت المعزول، وأسماء الملفات ومعرّفات الوسائط وروابط المصادر التي ترسلها،
والعناوين والصور المصغرة المتاحة، والمدة والحجم والبصمات الرقمية، وسجل المعالجة
والتشغيل، والتفضيلات وجلسات الحساب، وسجلات المهام والحفظ المعلّق، وبيانات النموذج
وتأهيل معالج الرسومات اللازمة لهذه الوظائف. يُجهّز الفيديو المحلي المختار كصوت
لفصل الموسيقى؛ وعند إرسال مهمة إلى السحابة يُرسل الصوت المُجهّز بدلًا من ملف
الفيديو الأصلي.

يستخدم تسجيل الدخول هوية Firebase واسم الملف الشخصي والبريد الإلكتروني عند
توفرهما، وحالة التحقق ومعلومات مزوّدي تسجيل الدخول، وسجلات المصادقة والجلسات.
يرسل تطبيق Windows إلى خدمة الحساب معرّف التثبيت، ونوع المنصة وإصدار Windows،
وإصدار التطبيق ورقم بنائه ومراجعة بيانات التثبيت وطراز الجهاز عند توفره. وتتلقى
خدمات MusicMute بيانات الشبكة والطلبات والأمان الخاصة بالاتصالات التي تعالجها.

### التخزين على الجهاز وحماية بيانات الاعتماد

يحتفظ MusicMute بالوسائط والنتائج والمكتبة والسجل والتفضيلات والعمل المؤقت
وبيانات النموذج التي يديرها في تخزين Windows الخاص بالمستخدم. ويحتفظ MusicMute
Worker ببيانات تسجيل الجهاز والتحكم والعمل في مساحة منفصلة خاصة بالمستخدم.
يتعاون التطبيقان عبر المراسلة المحلية الأصلية وقنوات اتصال محلية تتحقق من هوية
العمليات. يستخدم تشغيل Chrome اتصال loopback مؤقتًا ومحميًا على الكمبيوتر نفسه.

تُحمى بيانات اعتماد تسجيل الدخول والجلسات، وبيانات اعتماد الضيف الخاصة بالتثبيت،
وبيانات اعتماد العامل المسجّل بصورة مستقلة، باستخدام واجهة حماية البيانات في
Windows ‏(DPAPI) للمستخدم الحالي، وفي نطاقات بيانات اعتماد منفصلة. ولا يعني ذلك
تشفير جميع الوسائط المخزنة مؤقتًا، ولا العزل عن كل عملية ضارة تعمل بحساب Windows
نفسه. ولا يرسل التطبيق بيانات اعتماد تسجيل الدخول أو صلاحيات الضيف إلى إضافة
Chrome.

### المعالجة المحلية والاتصالات عبر الإنترنت

بعد التجهيز، يمكن استخدام معالجة GPU المحلية دون تسجيل الدخول إلى حساب
MusicMute. تختلف المعالجة المحلية عن نشاط الشبكة: فقد تتصل تنزيلات النموذج
وفحوص السياسة العامة وجلب الصوت عبر الإنترنت والبحث والتنزيل من الفهرس المشترك
والحفظ في الخلفية وميزات الحساب بخدمات الشبكة. ويمكن أن يبقى النموذج المُجهّز
محمّلًا بين الأغاني أثناء جلسة دخول Windows لتجنب إعادة تحميله لكل أغنية؛ ولا
يغيّر ذلك وصفة المعالجة ولا يمنح حسابًا آخر حق الوصول إلى وسائطك.

للتشغيل المدعوم على YouTube، تجلب الأدوات الأصلية الصوت بصفة ضيف غير مسجّل
الدخول إلى منصة المصدر. ولا تستورد ملف Chrome الشخصي أو ملفات تعريف ارتباط
المتصفح أو بيانات تسجيل دخول Google. تتلقى منصة المصدر وخوادم الوسائط طلبات
الجلب وبيانات الشبكة المعتادة، وقد تعيد بيانات جلسة مجهولة أو ترفض الوصول. ولا
يؤدي تسجيل الدخول إلى MusicMute إلى تسجيل هذه الطلبات في YouTube. ولا يتجاوز
MusicMute شرط تسجيل الدخول الذي يفرضه المصدر.

### الفهرس المشترك والحفظ في الحساب

للوسائط المؤهلة على YouTube، يمكن أن يرسل MusicMute معرّف الفيديو ومعلومات تقنية
عن الوسائط للبحث عن زوج قائم من الصوت الأصلي والصوت المعزول. ويمكن تنزيل نتيجة
مطابقة تم التحقق منها بدلًا من جلب الصوت ومعالجته مرة أخرى. تستخدم هذه العملية
بيانات اعتماد ضيف مرتبطة بالتثبيت، ويمكن أن تعمل أثناء تسجيل الخروج من التطبيق.

يمكن أيضًا أن تساهم أزواج YouTube المؤهلة، التي عولجت محليًا دون قص الصمت، بالصوت
الأصلي والصوت المعزول وبيانات تعريف الوسائط وبصماتها الرقمية في فهرس MusicMute
المشترك في الخلفية. وقد تُرسل بيانات الإعلان عن المساهمة قبل التشغيل؛ أما رفع
الصوت فينتظر تحقق العميل من أول تشغيل للصوت المعزول. ويمكن استئناف الحفظ
المعلّق لاحقًا. تختلف المساهمة عن تسجيل الدخول أو الحفظ في الحساب. لا يوجد في
التنفيذ الحالي خيار موافقة منفصل لكل فيديو على هذه المساهمة، ولا يعطّلها تسجيل
الخروج. تُستثنى الملفات المحلية المستوردة من مسار المساهمة في الفهرس المشترك.
ولا يوجد انتهاء تلقائي للنسخ الأصلية والنتائج المشتركة المقبولة، ويمكن أن تعيد
استخدامها حسابات مخوّلة أو جلسات ضيف ذات صلاحيات محددة. ولا تؤدي إزالة التخزين
المؤقت المحلي أو حذف مهمة أو حساب أو جلسة ضيف إلى حذف الوسائط المشتركة المقبولة.

يمكن وضع النتائج المحلية المؤهلة، التي التُقطت لحساب مسجّل الدخول، في قائمة
انتظار لحفظ الصوت الأصلي والمعزول ومعلومات المهمة في ذلك الحساب. تتطلب النتيجة
التي أُنشئت أثناء تسجيل الخروج إجراءً صريحًا لحفظها في الحساب؛ ولا تنسبها عملية
تسجيل الدخول اللاحقة إليه تلقائيًا. يستخدم حفظ صوت الملفات المحلية في الحساب
المسار الخاص بالحساب، وليس فهرس YouTube المشترك.

### مكتبة الحساب والمعالجة السحابية

يربط تسجيل الدخول MusicMute بحسابك ومكتبتك. المعالجة السحابية وضع معالجة مستقل
تختاره، ويستخدم حصة المعالجة الحالية لحسابك. عند اختيار المعالجة السحابية
وتأكيدها في تطبيق Windows، يرسل التطبيق الصوت المُجهّز المختار أو رابط المصدر
ومعلومات المهمة المرتبطة إلى خدمة MusicMute. تجلب الخدمة الصوت عند الحاجة
وتعالجه عن بُعد وتُسلّم النتيجة. يتطلب إرسال مهمة سحابية من Windows حاليًا تسجيل
الدخول إلى حساب MusicMute. في Chrome، يتبع البدء اليدوي لفيديو موقع المعالجة
المحفوظ في تطبيق Windows؛ ولا يضيف اختيار السحابة المحفوظ تأكيدًا جديدًا لكل
فيديو في Chrome. ولا يُرسل التجهيز التلقائي مهام معالجة سحابية جديدة.

تستخدم عمليات المكتبة سجلات خدمة MusicMute المصرّح بالوصول إليها وتصاريح مؤقتة
لنقل الوسائط. وقد تُجلب صور YouTube المصغرة العامة من مضيف الصور المسموح به
مباشرة وتُخزّن على الجهاز؛ ويتلقى ذلك المضيف طلب الصورة وبيانات الشبكة. يمنح
تصدير النتيجة أو فتحها في تطبيق آخر التطبيق أو المزوّد المختار النسخة التي
تحددها.

### إضافة Chrome المشتركة وعناصر التحكم

يستخدم Windows إضافة MusicMute نفسها في Chrome وهوية المراسلة الأصلية
`com.musicmute.local` المستخدمة في مسار Mac المدعوم. على صفحات مشاهدة YouTube
المدعومة، تستخدم الإضافة معرّف الفيديو ورابط المصدر المعتمد، والمدة وموضع
التشغيل وسرعته ومستوى الصوت والكتم وحالة المشغّل والإعلانات، لتجهيز الصوت
ومزامنة تشغيل الصوت المعزول. تتبادل الإضافة أوامر التشغيل والمعالجة والحساب مع
التطبيق الأصلي، وتبقى بيانات الاعتماد داخله. وتُحفظ التفضيلات والتشخيصات المحدودة
في ملف Chrome الشخصي الحالي.

يكون التجهيز المحلي التلقائي مفعّلًا افتراضيًا للفيديوهات المؤهلة قيد التشغيل؛
ويمكنك تعطيله أو تقليل الحد الأقصى للمدة. ويمكنك التبديل بين الصوت الأصلي
والمعزول، وإيقاف التشغيل مؤقتًا أو إيقافه، واستخدام عناصر التحكم المتاحة في
التخزين المؤقت المُدار. لا يؤدي إيقاف التشغيل أو مسح التخزين المؤقت المحلي إلى
التراجع عن حفظ في الخلفية أُطلق بالفعل أو حذف وسائط مشتركة مقبولة. ولا تقرأ
الإضافة سجل التصفح العام أو ملفات تعريف ارتباط المتصفح أو النصوص المكتوبة أو
نشاط لوحة المفاتيح العام، ولا تطلب تحديد الموقع من المتصفح. يقتصر وصولها إلى
الصفحات على صفحات YouTube المدعومة واتصال التشغيل المحلي.

### العامل المستقل والتسجيل وبدء التشغيل

يعمل MusicMute Worker بحساب مستخدم Windows المسجّل الدخول، ويمكن أن يستمر بعد
إغلاق نافذة MusicMute. تكون مهمة بدء تشغيله عند دخول Windows معطّلة في البداية،
وتبقى خاضعة لعناصر التحكم في بدء التشغيل في Windows. ينهي تسجيل الخروج من
Windows مدة تشغيل العامل المرتبطة بجلسة الدخول؛ ويختلف ذلك عن تسجيل الخروج من
حساب MusicMute.

يتطلب العمل ضمن أسطول المعالجة إجراء تسجيل صريحًا وموافقة. يرسل التسجيل اسم
الجهاز ومعلومات التثبيت والأجهزة وبيئة التشغيل وتأهيل GPU وقدرات المعالجة
المدعومة وأدلة التأهيل اللازمة لتسجيل الجهاز واعتماده، بما في ذلك طراز المعالج
وذاكرة النظام والهوية التقنية لمعالج الرسومات المؤهّل ومعلومات ذاكرته. يتلقى العامل المسجّل
مهام المعالجة المخصّصة له، وينزّل الصوت المطلوب ويعالجه محليًا، ويرسل النتائج
والحالة ومعلومات التشغيل إلى خدمة MusicMute باستخدام بيانات اعتماد الجهاز
الخاصة به. ويمكن أن تخص مهام الأسطول مهام الخدمة خارج مكتبتك الشخصية. عناصر
إيقاف العامل مؤقتًا أو إيقافه والتحكم في تسجيله وإزالته مستقلة عن عناصر تحكم حساب
التطبيق. ولا يؤدي إغلاق MusicMute أو تسجيل الخروج من حسابه وحده إلى إلغاء تسجيل
عامل مسجّل بصورة مستقلة.

### التجهيز والتحديثات ومزوّدو الخدمة

في إصدارات Windows الموزّعة عبر المتجر، تكون الأدوات الأصلية وأدوات Node وPython
والمعالجة القابلة للتنفيذ مضمّنة في الحزم المثبّتة، وتُحدّث عبر المتجر. تنزّل
عملية التجهيز النموذج وتتحقق منه عند الحاجة، وتُنشئ بيانات التأهيل والجاهزية.
ولا تُثبّت أرشيف بيئة تنفيذ خارجية كالذي يستخدمه Mac. ويمكن لأدوات جلب الصوت
الحالية الحصول على كود تحدٍّ من المصدر وتقييمه كجزء من جلب الصوت المختار؛ لذلك
لا يعني تضمين أدوات التنفيذ أن كل محتوى يتم جلبه غير قابل للتنفيذ.

توفّر Microsoft التوزيع والتحديثات عبر المتجر وتتعامل مع تلك العملية وفق شروطها
ومعلومات الخصوصية الخاصة بها. ويتلقى إصدار النموذج المعتمد على GitHub وبنيته
الخاصة بالتنزيل بيانات الطلب اللازمة لتسليم النموذج. تتولى Firebase/Google
مصادقة MusicMute. وتستخدم MusicMute قاعدة MongoDB لسجلات الحساب والجلسات والمهام
والاستخدام والعامل، وتخزين Cloudflare R2 الخاص للوسائط، ومزوّدي الاستضافة والشبكة
لتشغيل الخدمة وتسليمها. وتتلقى منصات المصدر وخوادم الوسائط طلبات الجلب المحلي
والصور المصغرة؛ ويتلقى مزوّدو جلب الصوت الخاصون الروابط العامة المرسلة وبيانات
الطلب ذات الصلة بالاستيراد السحابي. وليس هؤلاء المزوّدون وجهة لرفع الملفات
المحلية الخاصة. يوضّح قسم مزوّدي الخدمة في السياسة الحالية هذه الوظائف. ويتلقى
الدعم المعلومات التي تختار إرسالها.

تستخدم اتصالات الخدمة ونقل الوسائط HTTPS أو WebSockets الآمن حسب الوظيفة، باستثناء
اتصال loopback المحمي على الكمبيوتر نفسه. يقيّد التخزين الخاص والتصاريح المؤقتة
المصرّح بها الوصول إلى الوسائط، ولا يضمن أي نظام أمانًا مطلقًا. تنص سياسة
MusicMute الحالية على أن المعلومات الشخصية لا تُباع ولا تُنقل إلى وسطاء البيانات
ولا تُستخدم للإعلانات أو لتحديد الجدارة الائتمانية أو الإقراض. ويظل التصدير
بقرار المستخدم ومشاركة المعلومات مع الدعم والإفصاح اللازم للخدمة أو الأمان أو
القانون على النحو الموضّح في تلك السياسة.

### التشخيص والاحتفاظ والحذف

تبقى تقارير التشخيص الشخصية لتطبيق Windows وChrome على جهازك دون رفع تلقائي
لبيانات القياس. يُنشئ تصدير التشخيص تقريرًا محليًا تختار أنت مشاركته. تستبعد هذه
التقارير الصوت وبيانات الاعتماد وملفات تعريف ارتباط المتصفح وروابط الوسائط
الخاصة. ولا يعني ذلك أن خدمات MusicMute على الإنترنت أو العامل المسجّل لا ترسل
تقارير تشغيل؛ إذ تتلقى الخدمة الطلبات والحالة ومعلومات المعالجة والأمان اللازمة
لتنفيذ هذه الوظائف.

لا تُحذف المكتبة المحلية والوسائط المحتفظ بها وسجلات الحفظ المعلّق بمجرد إغلاق
التطبيق أو تسجيل الخروج. استخدم عناصر التحكم المناسبة في المكتبة المحلية
والتخزين المؤقت والحساب؛ فالنسخ المحلية والسحابية تُدار بصورة مستقلة. ولا يؤدي
حذف حساب MusicMute إلى حذف ملف المصدر الذي اخترته أو نسخة صدّرتها أو حساب
Google المستخدم لتسجيل الدخول أو الوسائط المشتركة المقبولة أو تسجيل عامل
مستقل. توجد عناصر إزالة منفصلة لحزمتي Windows وإضافة Chrome؛ ولا ينبغي اعتبار
إزالة مكوّن واحد تأكيدًا لإزالة جميع المكوّنات الأخرى والبيانات المحتفظ بها.

في حذف الحساب من الخدمة، يمنع قبول الطلب الوصول إلى الحساب ويبدأ فترة الاسترداد
الحالية المحددة بدقة بـ15 يومًا. تبدأ الإزالة الدائمة من الأنظمة النشطة بعد
الموعد النهائي، وتُعاد محاولتها حتى تكتمل. وتشمل ملف الحساب والصوت المحلي
المرفوع بصورة خاصة ونتائجه وسجل المعالجة وسجلات الأجهزة والإشعارات المرتبطة
بالحساب. تبقى النسخ الأصلية والنتائج الخاصة بالروابط العامة في تخزين مشترك خاص
ودائم؛ ويحذف الطلب سجلات الحساب وصلاحيات وصوله إليها. وتبقى آلية أمان مستعارة
الهوية لمنع إعادة الاستخدام لمدة 24 ساعة. وقد تبقى سجلات التشغيل المقيّدة والنسخ
الاحتياطية حتى انتهاء دورة حياتها المعتادة أو عند ضرورة الاحتفاظ بها للأمان أو
منع الاحتيال أو القانون. ولا يعد هذا القسم بفترة انتهاء ثابتة إضافية للسجلات أو
النسخ الاحتياطية. وقد يحتفظ تثبيت غير متصل بنسخ محلية خاصة إلى أن يعاود الاتصال
أو تُمسح بيانات التطبيق. راجع
[صفحة حذف الحساب](https://api.music-mute.com/delete-account) لمعرفة مسار الطلب
داخل التطبيق مع التحقق من الهوية ومسار الطلب الخارجي.

لاستفسارات الخصوصية أو الوصول أو التصحيح أو الحذف أو المساعدة بشأن البيانات
المحتفظ بها، تواصل عبر **hatemragapdev@gmail.com** أو
[صفحة الدعم](https://api.music-mute.com/support). وقد يلزم التحقق من الملكية. لا
ترسل كلمات المرور أو رموز المصادقة أو ملفات تعريف ارتباط المتصفح أو الصوت الخاص
أو روابط النقل المحمية إلى الدعم.

## Source map and review boundaries

These links identify the implementation reviewed for this draft. They do not
prove Microsoft approval, deployment, all provider practices or installed OS
behavior.

| Draft subject                                               | Source reviewed                                                                                                                                                                                                                                                                                              | Boundary                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing operator/contact and 15-day/24-hour lifecycle      | [Public defaults](../../../backend/src/config/public-policy.ts), [public pages](../../../backend/src/public-pages/public-pages.controller.ts); live metadata readback above                                                                                                                                  | Existing service-policy facts; no new retention promises                                                                                       |
| Windows account/device reports and deletion/session fencing | [Account controller](../../../windows-desktop/src/main/account/account-controller.ts), [browser account bridge](../../../windows-desktop/src/main/browser/account-bridge.ts)                                                                                                                                 | Actual installed sign-in, account cleanup and browser integration pending                                                                      |
| DPAPI, separate namespaces and private local roots          | [Native boundary](../../../worker/native/windows-consumer/README.md), [host context](../../../windows-desktop/src/main/host-context.ts), [guest credentials](../../../windows-desktop/src/main/reuse/guest-credentials.ts), [fleet store](../../../windows-desktop/src/main/fleet/store.ts)                  | DPAPI does not mean every media file is encrypted; same-user hostile processes remain a limit                                                  |
| Personal processing, publication and retained model         | [Personal reuse](../../../windows-desktop/src/main/personal/reuse.ts), [publication](../../../windows-desktop/src/main/reuse/publication.ts), [personal runtime](../../../windows-desktop/src/main/personal/store-runtime.ts), [session supervisor](../../../windows-desktop/src/main/session/supervisor.ts) | Eight production-core GPU calls passed separately; installed lifetime and logout remain acceptance gates                                       |
| Captured-account and explicit guest saving                  | [Completion producer](../../../windows-desktop/src/main/outbox/completion-producer.ts), [local saving](../../../windows-desktop/src/main/outbox/local-save.ts)                                                                                                                                               | Account saving and permanent shared-catalog contribution are separate                                                                          |
| Cloud selection/submission                                  | [Cloud API](../../../windows-desktop/src/main/cloud/api.ts), [browser gateway](../../../windows-desktop/src/main/browser/service.ts)                                                                                                                                                                         | Do not claim a per-video Chrome cloud confirmation that is absent                                                                              |
| Thumbnail requests                                          | [Thumbnail cache](../../../windows-desktop/src/main/library/thumbnails.ts), [shared URL validation](../../../chrome-extension/src/shared/thumbnail-url.ts)                                                                                                                                                   | Direct allowed-host request is separate from media storage and acquisition                                                                     |
| Browser permissions and guest acquisition                   | [Shared manifest](../../../chrome-extension/src/extension/static/manifest.json), [downloader isolation](../../../chrome-extension/docs/downloader-privacy.md), [browser source](../../../windows-desktop/src/main/browser/)                                                                                  | Current manifest has `nativeMessaging`, `offscreen`, `storage`, supported YouTube hosts and loopback; no cookie/history/geolocation permission |
| Independent Worker and reporting                            | [Fleet controller](../../../windows-desktop/src/main/fleet/controller.ts), [fleet agent](../../../windows-desktop/src/agent/fleet.ts), [report builder](../../../worker/src/enrollment/report-builder.ts), [Store startup](../../../worker/native/windows-consumer/store_startup.hpp)                        | App-account logout and Windows logoff are distinct; startup/removal behavior needs signed-installed proof                                      |
| Store runtime and Prepare                                   | [Store packaging](../../../windows-desktop/packaging/store/README.md), [Store model preparation](../../../windows-desktop/src/main/prepare/store-model.ts), [model pin/URL](../../../chrome-extension/src/shared/local-model.ts)                                                                             | Store-signed execution, capability approvals and actual fresh Prepare remain pending                                                           |
| Local diagnostics                                           | [Diagnostic factory](../../../windows-desktop/src/main/diagnostics/factory.ts), [browser report validation](../../../windows-desktop/src/main/diagnostics/browser-report.ts)                                                                                                                                 | Local personal diagnostics do not suppress fleet/backend operational reporting                                                                 |

## Specific completion record

The catalog timing/consent distinction is concrete: the completion path in
[`personal/reuse.ts`](../../../windows-desktop/src/main/personal/reuse.ts)
allows declaration before playback. The separate
[`WindowsBrowserPublication.playbackStarted`](../../../windows-desktop/src/main/browser-publication.ts)
and [`publishDesktopPlayback`](../../../windows-desktop/src/main/desktop-publication.ts)
paths verify a voice artifact/owner before releasing media publication. Their
playback acknowledgments establish the implementation's upload timing; they are
not an express privacy opt-in/withdrawal user interface. The reviewed renderer
does not expose a separate per-video catalog-contribution permission. The
existing live policy expressly describes absence of that per-video opt-in and
continued signed-out saving. Do not rewrite those facts as optional
account-only saving or claim consent was collected.

- [x] Reviewed the existing public-page source and read back current live operator,
      contact, policy version and deletion timing without changing the service.
- [x] Prepared matching English/Arabic Windows text covering both apps, credentials,
      local/cloud/shared processing, network recipients, diagnostics and controls.
- [x] Distinguished Store-bundled executable tools from downloaded model data and
      disclosed the separate acquisition challenge-code behavior.
- [x] Preserved shared Chrome, GPU processing/quality and independent Worker
      behavior; this document makes no feature changes.
- [x] Saved the supported direct-text policy alternative in both private Store
      drafts and rechecked persisted contents after reopening. The combined
      customer text is 25,827 UTF-16 characters / 35,082 UTF-8 bytes, SHA-256
      `2491c578a7c279249d76f643425d341768f16e221c777da48dc99998b3730bd1`.
      Both draft support fields use the verified service support URL. This
      private draft save does not update the in-app hosted policy or close the
      owner practice/consent and installed/publication gates below.
- [ ] Reconcile the source-backed text with signed-installed account/Chrome,
      namespace, lifecycle, uninstall, update and local-data-deletion evidence.
- [ ] Review permanent catalog contribution, absence of a separate per-video
      opt-in and withdrawal control, and applicability of Store privacy/consent
      requirements. A disclosure paragraph is not consent or approval. No compliance
      declaration is supplied by this document.
- [ ] Owner approves the service-practice statements, provider coverage and final
      policy wording before authorized public-page publication. Existing policy
      operator/contact facts are reused; no company address, legal entity, region,
      new retention period or rights grant is invented.
- [ ] Publish the approved integration and Arabic access route only after separate
      authorization, verify both live policy/metadata and both Store privacy fields,
      and verify discoverable in-app privacy links. Do not mark complete from a draft.

Free Store signing remains the selected route. This draft does not submit
certification, publish either app, purchase signing, or submit the owner's
deferred Microsoft support request.
