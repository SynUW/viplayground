"""Generate the Sentinel-2A 6S lookup used by the browser.

Requires Py6S 1.9.2, scipy, and the 6SV1.1 binary. Set SIXS_PATH to the
binary path if Py6S cannot find it automatically. Run each shard, then --merge.
"""
import argparse
import json
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
from Py6S import (SixS, Geometry, AeroProfile, AtmosProfile, Altitudes,
                 GroundReflectance, Wavelength, PredefinedWavelengths)

BANDS = ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B8A', 'B11', 'B12']
BAND_NUMBERS = ['02', '03', '04', '05', '06', '07', '08', '8A', '11', '12']
AOD_NODES = [0, .05, .1, .2, .4, .7, 1, 1.5, 2, 2.5, 3, 3.5]
WATER_NODES = [.5, 1.5, 2.5, 3.5, 4.5, 6]
PROFILES = {'haze': AeroProfile.Urban, 'smoke': AeroProfile.BiomassBurning}
SIXS = os.environ.get('SIXS_PATH')


def make_model():
    model = SixS(SIXS) if SIXS else SixS()
    model.geometry = Geometry.User()
    model.geometry.solar_z = 25
    model.geometry.solar_a = 120
    model.geometry.view_z = 0
    model.geometry.view_a = 0
    model.geometry.month = 7
    model.geometry.day = 15
    model.altitudes = Altitudes()
    model.altitudes.set_target_custom_altitude(.02)
    model.altitudes.set_sensor_satellite_level()
    return model


def coeffs(model):
    model.ground_reflectance = GroundReflectance.HomogeneousLambertian(0)
    model.run()
    path = model.outputs.apparent_reflectance
    spherical = model.outputs.spherical_albedo.total
    transmission = (model.outputs.transmittance_total_scattering.total
                    * model.outputs.total_gaseous_transmittance)
    if not (0 <= path <= 1 and 0 <= transmission <= 1 and 0 <= spherical < 1):
        raise ValueError('Invalid 6S coefficients: {}'.format((path, transmission, spherical)))
    return [round(path, 8), round(transmission, 8), round(spherical, 8)]


def compute_case(case):
    profile_name, aod, water = case
    model = make_model()
    model.aero_profile = AeroProfile.PredefinedType(PROFILES[profile_name])
    model.aot550 = aod
    model.atmos_profile = AtmosProfile.UserWaterAndOzone(water, .3)
    return [coeffs_for_band(model, number) for number in BAND_NUMBERS]


def coeffs_for_band(model, number):
    model.wavelength = Wavelength(getattr(PredefinedWavelengths, 'S2A_MSI_' + number))
    return coeffs(model)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--shard', type=int, default=0)
    parser.add_argument('--merge', action='store_true')
    args = parser.parse_args()
    output = {
        'model': '6SV1.1 via Py6S 1.9.2',
        'sensor': 'Sentinel-2A MSI spectral response',
        'geometry': {'solar_zenith_deg': 25, 'solar_azimuth_deg': 120,
                     'view_zenith_deg': 0, 'date': 'representative July 15',
                     'target_altitude_km': .02},
        'ozone_cm_atm': .3,
        'aod_nodes': AOD_NODES,
        'water_cm_nodes': WATER_NODES,
        'bands': BANDS,
        'coefficients': {},
        'equation': 'TOA = path + transmission * BOA / (1 - spherical_albedo * BOA)',
    }
    cases = [(profile, aod, water) for profile in PROFILES
             for aod in AOD_NODES for water in WATER_NODES]
    for profile_name in PROFILES:
        output['coefficients'][profile_name] = [[None for _ in WATER_NODES] for _ in AOD_NODES]
    if args.merge:
        all_entries = []
        for shard in range(4):
            shard_file = ROOT / 'tools' / ('6s_shard_{}.json'.format(shard))
            all_entries.extend(json.loads(shard_file.read_text(encoding='utf-8')))
        for profile_name, aod, water, band_coefficients in all_entries:
            output['coefficients'][profile_name][AOD_NODES.index(aod)][WATER_NODES.index(water)] = band_coefficients
        if len(all_entries) != len(cases) or any(
                cell is None for profile in output['coefficients'].values()
                for by_aod in profile for cell in by_aod):
            raise ValueError('Incomplete LUT: {} of {} cases'.format(len(all_entries), len(cases)))
        destination = ROOT / 'assets' / 'atmosphere-6s.json'
        destination.write_text(json.dumps(output, separators=(',', ':')), encoding='utf-8')
        print('merged {} band cases to {}'.format(len(all_entries)*len(BANDS), destination))
        return
    if args.shard not in range(4):
        raise ValueError('shard must be 0 through 3')
    cases = cases[args.shard::4]
    if args.limit:
        cases = cases[:args.limit]
    started = time.time()
    entries = []
    for index, case in enumerate(cases, 1):
        entries.append(list(case) + [compute_case(case)])
        if index % 10 == 0 or index == len(cases):
            print('shard {}: {} / {} grid cells in {:.1f}s'.format(
                args.shard, index, len(cases), time.time() - started), flush=True)
    if args.limit:
        print(json.dumps({'first': entries[0][3][0]}))
        return
    destination = ROOT / 'tools' / ('6s_shard_{}.json'.format(args.shard))
    destination.write_text(json.dumps(entries, separators=(',', ':')), encoding='utf-8')
    print('wrote {}'.format(destination))


if __name__ == '__main__':
    main()
