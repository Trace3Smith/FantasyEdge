# Sport background textures — sources & license

Generic, non-identifiable texture photos used as the per-sport background layer on the
rankings view. Sourced from **Pexels** under the [Pexels License](https://www.pexels.com/license/)
and from **Unsplash** under the [Unsplash License](https://unsplash.com/license) — both free for
commercial and non-commercial use, no attribution required, no permission needed. The per-file
source column says which.
None depict identifiable venues, signage, or people. Equipment maker's marks are avoided; the one
exception is noted per-file below, and is only accepted where processing renders it illegible.
Files are resized, recompressed to WebP, and stripped of EXIF metadata for weight and cleanliness.

| File | Sport | Source | Notes |
|------|-------|--------|-------|
| `golf-green.webp`  | Golf (PGA) | https://www.pexels.com/photo/4398355/    | Manicured green turf, top-down; slight blur |
| `mlb-field.webp`   | MLB        | https://www.pexels.com/photo/16163118/   | Mown outfield grass with a white foul line and red infield dirt (generic field surface, no venue/signage/seating). Moderate blur + standard scrim, like golf |
| `nba-arena.webp`   | NBA + WNBA | https://www.pexels.com/photo/1752757/    | Ball dropping through the net, rim lit against blurred arena bokeh (generic arena — no signage/scoreboard/architecture, crowd blurred past recognition); shared by both basketball tabs. Carries a small Spalding wordmark on the ball, illegible after resize + blur + scrim — accepted deliberately |
| `nfl-yard-numbers.webp` | NFL   | https://unsplash.com/photos/y6fTK4k2J6c  | Overhead drone view: the 30 and 40 yard numbers with straight yard lines between them (generic field — no end zone wordmark/midfield logo/sponsor paint/venue). Yard numbers are generic to every field. Cropped from the right-hand band of the source, which has a person lying on the 30 mid-frame; the crop excludes them entirely, at the cost of clipping the 30's direction arrow. Moderate blur (sigma 2.0) + standard scrim |
| `nhl-rink.webp`    | NHL        | https://www.pexels.com/photo/6847292/    | Real hockey rink — white dasher boards, goal, and cool ice (generic practice rink, no ads/board logos/venue) |

Processing: `sharp` → optional crop, resize ~1100–1300 px wide, WebP q48–58, metadata stripped. Blur
is tuned per image, not fixed — enough to suppress distracting detail, never enough to erase the
landmark that makes the sport readable. NFL is moderate (sigma 2.0): more would smear the yard
numbers into pale blobs. NBA is light (sigma 1.0) because its background is already lens bokeh and
the lit net is what has to survive the scrim. Each file 20–244 KB; only the active sport's image
loads.
