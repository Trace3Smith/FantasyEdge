# Sport background textures — sources & license

Generic, non-identifiable texture photos used as the per-sport background layer on the
rankings view. All sourced from **Pexels** under the [Pexels License](https://www.pexels.com/license/):
free for commercial and non-commercial use, no attribution required, no permission needed.
None depict identifiable venues, signage, or trademarked marks. Files are resized, recompressed
to WebP, and stripped of EXIF metadata for weight and cleanliness.

| File | Sport | Source (Pexels) | Notes |
|------|-------|-----------------|-------|
| `golf-grass.webp`  | Golf (PGA) | https://www.pexels.com/photo/413195/     | Manicured green turf, top-down; slight blur |
| `mlb-field.webp`   | MLB        | https://www.pexels.com/photo/16163118/   | Mown outfield grass with a white foul line and red infield dirt (generic field surface, no venue/signage/seating). Moderate blur + standard scrim, like golf |
| `nba-court.webp`   | NBA + WNBA | https://www.pexels.com/photo/6777245/    | Indoor basketball court — hardwood floor with hoop/backboard/free-throw arc (generic gym, no logos/branding/venue); shared by both basketball tabs |
| `nfl-field.webp`   | NFL        | https://www.pexels.com/photo/29393323/   | Mown grass with diagonal groom stripes; blurred (kept distinct from golf) |
| `nhl-ice.webp`     | NHL        | https://www.pexels.com/photo/6015665/    | Skated rink-ice surface, cool blue-grey |

Processing: `sharp` → resize ~1100–1200 px wide, WebP q48–58 (NFL blurred more to soften the
stripes), metadata stripped. Each file 17–197 KB; only the active sport's image loads.
