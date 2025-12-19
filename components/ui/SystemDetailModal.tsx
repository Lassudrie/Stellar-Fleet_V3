import React from 'react';
import { MoonData, PlanetData, StarSystem } from '../../types';

interface SystemDetailModalProps {
  system: StarSystem | null;
  onClose: () => void;
}

const formatCelsius = (tempK: number) => `${(tempK - 273.15).toFixed(1)} °C`;
const formatAxis = (axis: number) => `${axis.toFixed(2)} AU`;
const formatMass = (mass: number) => `${mass.toFixed(2)} M⊕`;
const formatRadius = (radius: number) => `${radius.toFixed(2)} R⊕`;
const formatGravity = (gravity: number) => `${gravity.toFixed(2)} g`;
const formatEccentricity = (value: number) => value.toFixed(3);
const formatPressure = (value?: number) => (value !== undefined ? `${value.toFixed(2)} bar` : 'Unknown');

const MoonEntry: React.FC<{ moon: MoonData; index: number }> = ({ moon, index }) => (
  <li className="bg-slate-900/60 border border-slate-700 rounded-md p-3">
    <div className="flex items-center justify-between text-sm font-semibold text-slate-100">
      <span>Moon {index + 1}</span>
      <span className="text-xs px-2 py-1 rounded-full bg-slate-800 border border-slate-700">{moon.type}</span>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-300 mt-2">
      <div>
        <div className="text-slate-400">Mass / Radius</div>
        <div className="font-semibold text-slate-100">{formatMass(moon.massEarth)} · {formatRadius(moon.radiusEarth)}</div>
      </div>
      <div>
        <div className="text-slate-400">Gravity</div>
        <div className="font-semibold text-slate-100">{formatGravity(moon.gravityG)}</div>
      </div>
      <div>
        <div className="text-slate-400">Temperature</div>
        <div className="font-semibold text-slate-100">{formatCelsius(moon.temperatureK)}</div>
      </div>
      <div>
        <div className="text-slate-400">Orbit</div>
        <div className="font-semibold text-slate-100">{moon.orbitDistanceRp.toFixed(2)} Rp</div>
      </div>
      <div>
        <div className="text-slate-400">Atmosphere</div>
        <div className="font-semibold text-slate-100">{moon.atmosphere}</div>
      </div>
    </div>
  </li>
);

const PlanetEntry: React.FC<{ planet: PlanetData; index: number }> = ({ planet, index }) => (
  <li className="bg-slate-800/70 border border-slate-700 rounded-lg p-4 space-y-3">
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
      <div className="text-lg font-semibold text-white">Planet {index + 1}</div>
      <div className="text-sm px-3 py-1 rounded-full bg-slate-900/60 border border-slate-700 text-slate-200 capitalize">
        {planet.type.toLowerCase()}
      </div>
    </div>

    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-sm text-slate-200">
      <div>
        <div className="text-slate-400 text-xs uppercase tracking-wide">Atmosphere</div>
        <div className="font-semibold">{planet.atmosphere}</div>
      </div>
      <div>
        <div className="text-slate-400 text-xs uppercase tracking-wide">Pressure</div>
        <div className="font-semibold">{formatPressure(planet.pressureBar)}</div>
      </div>
      <div>
        <div className="text-slate-400 text-xs uppercase tracking-wide">Temperature</div>
        <div className="font-semibold">{formatCelsius(planet.temperatureK)}</div>
      </div>
      <div>
        <div className="text-slate-400 text-xs uppercase tracking-wide">Gravity</div>
        <div className="font-semibold">{formatGravity(planet.gravityG)}</div>
      </div>
      <div>
        <div className="text-slate-400 text-xs uppercase tracking-wide">Mass / Radius</div>
        <div className="font-semibold">{formatMass(planet.massEarth)} · {formatRadius(planet.radiusEarth)}</div>
      </div>
      <div>
        <div className="text-slate-400 text-xs uppercase tracking-wide">Eccentricity</div>
        <div className="font-semibold">{formatEccentricity(planet.eccentricity)}</div>
      </div>
      <div>
        <div className="text-slate-400 text-xs uppercase tracking-wide">Semi-major axis</div>
        <div className="font-semibold">{formatAxis(planet.semiMajorAxisAu)}</div>
      </div>
      <div>
        <div className="text-slate-400 text-xs uppercase tracking-wide">Albedo</div>
        <div className="font-semibold">{planet.albedo.toFixed(2)}</div>
      </div>
      {planet.climateTag && (
        <div>
          <div className="text-slate-400 text-xs uppercase tracking-wide">Climate</div>
          <div className="font-semibold capitalize">{planet.climateTag}</div>
        </div>
      )}
    </div>

    <div className="bg-slate-900/60 border border-slate-800 rounded-md p-3">
      <div className="text-sm font-semibold text-slate-100 mb-2">Moons</div>
      {planet.moons.length === 0 ? (
        <div className="text-sm text-slate-400">No moons detected.</div>
      ) : (
        <ul className="space-y-2">
          {planet.moons.map((moon, idx) => (
            <MoonEntry key={`moon-${idx}`} moon={moon} index={idx} />
          ))}
        </ul>
      )}
    </div>
  </li>
);

const SystemDetailModal: React.FC<SystemDetailModalProps> = ({ system, onClose }) => {
  if (!system) {
    return null;
  }

  const astro = system.astro;

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="bg-slate-900 text-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden border border-slate-700">
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <div className="text-xs text-slate-400 uppercase tracking-wide">System</div>
            <div className="text-2xl font-bold">{system.name}</div>
            {astro && (
              <div className="text-sm text-slate-300 mt-1">
                Seed {astro.seed} • Spectral type {astro.primarySpectralType} • {astro.starCount} star{astro.starCount !== 1 ? 's' : ''}
              </div>
            )}
          </div>
          <button
            className="text-slate-300 hover:text-white transition-colors text-lg px-2"
            onClick={onClose}
            aria-label="Close system details"
          >
            ✕
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto max-h-[78vh]">
          {!astro ? (
            <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-6 text-center text-slate-300">
              No procedural astronomy data is available for this system.
            </div>
          ) : (
            <>
              <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-4 text-sm text-slate-200">
                <div className="font-semibold text-white mb-2">Stellar summary</div>
                <div className="flex flex-wrap gap-4">
                  <div>
                    <div className="text-slate-400 text-xs uppercase tracking-wide">Spectral type</div>
                    <div className="font-semibold">{astro.primarySpectralType}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-xs uppercase tracking-wide">Stars</div>
                    <div className="font-semibold">{astro.starCount}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-xs uppercase tracking-wide">Metallicity [Fe/H]</div>
                    <div className="font-semibold">{astro.metallicityFeH.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-xs uppercase tracking-wide">Total luminosity</div>
                    <div className="font-semibold">{astro.derived.luminosityTotalLSun.toFixed(2)} L☉</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-xs uppercase tracking-wide">Snow line</div>
                    <div className="font-semibold">{astro.derived.snowLineAu.toFixed(2)} AU</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-xs uppercase tracking-wide">Habitable zone</div>
                    <div className="font-semibold">
                      {astro.derived.hzInnerAu.toFixed(2)}–{astro.derived.hzOuterAu.toFixed(2)} AU
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <div className="text-lg font-semibold text-white mb-3">Planets</div>
                <ol className="list-decimal list-inside space-y-4">
                  {astro.planets.map((planet, idx) => (
                    <PlanetEntry key={`planet-${idx}`} planet={planet} index={idx} />
                  ))}
                </ol>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SystemDetailModal;
