# Sport background textures — sources & license

Generic, non-identifiable texture photos used as the per-sport background layer on the
rankings view. All sourced from **Pexels** under the [Pexels License](https://www.pexels.com/license/):
free for commercial and non-commercial use, no attribution required, no permission needed.
None depict identifiable venues, signage, or people. Equipment maker's marks are avoided; the one
exception is noted per-file below, and is only accepted where processing renders it illegible.
Files are resized, recompressed to WebP, and stripped of EXIF metadata for weight and cleanliness.

| File | Sport | Source (Pexels) | Notes |
|------|-------|-----------------|-------|
| `golf-green.webp`  | Golf (PGA) | https://www.pexels.com/photo/4398355/    | Manicured green turf, top-down; slight blur |
| `mlb-field.webp`   | MLB        | https://www.pexels.com/photo/16163118/   | Mown outfield grass with a white foul line and red infield dirt (generic field surface, no venue/signage/seating). Moderate blur + standard scrim, like golf |
| `nba-arena.webp`   | NBA + WNBA | https://www.pexels.com/photo/1752757/    | Ball dropping through the net, rim lit against blurred arena bokeh (generic arena — no signage/scoreboard/architecture, crowd blurred past recognition); shared by both basketball tabs. Carries a small Spalding wordmark on the ball, illegible after resize + blur + scrim — accepted deliberately |
| `nfl-field.webp`   | NFL        | https://www.pexels.com/photo/29393323/   | Mown grass with diagonal groom stripes; blurred (kept distinct from golf) |
| `nhl-rink.webp`    | NHL        | https://www.pexels.com/photo/6847292/    | Real hockey rink — white dasher boards, goal, and cool ice (generic practice rink, no ads/board logos/venue) |

Processing: `sharp` → resize ~1100–1300 px wide, WebP q48–58, metadata stripped. Blur is tuned per
image, not fixed: NFL is blurred more to soften the groom stripes, while NBA is blurred only lightly
(sigma 1.0) because its background is already lens bokeh and the lit net is what has to survive the
scrim. Each file 23–244 KB; only the active sport's image loads.
