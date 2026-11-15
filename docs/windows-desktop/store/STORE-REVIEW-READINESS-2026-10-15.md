# Store review readiness — 15 October 2026

Both upload candidates are built and audited. Release materials are prepared for
the two private Store drafts; this is not a certification submission or an
installable Store release. Microsoft permissions, genuine screenshots, reviewer
access and final distribution/privacy review still prevent a truthful “ready to
submit” declaration. The owner will submit the prepared support request later.

## Current candidates

| Product                         | Version   |       Bytes | SHA-256                                                            |
| ------------------------------- | --------- | ----------: | ------------------------------------------------------------------ |
| MusicMute `9P7VX8JK8B68`        | `0.1.0.0` | 167,074,916 | `99ffc7819c3478f2fa2c7966fa66189cf467c22c2f74f6d17f35111b8f7c40f5` |
| MusicMute Worker `9P4GXB0NRJDG` | `0.1.3.0` | 424,942,319 | `aa5d7c08b7edaed2f541d91635f2c845709f167418e499819c3ad92ad93f84a5` |

Verified copies are on the Z440 in
`C:\Users\hatem\Desktop\MusicMute-MSIX-Current-2026-10-15-ab42e4db`.
The earlier same-named GUI file in the parent Mac Downloads folder is the
historical rejected upload, with a different hash; do not substitute it.

The selected route remains free Store signing, two independent apps, native x64,
Windows 10 22H2/build 19045 and Windows 11. Model, recipes, GPU quality, retained
model behavior and the single shared Chrome extension are unchanged. Eight
actual production-core GPU calls passed exact output parity on the Windows 11
Z440; this does not establish signed-installed or physical Windows 10 acceptance.

## Separate pre-review device testing

The owner subsequently authorized free local test signing on the Z440. Separate
**MusicMute Development** and **MusicMute Worker Development** packages are now
signed and installed with healthy Developer (`1`) registration. Their first
startup checks exposed a package-root containment failure. Corrected revision-one
packages are built, fully audited and locally signed; their native rerun passed
31 tests with one startup fixture skipped. After reconnection, both revision-one
updates installed with healthy Developer (`1`) registration. Supplementary
owned-window checks then exposed real GUI package and Worker child-process
startup denials. Revision-two local test packages corrected packaged-child
launching, passed full SDK/archive/signature checks and installed in place.
Both real main windows initially opened in standard Session 1 with exact
healthy Developer registration. A later check found GUI cleanup pending after
account-helper loss and a Worker startup request failure. Revision-three
diagnostic packages are now also signed and installed, with healthy exact
Developer registration and both real windows observed. They identify the
original Worker denial as `STORE_FILE_DENIED`; sustained operation and fresh
GPU preparation remain unproved. The subsequent browser ticket cleanup source
fix has 103 passing focused tests and is included in revision four alongside
the Worker DPI and fixed StartupTask query changes. Both revision-four packages
are now fully built, audited, locally signed, verified and installed with healthy
exact Developer registration. The direct installed EXE opened Home, and the
Worker's DPI fix made all buttons visible. Later device checks still found a
GUI account-owner failure and a Worker startup API error. A successful fresh
preparation and installed GPU job remain unproved.
Revision-five native fixes now address a reproduced named-pipe EOF rejection
and a CNG backing-buffer lifetime defect. Actual Windows regression checks
passed; the recurring first-run file-verification failure remains open despite
one unchanged full rerun passing 33 tests with one startup skip. Updated local
packages are built, fully audited, locally signed and verified, including both
complete signed-to-unsigned member comparisons. Their in-place installation is
in progress. They do not replace the production candidates above.
See the
[local test record](../../../windows-desktop/docs/local-development-msix.md).
The Store upload candidates above remain unsigned and unchanged, and this local
route does not satisfy Store authority, approval or certification gates.

## Prepared material

- [x] Save and reopen all four localized Store listings; their description,
      short description and seven features match the prepared copy exactly.
- [x] Save the same 25,827-character EN/AR Windows privacy text directly in both
      private Store drafts. Reopened values match SHA-256
      `2491c578a7c279249d76f643425d341768f16e221c777da48dc99998b3730bd1`.
      This draft-field update does not publish or update the hosted policy.
- [x] Save and reload both reviewer descriptions (3,771 GUI / 3,793 Worker
      characters) in Additional Testing Information. Separate Credentials fields
      remain empty; no owner password or account session was copied there.
- [x] Save the verified `https://api.music-mute.com/support` contact destination
      in both drafts. No unverified public-download website was added.
- [x] Recheck both products' private audience, the existing named tester group,
      USD zero base price, disabled public-release date and manual publishing hold.

The [exact portal readback](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Store-Review-Materials-2026-10-15/PORTAL-DRAFT-READBACK.json)
and six captured Partner Center views retain this evidence. Both final overviews
still show **In draft**, Properties/Pricing/Age ratings complete and Packages/
Store listings incomplete. The listing blocker is genuine screenshots; the GUI
package retains the historical headless-waiver validation error. Neither production candidate
was submitted for certification, signed, installed or published during that
earlier Store-draft preparation pass. The later local test route is recorded above.

