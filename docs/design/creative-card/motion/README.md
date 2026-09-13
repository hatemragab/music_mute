# MusicMute motion comparisons

Four silent, 12-second, 60 fps videos compare the same UI motion side by side. Left A is the recommended subtle style; right B is the more expressive alternative. These are illustrative motion renders, not Android recordings or final screen layouts. Review-form copy is simplified for the motion study and does not replace the approved confirmation flow.

- [01 Waves](01-waves.mp4): A uses a 12-second phase cycle and smaller displacement; B uses a 4-second cycle and larger displacement.
- [02 Bottom sheets](02-bottom-sheets.mp4): A uses 340 ms cubic easing with no overshoot; B uses a 750 ms spring with visible overshoot. Both close with 300 ms easing.
- [03 Buttons and stars](03-buttons-stars.mp4): A uses a 2.5% button press, ripple and restrained star feedback; B uses a 9% press and stronger spring feedback. White rings indicate simulated taps, not a proposed product feature.
- [04 Navigation](04-navigation.mp4): A uses a 230 ms fade with a small 20 px slide in this preview; B uses a 650 ms spring with a 170 px slide. Pixel values are illustration coordinates, not Android dp requirements.

Recommendation: A for all four, with normal native feedback for ordinary list rows and toolbar controls. Final timing should be checked on the authorized device after Android implementation; these clips do not prove real-device performance. Honor disabled system animations and stop offscreen/background animation.

Selection: user approved all recommended A variants. Implement them through shared widgets and motion tokens across Android screens; see the [approved specification](../ANDROID-REDESIGN-SPEC.md) and [shared foundation tasks](../../../superpowers/plans/2026-09-12-android-creative-card/shared-foundations.md).

The renderer uses Pillow and ffmpeg, bundled Python runtime, and system fonts. It creates only files in this documentation folder; application source is unchanged.
