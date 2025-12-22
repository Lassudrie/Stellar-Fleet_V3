import React from 'react';
import { useI18n } from '../../i18n';
import { MoonData, PlanetData, StarSystem } from '../../../shared/types';
import { formatAu, formatCelsius, formatGravity } from '../../format/units';

interface SystemDetailModalProps {
  system: StarSystem | null;
  onClose: () => void;
}

const formatMass = (mass: number | undefined, fallback: string) =>
  typeof mass === 'number' && Number.isFinite(mass) ? `${mass.toFixed(2)} M⊕` : fallback;
const formatRadius = (radius: number | undefined, fallback: string) =>
  typeof radius === 'number' && Number.isFinite(radius) ? `${radius.toFixed(2)} R⊕` : fallback;
const formatEccentricity = (value: number | undefined, fallback: string) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : fallback;
const formatPressure = (value: number | undefined, fallback: string) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)} bar` : fallback;
const formatAlbedo = (value: number | undefined, fallback: string) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : fallback;
const formatOrbitRp = (value: number | undefined, fallback: string) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)} Rp` : fallback;
const formatLuminosity = (value: number | undefined, fallback: string) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)} L☉` : fallback;
const formatTwoDecimals = (value: number | undefined, fallback: string) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : fallback;

const MoonEntry: React.FC<{
  moon: MoonData;
  index: number;
  unknown: string;
  t: ReturnType<typeof useI18n>['t'];
}> = ({ moon, index, unknown, t }) => (
  <li className="bg-slate-900/60 border border-slate-700 rounded-md p-3">
    <div className="flex items-center justify-between text-sm font-semibold text-slate-100">
      <span>{t('moon.name', { index: index + 1 })}</span>
      <span className="text-xs px-2 py-1 rounded-full bg-slate-800 border border-slate-700">{moon.type}</span>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-300 mt-2">
      <div>
        <div className="text-slate-400">{t('planet.label.massRadius')}</div>
        <div className="font-semibold text-slate-100">
          {formatMass(moon.massEarth, unknown)} · {formatRadius(moon.radiusEarth, unknown)}
        </div>
      </div>
      <div>
        <div className="text-slate-400">{t('planet.label.gravity')}</div>
        <div className="font-semibold text-slate-100">{formatGravity(moon.gravityG, unknown)}</div>
      </div>
      <div>
        <div className="text-slate-400">{t('planet.label.temperature')}</div>
        <div className="font-semibold text-slate-100">{formatCelsius(moon.temperatureK, unknown)}</div>
      </div>
      <div>
        <div className="text-slate-400">{t('moon.label.orbit')}</div>
        <div className="font-semibold text-slate-100">{formatOrbitRp(moon.orbitDistanceRp, unknown)}</div>
      </div>
      <div>
        <div className="text-slate-400">{t('planet.label.atmosphere')}</div>
        <div className="font-semibold text-slate-100">{moon.atmosphere || unknown}</div>
      </div>
    </div>
  </li>
);

const PlanetEntry: React.FC<{
  planet: PlanetData;
  index: number;
  unknown: string;
  t: ReturnType<typeof useI18n>['t'];
}> = ({ planet, index, unknown, t }) => {
  const moons = planet.moons || [];

  return (
    <li className="bg-slate-800/70 border border-slate-700 rounded-lg p-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="text-lg font-semibold text-white">{t('planet.name', { index: index + 1 })}</div>
        <div className="text-sm px-3 py-1 rounded-full bg-slate-900/60 border border-slate-700 text-slate-200 capitalize">
          {planet.type.toLowerCase()}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-sm text-slate-200">
        <div>
          <div className="text-slate-400 text-xs uppercase tracking-wide">{t('planet.label.atmosphere')}</div>
          <div className="font-semibold">{planet.atmosphere || unknown}</div>
        </div>
        <div>
          <div className="text-slate-400 text-xs uppercase tracking-wide">{t('planet.label.pressure')}</div>
          <div className="font-semibold">{formatPressure(planet.pressureBar, unknown)}</div>
        </div>
        <div>
          <div className="text-slate-400 text-xs uppercase tracking-wide">{t('planet.label.temperature')}</div>
          <div className="font-semibold">{formatCelsius(planet.temperatureK, unknown)}</div>
        </div>
        <div>
          <div className="text-slate-400 text-xs uppercase tracking-wide">{t('planet.label.gravity')}</div>
          <div className="font-semibold">{formatGravity(planet.gravityG, unknown)}</div>
        </div>
        <div>
          <div className="text-slate-400 text-xs uppercase tracking-wide">{t('planet.label.massRadius')}</div>
          <div className="font-semibold">
            {formatMass(planet.massEarth, unknown)} · {formatRadius(planet.radiusEarth, unknown)}
          </div>
        </div>
        <div>
          <div className="text-slate-400 text-xs uppercase tracking-wide">{t('planet.label.eccentricity')}</div>
          <div className="font-semibold">{formatEccentricity(planet.eccentricity, unknown)}</div>
        </div>
        <div>
          <div className="text-slate-400 text-xs uppercase tracking-wide">{t('planet.label.semiMajorAxis')}</div>
          <div className="font-semibold">{formatAu(planet.semiMajorAxisAu, unknown)}</div>
        </div>
        <div>
          <div className="text-slate-400 text-xs uppercase tracking-wide">{t('planet.label.albedo')}</div>
          <div className="font-semibold">{formatAlbedo(planet.albedo, unknown)}</div>
        </div>
        {planet.climateTag && (
          <div>
            <div className="text-slate-400 text-xs uppercase tracking-wide">{t('planet.label.climate')}</div>
            <div className="font-semibold capitalize">{planet.climateTag}</div>
          </div>
        )}
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-md p-3">
        <div className="text-sm font-semibold text-slate-100 mb-2">{t('moon.section.title')}</div>
        {moons.length === 0 ? (
          <div className="text-sm text-slate-400">{t('moon.none')}</div>
        ) : (
          <ul className="space-y-2">
            {moons.map((moon, idx) => (
              <MoonEntry key={`moon-${idx}`} moon={moon} index={idx} unknown={unknown} t={t} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
};

const SystemDetailModal: React.FC<SystemDetailModalProps> = ({ system, onClose }) => {
  const { t } = useI18n();
  const unknown = t('system.value.unknown');

  if (!system) {
    return null;
  }

  const astro = system.astro;
  const habitableZoneLabel = astro
    ? (() => {
        const inner = formatAu(astro.derived?.hzInnerAu, unknown);
        const outer = formatAu(astro.derived?.hzOuterAu, unknown);
        if (inner === unknown || outer === unknown) {
          return unknown;
        }
        return `${inner}–${outer}`;
      })()
    : unknown;

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="bg-slate-900 text-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden border border-slate-700">
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <div className="text-xs text-slate-400 uppercase tracking-wide">{t('system.modal.systemLabel')}</div>
            <div className="text-2xl font-bold">{system.name}</div>
            {system.resourceType === 'gas' && (
              <div className="text-sm text-amber-300 mt-1 font-semibold">Resource: He-3</div>
            )}
            {astro && (
              <div className="text-sm text-slate-300 mt-1">
                {t('system.modal.headerLine', {
                  seed: astro.seed,
                  spectralType: astro.primarySpectralType,
                  stars: t('system.stars', { count: astro.starCount })
                })}
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
              {t('system.modal.noAstro')}
            </div>
          ) : (
            <>
              <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-4 text-sm text-slate-200">
                <div className="font-semibold text-white mb-2">{t('system.modal.stellarSummary')}</div>
                <div className="flex flex-wrap gap-4">
                  <div>
                    <div className="text-slate-400 text-xs uppercase tracking-wide">{t('system.label.spectralType')}</div>
                    <div className="font-semibold">{astro.primarySpectralType}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-xs uppercase tracking-wide">{t('system.label.stars')}</div>
                    <div className="font-semibold">{astro.starCount ?? unknown}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-xs uppercase tracking-wide">{t('system.label.metallicity')}</div>
                    <div className="font-semibold">{formatTwoDecimals(astro.metallicityFeH, unknown)}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-xs uppercase tracking-wide">{t('system.label.totalLuminosity')}</div>
                    <div className="font-semibold">{formatLuminosity(astro.derived?.luminosityTotalLSun, unknown)}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-xs uppercase tracking-wide">{t('system.label.snowLine')}</div>
                    <div className="font-semibold">{formatAu(astro.derived?.snowLineAu, unknown)}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-xs uppercase tracking-wide">{t('system.label.habitableZone')}</div>
                    <div className="font-semibold">
                      {habitableZoneLabel}
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <div className="text-lg font-semibold text-white mb-3">{t('system.planets.title')}</div>
                <ol className="list-decimal list-inside space-y-4">
                  {(astro.planets || []).map((planet, idx) => (
                    <PlanetEntry key={`planet-${idx}`} planet={planet} index={idx} unknown={unknown} t={t} />
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