| Material                                                                               | Location                                                  | Scope                                                                                                             |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| English/Arabic description, short description and seven features per listing           | [Listing copy](LISTING-DRAFTS-2026-10-15.md)              | Corrects standalone Worker startup controls versus full management inside MusicMute                               |
| Windows privacy copy for both products                                                 | [Privacy draft](PRIVACY-REVIEW-DRAFT-2026-10-15.md)       | EN/AR customer text, general-policy link, DPAPI, local/cloud/catalog behavior, independent Worker and diagnostics |
| Reviewer steps, secure-access checklist, hardware declarations and screenshot captions | [Reviewer guide](REVIEWER-GUIDE-2026-10-15.md)            | Concrete routes and ownership; missing credentials and screenshots remain explicit                                |
| Capability explanations and owner support request                                      | [Submission packet](SUBMISSION-PACKET-2026-10-15.md)      | No support case, approval or certification request is asserted                                                    |
| Third-party component/notices and exact source/relink material                         | [Third-party review](THIRD-PARTY-MATERIALS-2026-10-15.md) | Actual 62-distribution metadata and additional native/acquisition source evidence; no blanket rights clearance    |
| Actual SDK, GPU and media proofs                                                       | [Implementation record](IMPLEMENTATION-2026-10-12.md)     | Distinguishes source, physical-core, installed, provider and release evidence                                     |

The [external review folder](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Store-Review-Materials-2026-10-15)
contains plain-text policy/notes, four listing-field records, exact sealed
inventories, raw metadata, component declarations, source-input receipts and the
final export index. It excludes passwords, user benchmark media and private
model-authorization correspondence. Files there are private preparation
materials, not a recipient source-delivery endpoint or a public download.

`CURRENT-SOURCE-MATERIALS.json` identifies draft10 as the current media technical
proof. Historical draft09 `STATUS.json` remains unchanged; its old Windows-false
flag must not be read as the current result. Draft10 records actual Windows
success while original FFmpeg/LAME build correspondence, recipient source
delivery and the full portable-wrapper replay remain open.

## Actual remaining gates

- [ ] Owner submits the prepared support request and obtains the GUI
      `HeadlessAppBypass` waiver. The equivalent Worker request is prepared but
      has no observed upload-validation result. Neither product has a waiver or
      case number recorded. Preserve hidden Chrome/session entries and features.
- [ ] Obtain the restricted-capability approval for the actual shared-data/HKCU
      `unvirtualizedResources` profile. Prepared explanations are not approval.
- [ ] Reconcile original FFmpeg/LAME correspondence, applicable native/source
      obligations, recipient delivery and complete retained dependency/model
      terms before making Store distribution-rights declarations.
- [ ] Review permanent catalog contribution and consent/withdrawal behavior.
      The current source has no separate per-video catalog opt-in; verified voice
      playback controls upload timing, not privacy consent. Disclosure does not
      establish consent or Microsoft acceptance.
- [ ] Supply and test dedicated MusicMute and optional Google/fleet reviewer
      access in Microsoft's separate Credentials controls. The saved review
      description must not claim credentials were supplied while those fields
      are empty.
- [ ] Obtain authentic Windows screenshots for each product/language listing.
      Neither production candidate has a supported unsigned/unpackaged UI route;
      both retain Store-origin authority before window creation. The separately
      authorized development packages may supply test UI evidence with accurate
      provenance once their startup checks pass. Use the
      approved delivery/testing route and accurate package provenance; do not
      substitute mocks, a copied EXE, a GUI Worker tab for standalone Worker, or
      weaker trust settings. Record the approval/delivery dependency explicitly.
- [ ] Complete approved Windows privacy publication and discoverable in-app
      coverage. Saving accurate text in Store drafts does not update the older
      `https://api.music-mute.com/privacy` page opened by the app, or approve
      service/consent claims.
- [ ] After the necessary approvals and final materials are ready, upload the
      exact current candidates, resolve package validation, enter accurate
      capability/rights information, and submit certification with manual hold.
      This preparation turn does not perform those actions.
- [ ] After certification and the separately authorized private tester release,
      acquire real Store-signed packages and complete account/Library/Prepare,
      Chrome, GPU, worker lifecycle, servicing/data retention and physical
      Windows 10 22H2 acceptance. Public release remains prohibited.

The finite retained Fleet bookkeeping limit remains documented in the
implementation ledger; long-run installed acceptance stays open. Do not label
all 18 migration tasks complete from release-copy or archive checks.

## Final handoff sequence

1. Owner submits support request; record each real case and permission outcome.
2. Close source/recipient/consent and reviewer-access gates without changing
   product quality or inventing rights declarations.
3. Resolve the approved signed-testing/screenshot route, then capture real EN/AR
   product images and complete all four localized listings.
4. Recheck actual policy fields, private audience, Free pricing, desktop-only
   availability and manual publishing hold for each product.
5. Submit only when actual package validation and material gates pass. Preserve
   the existing tester-only release scope and complete signed-installed tests.

Microsoft documents [manual publishing hold and review notes](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/manage-submission-options)
and [direct privacy text](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/support-info).
Those available controls do not waive certification or require a paid certificate.
