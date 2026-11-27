# NUIST Sentinel-2 vegetation index lab

Interactive, browser-only vegetation index calculator for a user-supplied 10.02 km × 10.02 km Sentinel-2 reflectance composite around Nanjing University of Information Science & Technology.

The page includes preset and custom band formulas, illustrative aerosol and water-vapour scenarios, RGB band combinations, a shared index colour scale, and original/scenario distribution curves. The image is described by its provider as a June–August 2026 median composite; the exported raster does not independently document scene dates or the compositing method. Atmospheric scenarios are teaching simulations, not atmospheric retrievals.

## Publish with GitHub Pages

Place the contents of this folder at the root of the public `SynUW/viplayground` GitHub repository. In **Settings → Pages**, set **Build and deployment → Source** to **Deploy from a branch**, select `main` and `/ (root)`, then save. The page URL will be `https://SynUW.github.io/viplayground/`.

All calculations run in the visitor's browser. `assets/bands-f32.bin` is a 10 MB browser-ready export of the user-provided GeoTIFF and will be publicly downloadable if the repository is published.
