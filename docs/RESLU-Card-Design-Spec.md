# RESLU Card — Design Specification

The single source of truth for anything built in the RESLU "card" language:
appointment/booking cards, reminder cards, milestone emails, printed slips.
This is the exact system used by the website's Begin form and the folded
packet. Follow it precisely and the artifact will look native to the brand.

Reference implementations (already built, copy from these):
`reslu-site/emails/visit-confirmation.html` and `visit-reminder.html`.

---

## 1. Surfaces

| Surface | Value | Use |
|---|---|---|
| Page / canvas | `#EDE8DE` ("bone") | The background everything sits on |
| Deep panel | `#F5F1E8` | Alternate section background, rarely on cards |
| **The card / paper** | `#faf6ec` | The cardstock itself — every card uses this |
| Card border | `1px solid #e6dfcf` | Hairline, radius 1px (near-square corners) |
| Hairline dividers | `#e6dfcf` on the card · `#d8d2c6` on the page | Detail-row separators |

Card shadow (web contexts):
`box-shadow: 0 1px 2px rgba(60,50,30,.08), 0 12px 40px rgba(60,50,30,.13)`

Paper texture (web contexts, optional; skip in email):
SVG feTurbulence overlay at 5% opacity —
`baseFrequency 0.9, numOctaves 2, colour ≈ rgb(107,97,77)`

## 2. Ink colours

| Name | Hex | Use |
|---|---|---|
| Ink | `#1A1A1A` | Headings, primary text, letterhead rule |
| Ink soft | `#313131` | Body copy, labels, secondary text |
| **Pen (blue ink)** | `#274690` | Everything "handwritten": names, dates, times, signatures |
| Taupe | `#A08C72` | Accent labels, the availability dot — sparingly |
| Emboss fill | `#e2dac5` | Debossed logo colour on paper |

## 3. Type system

**Serif (headings, card titles)** — Cormorant Garamond, weight 300
- Google Fonts: `https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300&display=swap`
- Email fallback stack: `Georgia, 'Times New Roman', serif`
- Card headline: 22–26px, line-height 1.4. Italic for emphasis words.

**Sans (body copy)** — Helvetica Neue Light
- Stack: `'Helvetica Neue', Helvetica, Arial, sans-serif`, weight 300
- Card body: 13–15px, line-height 1.7, colour `#313131`

**Labels (small caps convention)** — same sans stack
- 9–11px, `letter-spacing: 3px` (0.2–0.28em), UPPERCASE, colour `#313131`
- Used for: letterhead meta (RESLU · ADELAIDE), row labels (WHEN / WHERE / WITH), image captions

**The pen (handwriting)** — Caveat, weights 500–600
- Google Fonts: `https://fonts.googleapis.com/css2?family=Caveat:wght@500;600&display=swap`
- Email fallback stack: `'Caveat', 'Segoe Script', 'Bradley Hand', cursive`
- Colour: ALWAYS `#274690` (the blue pen). Never black, never grey.
- Sizes: detail values 22–24px · signature lines 28–30px
- Web contexts: rotate -0.5° to -2° for a written feel (skip rotation in email)
- Date style when handwritten: short numeric `9.7.26`

## 4. Card anatomy (top to bottom)

1. **Logo above the card** — `https://www.reslu.com.au/reslu-logo.png`, ~96px wide, on the bone background (logo is 640×261 with transparency)
2. **Letterhead row** (on the card): serif title left ("Site Visit", "Project Brief"), label meta right ("RESLU · ADELAIDE"), separated below by a `1px solid #1A1A1A` rule
3. **Headline** — serif, personalised where possible ("{{first_name}}, your visit is confirmed.")
4. **Body line** — sans, 1–3 sentences, warm and plain
5. **Detail rows** — label column (WHEN / WHERE / WITH, 80px wide) + value in the pen font/colour; rows separated by `#e6dfcf` hairlines
6. **Footnote** — sans 13px ("Need to move it? Reply or call …")
7. **Below the card: the packet** — `https://www.reslu.com.au/email-packet.jpg` (~300px wide, centred), captioned in label style: "YOUR BRIEF, ON FILE"
8. **Footer** — label-ish small sans: RESLU · Design & Build Studio / 219 Sturt Street, Adelaide SA 5000 · BLD 299219 / "One project. One team. One standard."

## 5. Shared assets (hotlink, don't copy)

| Asset | URL |
|---|---|
| Logo (transparent PNG) | `https://www.reslu.com.au/reslu-logo.png` |
| Folded packet photo | `https://www.reslu.com.au/email-packet.jpg` |
| Fonts | Google Fonts links above |

## 6. Emboss recipe (web only — the logo pressed into paper)

CSS mask of the logo over an `#e2dac5` fill, lit from above:
```css
-webkit-mask: url('https://www.reslu.com.au/reslu-logo.png') center/contain no-repeat;
background: #e2dac5;
filter: drop-shadow(0 -2px 1px rgba(255,255,255,.9))
        drop-shadow(0 2px 2px rgba(60,50,30,.55))
        drop-shadow(0 5px 8px rgba(60,50,30,.22));
```
In email, use the packet photograph instead — it has the emboss baked in.

## 7. Email-safety rules (for booking/reminder cards sent by email)

- Tables + inline styles only; no external CSS, no JS, no SVG
- Max content width 560px, centred, 44px card padding
- Caveat loads in some clients only — the fallback stack must look acceptable
- Images hotlinked from reslu.com.au with meaningful alt text
- No background images (Outlook); the card is a solid `#faf6ec` table cell

## 8. Voice rules (apply to all card copy)

- Brand voice per RESLU Brand Guide 2026; warm, plain, unhurried
- Banned words: luxury, bespoke, stunning, premium, turnkey, seamless, dream
  home, boutique, end-to-end, world-class, passionate, dedicated team,
  cutting-edge, elevated
- **No em dashes** in copy (middle dots `·` for separators; hyphens where needed)
- Suburb only — never a client street address in anything sent or shown
- Dates written out in body copy ("Tuesday 15 July"), numeric only in pen
  ("9.7.26"); times as "10:00am"; phone as "+61 439 870 594"
- Sign-off convention: "Phillip — RESLU" is written in the pen font (this is
  the one place a dash appears, as a signature attribution, in Caveat)

## 9. Placeholder conventions (for merge/sending systems)

`{{first_name}}` `{{last_name}}` `{{visit_date}}` `{{visit_time}}`
`{{suburb}}` `{{phillip_phone}}`
Residence naming: "The {{last_name}} Residence" — capitalise the first letter.
