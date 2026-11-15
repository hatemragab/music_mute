# Store submission review inputs

Checked against primary Microsoft guidance on 2026-10-12. This is a preparation
record; no capability request, submission, policy acceptance or publication was
performed.

## Applicable versions

[Policies 7.19](https://learn.microsoft.com/en-us/windows/apps/publish/store-policy-archive/store-policy-7-19)
became effective on 2025-10-14. The published
[7.20 replacement](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)
is dated 2026-09-15 and becomes effective on 2026-10-22. Review again before a
later authorized submission; the published replacement is not already effective
on this evidence date.

## Declarations and disclosures to prepare

The following are engineering conclusions from reviewing sections 10.1–10.6 and
11.2 of both versions, not a promise of Microsoft approval:

- Describe the separate Worker dependency and acquire it through its Store
  entry with user consent. Disclose GPU requirements, independent logged-in
  operation and background network/resource use.
- Preserve explicit fleet enrollment/approval, saved pause/stop and resource
  limits. This is audio processing, with no cryptocurrency mining function.
- Keep user-selected local files and the existing rights-confirmation journeys.
  Bundled acquisition tools and users' assertions do not establish permission
  from a third-party service or rights holder.
- Explain the provider's existing fetched challenge interpreter evaluation in
  certification notes. Executable package closure does not by itself resolve
  review of dynamically evaluated challenge code. Keep its existing implementation
  and pin while reviewing; no quality or acquisition fallback was introduced.
- Prepare accurate EN/AR metadata, privacy/data disclosures, functional demo
  account access and a working server for testing account/fleet journeys.

## Capability status

Both primary packages declare `runFullTrust`. The explicitly separate
`unvirtualized-candidate-v1` profile additionally requests
`unvirtualizedResources`, selects `win32App`/`mediumIL`, and disables filesystem
and registry write virtualization. It is a candidate, not an approved alternate.
The default profile is `packagedClassicApp`/`mediumIL`. Namespace proof is S03;
capability approval remains open for both products. The Worker StartupTask is
initially disabled and must respect Windows user and policy settings.

Microsoft requires restricted capability information during submission and
subjects it to review. No source manifest can manufacture that approval.
[Capability guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations)

## Actual runtime redistribution gaps

The bounded Z440 census found the existing pinned `diffq_fixed` 0.2.4 metadata
and license labeled CC BY-NC 4.0. The retained macOS model authorization record
does not contain a component-specific `diffq_fixed` commercial redistribution
grant. Preserve the processing dependencies and obtain/reconcile that evidence
before a distributable commercial package. The license grants are limited to
noncommercial uses; this is an identified input gap, not a conclusion that a
specific future release has already infringed.
[CC BY-NC terms](https://creativecommons.org/licenses/by-nc/4.0/legalcode.en)

The same census did not establish final notice closure for Cython, flatbuffers
and samplerate, or the FFmpeg/LAME source/relink obligations. Existing LGPL notice
files alone do not close the latter obligations. Record exact source/build and
redistribution materials against the final binaries.
[FFmpeg distribution guidance](https://www.ffmpeg.org/legal.html)

These gaps do not authorize removing a processing dependency, changing the model
or lowering quality. Private development tests and final distribution approval
remain separate. Do not upload private grants, passwords or signing material to
the repository.
