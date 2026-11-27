# NUIST Sentinel-2 vegetation index lab

Interactive, browser-only vegetation index calculator for a user-supplied 10.02 km × 10.02 km Sentinel-2 reflectance composite around Nanjing University of Information Science & Technology.

The page includes preset and custom band formulas, aerosol and water-vapour scenarios, RGB band combinations, a shared index colour scale, and original/scenario distribution curves. The input is a 10-band reflectance composite. Its acquisition times, solar/view geometry, AOT, and water-vapour fields are not in the TIFF.

## Atmospheric forward model

`assets/atmosphere-6s.json` contains precomputed 6SV1.1 coefficients for the Sentinel-2A MSI spectral response in each available band. Urban aerosol represents haze; the 6S biomass-burning profile represents wildfire smoke. The lookup grid spans AOD at 550 nm from 0 to 3.5 and water-vapour columns from 0.5 to 6 cm. The browser bilinearly interpolates atmospheric path reflectance, total transmission, and spherical albedo, then computes top-of-atmosphere reflectance as `path + transmission * surface / (1 - spherical * surface)` for each pixel.

The fixed representative geometry is solar zenith 25°, nadir view, July 15, target altitude 20 m, and ozone 0.3 cm-atm. It is a simulated observation of the supplied surface-reflectance composite, not a reconstruction of the actual acquisition atmosphere. One atmosphere is applied to the whole image. Surface reflectances outside 0–1 are clipped before forward modelling. The growth and lifecycle controls remain empirical spectral adjustments, not a canopy radiative-transfer model.

For reproducibility, use `tools/generate_6s_lut.py` with Py6S 1.9.2, scipy, and 6SV1.1. Set `SIXS_PATH` if the binary is outside `PATH`. Run `python tools/generate_6s_lut.py --shard 0` through `--shard 3`, then `python tools/generate_6s_lut.py --merge`. The original 6S model and Py6S documentation are linked in the webpage's method section.

## Publish with GitHub Pages

Place the contents of this folder at the root of the public `SynUW/viplayground` GitHub repository. In **Settings → Pages**, set **Build and deployment → Source** to **Deploy from a branch**, select `main` and `/ (root)`, then save. The page URL will be `https://SynUW.github.io/viplayground/`.

All calculations run in the visitor's browser. `assets/bands-f32.bin` is a 10 MB browser-ready export of the user-provided GeoTIFF and will be publicly downloadable if the repository is published.
