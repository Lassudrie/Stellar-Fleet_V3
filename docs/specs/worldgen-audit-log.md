# Worldgen Audit Log

Version: 1.0  
Status: Draft

## Goal

Provide a deterministic, auditable JSON trace of the procedural generation pipeline:
galaxy -> systems -> bodies -> surface maps. The log is designed for reproducibility,
debugging, and diffing between runs while keeping the file size reasonable.

## Location and lifecycle

- Output path: `log/worldgen-audit.json`
- Local only: the `log/` folder is gitignored.
- No timestamps, no host-specific data.

## How to generate

```bash
npm run worldgen:audit -- --scenario conquest_sandbox --seed 1234
```

Use `--list` to list available scenarios, and `--out` to override the output path.

## Schema overview

Top-level keys (stable order):

- `schemaVersion`: integer
- `mode`: `"summary"`
- `meta`: scenario + resolved parameters (seed, topology, spacing, rng states)
- `inputs`: scenario generation/setup inputs (including `generation.settlements`)
- `events`: ordered event list with deterministic `seq`
- `summaries`: aggregates for systems/astro/planets and (optionally) surfaces

### Event shape

Each event is a JSON object:

```json
{
  "seq": 12,
  "step": "systems",
  "kind": "system_generated",
  "entityId": "sys_...",
  "rngStateBefore": 123,
  "rngStateAfter": 456,
  "inputs": { "...": "..." },
  "outputs": { "...": "..." }
}
```

### Surface map summary

Surface logs intentionally avoid full tile dumps. Each surface includes:

- `tilesHash`: stable hash of tiles + settlements
- `tileStats`: min/max/avg for elevation, temperature, moisture
- `biomeHistogram`
- `settlements` summary and capital list
- `settlements.byStatus` (actifs vs ruines) si disponible
- `tileSample`: deterministic sample grid (small)

Chaque `surface_map_summary` inclut aussi des **entrees** d'audit :
- `descriptor.settlementConfig` (parametres de colonisation neutre)
- `descriptor.config.generatorVersion` (v6 = terrain-first)
- `env.surfaceClassReason` (raison de la classe de surface)
- `bodySummary` (resume du corps: type, masse/rayon/gravite, atmosphere/pression, temperature, flux si disponible)

### Astro (evenement `astro_generated`)

Les sorties incluent desormais :
- `stellarAgeGyr` / `stellarAgeClass`
- `galacticRadiusNorm` (rayon normalise 0..1)

## Determinism notes

- No `Date.now`, `Math.random`, or non-deterministic sources.
- Ordered iteration and stable key sorting are required.
- The audit log must not change RNG consumption.
