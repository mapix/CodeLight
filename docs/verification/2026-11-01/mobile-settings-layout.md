# Mobile global settings and top-level navigation

The user's layout request moves network selection into global app settings and
adds settings as an independent top-level page.

## Implementation

- Sessions and Settings have a shared bottom navigation with safe-area padding.
  The existing router navigates to sibling pages; returning reuses the browser
  page rather than replacing its search/expanded/scroll state.
- Sessions keeps its browser, search and synchronization feedback. Connection,
  language and scan actions move into the global settings screen.
- Settings groups Connection, Display and About. Connection uses the existing
  verified-route service and picker. Display offers the current theme and
  existing language screen. About shows the actual native app version/build.
- The theme platform application is shared with the retained appearance screen;
  preference persistence stays with the existing settings owner.
- Settings mount and tab selection do not issue native session controls or
  automatically change the peer. Project status polling pauses when the browser
  loses focus.

## Checks before native installation

Fifteen targeted settings/navigation/peer-selection tests passed, including no
implicit route/pairing/preference changes, explicit existing-owner actions,
current-tab reselection, settings-row picker behavior and selection ordering.
Bridge/mobile/production-relay typechecks and bridge lint passed after the
native preview was added.

The native preview uses synthetic connection states and cannot pair or control
a real peer. Native layout screenshots, interaction checks and physical build
112 installation are recorded after compilation. Notarization remains deferred
at the user's request.

## Native simulator verification

Build 2026110112 compiled and passed version/signature checks. The existing
unpaired simulator was used with synthetic route states; no real device access
or pairing was created. CUA accessibility and screenshots confirmed:

- Settings has one title, grouped connection/display/about controls and a
  selected Settings bottom tab, with the home indicator and safe-area space.
- The connection row opens the shared picker. A synthetic failed Relay choice
  keeps the previous route and shows its error; a successful manual choice
  closes the sheet and updates the row. Automatic selection also closes it.
- Adaptive/light/dark controls open the native picker, apply their layout and
  return without overlap. Light and dark screenshots were retained privately.
- Language opens the existing language screen with its proper title; Back
  restores the previous settings state.
- The actual `/settings` route renders instead of redirecting home. Current-tab
  reselection leaves the UI unchanged, and Sessions returns to the simulator's
  unpaired first-run home. Paired browser position preservation remains covered
  by the router implementation and awaits physical UI acceptance.

The simulator's actual native app version is the retained mobile version 1.8.0,
with build 2026110112. Preview version text is fixture data, not a release claim.

## Physical installation

Phone build 2026110112 compiled, passed strict signature/version checks and was
installed with the existing pairing retained. The actual global Settings route
was opened on the phone. The earlier unknown operation stayed in its original
scope journal. A genuine UI acceptance question asks the user to confirm the
top-level tabs, network placement, return to the browser and continued access
to the existing session; physical UI feedback is pending at this checkpoint.
