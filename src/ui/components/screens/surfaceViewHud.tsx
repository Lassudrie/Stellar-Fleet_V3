import React from 'react';
import {
  Army,
  FactionId,
  FactionState,
  GroundBuilding,
  HexCoord,
  PlanetSurfaceMap,
  shortId
} from '../../../shared/shared';
import { useI18n } from '../../i18n';
import type { GameCommand } from '../../../engine/commands';
import type { EngagementPreview } from '../../../engine/ground';

type TileInfo = PlanetSurfaceMap['tiles'][number];

type ArmyMarker = {
  army: Army;
  coord: HexCoord;
  faction?: FactionState;
};

type LandingMarker = {
  army: Army;
  coord: HexCoord;
  faction?: FactionState;
};

type BuildingMarker = {
  building: GroundBuilding;
  coord: HexCoord;
  faction?: FactionState;
};

export type SurfaceMovePreview = {
  path: HexCoord[] | null;
  costCenti: number | null;
  mpEff: number;
  mpCenti: number;
  supplied: boolean;
};

export type SurfaceCombatPreview = {
  enemy: Army;
  terrainType: string;
  preview: EngagementPreview;
  range: number;
};

type LandingCandidate = {
  army: Army;
  plannedBodyId: string | null;
  plannedBodyName: string | null;
  plannedPos: { q: number; r: number } | null;
  faction?: FactionState;
};

type OrderMode = 'none' | 'move' | 'attack' | 'land';

export type SurfaceViewHudProps = {
  bodyName: string;
  onBackToGalaxy: () => void;
  onBackToSystem?: () => void;
  showLoadingOverlay: boolean;
  showTouchBadge: boolean;
  activeCoord: HexCoord | null;
  activeTile: TileInfo | null;
  cameraZoom: number;
  tileArmies: ArmyMarker[];
  landingCandidates: LandingCandidate[];
  selectedLanding: LandingCandidate | null;
  landingArmyId: string | null;
  orderMode: OrderMode;
  onSelectLanding: (armyId: string) => void;
  onSelectArmy: (armyId: string) => void;
  selectedArmy: Army | null;
  selectedArmyId: string | null;
  canControlSelectedArmy: boolean;
  movePreview: SurfaceMovePreview | null;
  combatPreview: SurfaceCombatPreview | null;
  tilePlannedLandings: LandingMarker[];
  plannedLandingsCount: number;
  tileBuildings: BuildingMarker[];
  onIssueCommand?: (cmd: GameCommand) => void;
  setOrderMode: React.Dispatch<React.SetStateAction<OrderMode>>;
  playerFactionId: FactionId;
};

const SectionHeader: React.FC<{ colorClass: string; label: string }> = ({ colorClass, label }) => (
  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-2">
    <span className={`w-2 h-2 rounded-full ${colorClass}`} />
    {label}
  </div>
);

