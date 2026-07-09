# RESLU Paper Animations — Implementation Brief

For the agent building the appointment/reminder cards. Everything below is
extracted from the WORKING production implementation — don't reinvent it,
copy it. All animations live in one file:

**Source of truth:**
`/Users/phillipintrona-mba/Library/Mobile Documents/com~apple~CloudDocs/Business /RESLU/JOBS - RESLU/26/260611_RESLU Marketing & Branding overhall/Website/reslu-site/src/components/BeginForm.astro`

Live reference to study in a browser: https://www.reslu.com.au/begin
(submit a test to see the full sequence; delete the lead from Spec after).

There are THREE separate animations. Most cards only need №1 and №2.

---

## №1 — The pen (writing text character by character)

Blue-ink handwriting that appears as if written live, with a blinking caret
that vanishes when the line is finished. This is the exact production code:

```js
// styles required on the target element: class="ink" (see CSS below)
function write(el, text, done) {
  el.innerHTML = '';
  const caret = document.createElement('span');
  caret.className = 'caret';
  el.append(caret);
  let i = 0;
  const t = setInterval(() => {
    if (i < text.length) {
      caret.insertAdjacentText('beforebegin', text[i++]);
    } else {
      clearInterval(t);
      setTimeout(() => { caret.remove(); done && done(); }, 350);
    }
  }, 36);           // 36ms per character — do not speed up below ~30ms
}
```

```css
@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@500;600&display=swap');

.ink{font-family:'Caveat',cursive;font-weight:600;font-size:22px;color:#274690;
  transform:rotate(-.5deg);transform-origin:left bottom}
.ink .caret{display:inline-block;width:2px;height:.85em;background:#274690;
  vertical-align:-2px;margin-left:1px;animation:blink .7s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
```

Chain lines with the `done` callback: `write(a, 'first', () => write(b, 'second'))`.
The `done` fires 350ms after the last character — that pause is deliberate
(the pen "lifts"). Signature lines use font-size 28–30px, rotate -2deg.

## №2 — The cardstock (the paper itself)

```css
.sheet{position:relative;background:#faf6ec;border:1px solid #e6dfcf;
  border-radius:1px;
  box-shadow:0 1px 2px rgba(60,50,30,.08), 0 12px 40px rgba(60,50,30,.13)}
/* paper grain — an SVG noise overlay at 5% */
.sheet::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.5;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='p'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.42 0 0 0 0 0.38 0 0 0 0 0.30 0 0 0 0.05 0'/%3E%3C/filter%3E%3Crect width='240' height='240' filter='url(%23p)'/%3E%3C/svg%3E")}
.sheet > *{position:relative}   /* keep content above the grain */
```

Elements "settle" onto the paper rather than appearing:
```css
@keyframes settle{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.appearing{animation:settle .45s ease}
```

## №3 — The fold (the paper folding in half; the finale)

This is NOT a CSS animation — it's a colour-graded film of real paper,
played as a positioned `<video>` over the sheet, with the emboss and the
handwritten lines added as DOM overlays after it ends.

**Video asset:** `reslu-site/public/begin-fold.mp4` · hosted at
`https://www.reslu.com.au/begin-fold.mp4` (1280×720, 4.0s, ~600KB, muted,
background colour-matched to #EDE8DE).

**Geometry constants** (fractions of the video frame — where the paper sits):
```js
const FV = { sx0:.332, sx1:.670, sy0:.108, sy1:.886,   // flat sheet bounds
             px0:.319, px1:.684, py0:.351, py1:.789 }; // resting packet bounds
```
Scale the video non-uniformly so the video's sheet exactly covers your DOM
sheet: `vw = sheetW/(sx1-sx0)`, `vh = sheetH/(sy1-sy0)`, offset by
`-sx0*vw, -sy0*vh`. Play on submit; on `timeupdate` past `duration - 0.55s`
the paper is at rest — add the emboss and write the pen lines then.

**Full working sequence:** functions `videoFold()`, `cssFold()` (fallback)
and `finish()` in BeginForm.astro — copy them wholesale.

## Hard-won gotchas (each of these cost us real debugging time)

1. **Astro scoped styles do NOT apply to JS-created elements.** Anything you
   create with `document.createElement` needs `<style is:global>` (prefix
   selectors with a wrapper class to avoid leaks).
2. **`animation: ... forwards` beats later class changes.** If you animate a
   property and then try to set it via a new class, add `animation:none` in
   that class or nothing happens.
3. **Safari will not clip `<video>` with `overflow:hidden`.** Set
   `clip-path: inset(...)` (with `-webkit-` twin) ON THE VIDEO ELEMENT
   itself, computed in px against its own box.
4. **Safari paints video above later siblings.** Any overlay on the video
   (feathers, emboss, text) needs explicit `z-index` and
   `transform:translateZ(0)`.
5. **Feather the video into the page** with bone-coloured
   (`#EDE8DE → transparent`) gradient overlays around the paper — never show
   raw video background; even a 2-point colour mismatch reads as a hard edge.
6. **Respect `prefers-reduced-motion`** — collapse timings to ~10ms or skip
   the video entirely (see the `cssFold` fallback pattern).
7. **Preload the video** on an earlier interaction (we use email-field focus)
   so it's buffered before it's needed; fall back to CSS if `readyState < 3`
   after ~1.4s.

## What a booking/reminder CARD probably needs

Paper (№2) + pen (№1) only: the card renders, the details write themselves in
blue ink one line after another (WHEN → WHERE → WITH), done. Save the fold for
moments of completion — it's the full stop, not the comma. If the card has a
"confirmed" state change, THAT is a legitimate fold moment.