export const SurfaceViewHud: React.FC<SurfaceViewHudProps> = ({
  bodyName,
  onBackToGalaxy,
  onBackToSystem,
  showLoadingOverlay,
  showTouchBadge,
  activeCoord,
  activeTile,
  cameraZoom,
  tileArmies,
  landingCandidates,
  selectedLanding,
  landingArmyId,
  orderMode,
  onSelectLanding,
  onSelectArmy,
  selectedArmy,
  selectedArmyId,
  canControlSelectedArmy,
  movePreview,
  combatPreview,
  tilePlannedLandings,
  plannedLandingsCount,
  tileBuildings,
  onIssueCommand,
  setOrderMode,
  playerFactionId
}) => {
  const { t } = useI18n();

  return (
    <>
      {showLoadingOverlay && (
        <div className="pointer-events-none absolute inset-0 z-10 flex justify-end p-4">
          <div className="rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-sm font-semibold text-slate-100 shadow-lg">
            {t('surfaceView.loadingOverlay')}
          </div>
        </div>
      )}

      <div className="absolute top-4 left-4 right-4 z-10 pointer-events-none flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="pointer-events-auto rounded border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm font-semibold text-slate-100 backdrop-blur">
          {t('surfaceView.bodyHeader', { name: bodyName })}
        </div>
        <div className="pointer-events-auto flex justify-start sm:justify-end">
          {onBackToSystem ? (
            <button
              onClick={onBackToSystem}
              className="rounded border border-slate-700 bg-slate-900/80 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-100 hover:border-slate-500 backdrop-blur"
            >
              {t('surfaceView.backToSystem')}
            </button>
          ) : (
            <button
              onClick={onBackToGalaxy}
              className="rounded border border-slate-700 bg-slate-900/80 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-100 hover:border-slate-500 backdrop-blur"
            >
              {t('surfaceView.backToGalaxy')}
            </button>
          )}
        </div>
      </div>
      {showTouchBadge && (
        <div className="pointer-events-none absolute top-16 right-4 z-10">
          <div className="rounded border border-slate-700 bg-slate-900/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-200 backdrop-blur">
            Touch input active
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 flex flex-col justify-end">
        <div className="pointer-events-auto m-4 self-end w-full max-w-md">
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 backdrop-blur max-h-[45vh] overflow-auto md:max-h-none">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t('surfaceView.tilePanel')}</p>
                {activeCoord ? (
                  <p className="text-base font-bold text-white">
                    {t('surfaceView.tileCoordinate', { q: activeCoord.q, r: activeCoord.r })}
                  </p>
                ) : (
                  <p className="text-sm text-slate-500">{t('surfaceView.hoverHint')}</p>
                )}
              </div>
              <div className="text-xs text-slate-400">
                {t('surfaceView.zoomLevel', { value: cameraZoom.toFixed(2) })}
              </div>
            </div>

            {activeTile && (
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <div className="text-slate-400 text-xs uppercase">{t('surfaceView.tileBiome')}</div>
                  <div className="font-semibold">{activeTile.biome}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-xs uppercase">{t('surfaceView.tileElevation')}</div>
                  <div className="font-semibold">{activeTile.elev.toFixed(0)}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-xs uppercase">{t('surfaceView.tileTemperature')}</div>
                  <div className="font-semibold">{`${(activeTile.tempC2 / 2).toFixed(1)}\u00B0C`}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-xs uppercase">{t('surfaceView.tileMoisture')}</div>
                  <div className="font-semibold">{activeTile.moist}</div>
                </div>
              </div>
            )}

            <div className="mt-4 space-y-2">
              <SectionHeader colorClass="bg-blue-400" label={t('surfaceView.armies')} />
              {tileArmies.length === 0 ? (
                <div className="text-sm text-slate-500">{t('surfaceView.noArmies')}</div>
              ) : (
                <div className="space-y-1">
                  {tileArmies.map(marker => (
                    <div key={marker.army.id} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: marker.faction?.color ?? '#e2e8f0' }} />
                        <span className="font-semibold text-slate-100">{marker.faction?.name ?? marker.army.factionId}</span>
                      </div>
                      <button
                        className={`text-xs font-mono px-2 py-0.5 rounded border ${
                          marker.army.id === selectedArmyId
                            ? 'border-sky-400 text-sky-200'
                            : 'border-slate-700 text-slate-300 hover:border-slate-500'
                        }`}
                        onClick={() => onSelectArmy(marker.army.id)}
                        title="Select unit"
                      >
                        {marker.army.members.toFixed(0)}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-4 space-y-2">
              <SectionHeader colorClass="bg-amber-400" label={t('surfaceView.landingOps')} />
              {landingCandidates.length === 0 ? (
                <div className="text-sm text-slate-500">{t('surfaceView.noLandingOps')}</div>
              ) : (
                <div className="space-y-2">
                  {landingCandidates.map(entry => {
                    const faction = entry.faction;
                    const isActive = orderMode === 'land' && landingArmyId === entry.army.id;
                    const plannedLabel = entry.plannedPos
                      ? t('surfaceView.landingPlanned', { q: entry.plannedPos.q, r: entry.plannedPos.r })
                      : entry.plannedBodyName
                        ? t('surfaceView.landingPlannedOther', { planet: entry.plannedBodyName })
                        : null;
                    return (
                      <div key={entry.army.id} className="flex items-center justify-between text-sm">
                        <div className="flex flex-col">
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: faction?.color ?? '#e2e8f0' }} />
                            <span className="font-mono text-slate-100">{shortId(entry.army.id)}</span>
                            <span className="text-xs text-slate-400">{entry.army.members.toFixed(0)}</span>
                          </div>
                          <div className="text-[10px] text-slate-500">{entry.army.unitType}</div>
                          {plannedLabel && (
                            <div className="text-[10px] text-emerald-300">{plannedLabel}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            disabled={!onIssueCommand}
                            onClick={() => onSelectLanding(entry.army.id)}
                            className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                              !onIssueCommand
                                ? 'border-slate-800 bg-slate-950/20 text-slate-500 cursor-not-allowed'
                                : isActive
                                  ? 'border-amber-400 bg-amber-900/30 text-amber-100'
                                  : 'border-slate-700 bg-slate-950/40 text-slate-200 hover:border-slate-500'
                            }`}
                          >
                            {t('surfaceView.selectLanding')}
                          </button>
                          {entry.plannedBodyId && (
                            <button
                              disabled={!onIssueCommand}
                              onClick={() => onIssueCommand?.({ type: 'CANCEL_GROUND_ORDER', armyId: entry.army.id })}
                              className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                                onIssueCommand
                                  ? 'border-slate-700 bg-slate-950/40 text-slate-200 hover:border-slate-500'
                                  : 'border-slate-800 bg-slate-950/20 text-slate-500 cursor-not-allowed'
                              }`}
                            >
                              {t('surfaceView.cancelLanding')}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {orderMode === 'land' && selectedLanding && (
                <div className="text-[11px] text-amber-200">
                  {t('surfaceView.landingHint', { army: shortId(selectedLanding.army.id) })}
                </div>
              )}
            </div>

            {plannedLandingsCount > 0 && (
              <div className="mt-4 space-y-2">
                <SectionHeader colorClass="bg-emerald-400" label={t('surfaceView.plannedLandings')} />
                {tilePlannedLandings.length === 0 ? (
                  <div className="text-sm text-slate-500">{t('surfaceView.noPlannedLandings')}</div>
                ) : (
                  <div className="space-y-1">
                    {tilePlannedLandings.map(marker => {
                      const canCancel = marker.army.factionId === playerFactionId;
                      const isLandingSelected = orderMode === 'land' && landingArmyId === marker.army.id;
                      return (
                        <div key={marker.army.id} className="flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: marker.faction?.color ?? '#e2e8f0' }} />
                            <span className="font-semibold text-slate-100">{marker.faction?.name ?? marker.army.factionId}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              className={`text-xs font-mono px-2 py-0.5 rounded border ${
                                isLandingSelected
                                  ? 'border-amber-400 text-amber-200'
                                  : 'border-emerald-700 text-emerald-200 hover:border-emerald-500'
                              }`}
                              onClick={() => onSelectLanding(marker.army.id)}
                              title="Select landing"
                            >
                              {marker.army.members.toFixed(0)}
                            </button>
                            <button
                              disabled={!onIssueCommand || !canCancel}
                              onClick={() => onIssueCommand?.({ type: 'CANCEL_GROUND_ORDER', armyId: marker.army.id })}
                              className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                                onIssueCommand && canCancel
                                  ? 'border-slate-700 bg-slate-950/40 text-slate-200 hover:border-slate-500'
                                  : 'border-slate-800 bg-slate-950/20 text-slate-500 cursor-not-allowed'
                              }`}
                            >
                              {t('surfaceView.cancelLanding')}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {selectedArmy && canControlSelectedArmy && (
              <div className="mt-4 border-t border-slate-800 pt-3 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Orders</div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    disabled={!onIssueCommand}
                    onClick={() => setOrderMode(prev => (prev === 'move' ? 'none' : 'move'))}
                    className={`rounded border px-3 py-2 text-xs font-semibold ${
                      orderMode === 'move' ? 'border-sky-400 bg-sky-900/40 text-sky-100' : 'border-slate-700 bg-slate-950/40 text-slate-200 hover:border-slate-500'
                    }`}
                  >
                    Move
                  </button>
                  <button
                    disabled={!onIssueCommand}
                    onClick={() => setOrderMode(prev => (prev === 'attack' ? 'none' : 'attack'))}
                    className={`rounded border px-3 py-2 text-xs font-semibold ${
                      orderMode === 'attack' ? 'border-rose-400 bg-rose-900/30 text-rose-100' : 'border-slate-700 bg-slate-950/40 text-slate-200 hover:border-slate-500'
                    }`}
                  >
                    Attack
                  </button>
                  <button
                    disabled={!onIssueCommand}
                    onClick={() => onIssueCommand?.({ type: 'CANCEL_GROUND_ORDER', armyId: selectedArmy.id })}
                    className="rounded border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs font-semibold text-slate-200 hover:border-slate-500"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={!onIssueCommand}
                    onClick={() => onIssueCommand?.({
                      type: 'SET_GROUND_POSTURE',
                      armyId: selectedArmy.id,
                      posture: selectedArmy.posture === 'prepared_defense' ? 'normal' : 'prepared_defense'
                    })}
                    className="rounded border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs font-semibold text-slate-200 hover:border-slate-500"
                  >
                    {selectedArmy.posture === 'prepared_defense' ? 'Unprepare' : 'Prepare'}
                  </button>
                </div>
                <div className="text-[11px] text-slate-400">
                  {orderMode === 'move' && 'Click a hex to set a move order.'}
                  {orderMode === 'attack' && 'Click an enemy unit hex to set an attack order.'}
                </div>

                {orderMode === 'move' && movePreview && (
                  <div className="text-[11px] text-slate-300 space-y-1">
                    <div>
                      MP: <span className="font-mono">{movePreview.mpEff}</span>{' '}
                      (<span className="text-slate-400">{movePreview.supplied ? 'supplied' : 'out of supply'}</span>)
                    </div>
                    <div>
                      Cost:{' '}
                      <span className="font-mono">
                        {movePreview.costCenti === null ? '\u2014' : `${(movePreview.costCenti / 100).toFixed(2)} MP`}
                      </span>
                    </div>
                    {movePreview.costCenti !== null && (
                      <div className="text-slate-400">
                        Used: {((movePreview.costCenti / Math.max(1, movePreview.mpCenti)) * 100).toFixed(0)}%
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {combatPreview && (
              <div className="mt-4 border-t border-slate-800 pt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Combat preview</div>
                  <div className="text-[10px] text-slate-500">
                    {combatPreview.terrainType} {'\u00B7'} R{combatPreview.range}
                  </div>
                </div>
                <div className="text-[11px] text-slate-200">
                  Target: <span className="font-mono">{combatPreview.enemy.id}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="bg-slate-950/40 border border-slate-800 rounded p-2">
                    <div className="text-slate-400">Attack power</div>
                    <div className="font-mono text-slate-100">{combatPreview.preview.attackPower.toFixed(1)}</div>
                  </div>
                  <div className="bg-slate-950/40 border border-slate-800 rounded p-2">
                    <div className="text-slate-400">Defense power</div>
                    <div className="font-mono text-slate-100">{combatPreview.preview.defensePower.toFixed(1)}</div>
                  </div>
                  <div className="bg-slate-950/40 border border-slate-800 rounded p-2">
                    <div className="text-slate-400">Loss rates</div>
                    <div className="font-mono text-slate-100">A {(combatPreview.preview.lossRateAtk * 100).toFixed(1)}%</div>
                    <div className="font-mono text-slate-100">D {(combatPreview.preview.lossRateDef * 100).toFixed(1)}%</div>
                  </div>
                  <div className="bg-slate-950/40 border border-slate-800 rounded p-2">
                    <div className="text-slate-400">Losses (est.)</div>
                    <div className="font-mono text-slate-100">A {combatPreview.preview.lossesAtkTotal}</div>
                    <div className="font-mono text-slate-100">D {combatPreview.preview.lossesDef}</div>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-4 space-y-2">
              <SectionHeader colorClass="bg-amber-400" label={t('surfaceView.buildings')} />
              {tileBuildings.length === 0 ? (
                <div className="text-sm text-slate-500">{t('surfaceView.noBuildings')}</div>
              ) : (
                <div className="space-y-1">
                  {tileBuildings.map(marker => (
                    <div key={marker.building.id} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: marker.faction?.color ?? '#fde68a' }} />
                        <span className="font-semibold text-slate-100">
                          {marker.building.name ?? marker.building.type}
                        </span>
                      </div>
                      <div className="text-xs text-slate-300 font-mono">{marker.building.type}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
