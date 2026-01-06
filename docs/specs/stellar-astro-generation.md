# Génération Astro Procédurale

**Version :** 1.0  
**Statut :** Draft

---

## 1. Contexte et objectifs
Chaque système stellaire possède un bloc `StarSystemAstro` décrivant son contenu procédural (étoiles, planètes, lunes) ainsi que les bornes orbitales utiles (zone habitable et ligne de neige). La génération doit être strictement déterministe à partir de la seed du monde pour permettre une reconstruction fidèle après sérialisation ou lors du chargement d’une sauvegarde partielle.

## 2. Dérivation de la seed par système
- **Entrées** : `worldSeed` (seed globale de la partie) et `systemId` (identifiant stable du système).
- **Dérivation** : la seed interne du système est calculée via `deriveSeed32(worldSeed, systemId, 'astro')`. Cette seed alimente `RNG` pour l’ensemble des tirages (étoiles, orbits, types planétaires, lunes).
- **Garanties** :
  - Deux appels avec le même couple (`worldSeed`, `systemId`) produisent exactement le même résultat, indépendamment de l’ordre des appels ou de l’état des autres systèmes.
  - La présence du namespace fixe `'astro'` évite les collisions avec d’autres dérivations utilisant le même couple.

## 2.1 Contexte galactique
`generateStellarSystem` accepte en entrée la position du système et le rayon galactique pour calculer un rayon normalisé (0..1). Ce rayon influence :
- l’âge stellaire (bins `young/mid/old`),
- la métallicité `[Fe/H]` via un gradient radial + dispersion.

## 3. Contenu du payload `StarSystemAstro`
Le payload est structuré selon `src/shared/types.ts` et suit les règles suivantes :
- **Racine** :
  - `seed` : seed dérivée spécifique au système (debug / reproductibilité).
  - `primarySpectralType`, `starCount`, `metallicityFeH` : données globales sur le système.
  - `stellarAgeGyr`, `stellarAgeClass` : âge stellaire simplifié (bins), utilisé pour limiter les types B/O (et une partie des A) aux systèmes jeunes.
  - `derived` : valeurs calculées à partir de la luminosité totale (`luminosityTotalLSun`) incluant `snowLineAu`, `hzInnerAu`, `hzOuterAu`.
- **Étoiles (`stars`)** :
  - Tableau ordonné : la primaire en premier (`role: 'primary'`), puis les compagnons (`role: 'companion'`).
  - Chaque entrée stocke le `spectralType`, la masse/raie de rayonnement (`massSun`, `radiusSun`, `luminositySun`, `teffK`).
  - Les compagnons peuvent inclure un `orbit` déterministe (`semiMajorAxisAu`, `periodDays`, `phaseDeg`, `inclinationDeg`, `ascendingNodeDeg`) généré via une RNG dérivée pour ne pas perturber le reste.
- **Planètes (`planets`)** :
  - Le nombre total est borné par `maxPlanets` et par un tirage de Poisson dépendant du type spectral primaire.
  - Les orbites sont générées, éventuellement ajustées à la ligne de neige, puis triées par demi‑grand axe croissant (`semiMajorAxisAu`).
- Chaque planète enregistre `type`, `eccentricity`, `orbitInclinationDeg`, `orbitAscendingNodeDeg`, `axialTiltDeg`, masse/rayon/gravité, `albedo`, `teqK`, `atmosphere`, pression éventuelle, `greenhouseK`, `climateK`, `airMassIndex`, `seasonalDeltaK`, température (compat) et éventuelle `climateTag`.
- **Lunes (`moons`)** :
- Chaque planète possède un tableau `moons` (éventuellement vide) détaillant `type`, `orbitDistanceRp`, `orbitEccentricity`, `orbitInclinationDeg`, `orbitAscendingNodeDeg`, masse/rayon/gravité, `albedo`, `teqK`, bonus de marée (`tidalBonusK`), type d’atmosphère, pression éventuelle, `greenhouseK`, `climateK`, `airMassIndex`, `seasonalDeltaK` et température.
- `climateK` est dérivé de l’insolation et de l’albédo (`teqK`) puis ajusté par `greenhouseK`; `airMassIndex` est un indicateur 0..1 de densité atmosphérique (pression + composition).

### 3.1 Climat simplifié
- `teqK` : température d’équilibre (insolation moyenne + albédo, corrigée par l’excentricité).
- `greenhouseK` : bonus d’effet de serre dérivé de la pression (log‑scale) et du type d’atmosphère.
- `climateK = teqK + greenhouseK` (lunes : `teqK + tidalBonusK + greenhouseK`).
- `airMassIndex` : indicateur 0..1 de densité atmosphérique (pression + composition).
- `seasonalDeltaK` : amplitude thermique saisonnière (excentricité orbitale + inclinaison axiale, amortie par l’inertie atmosphérique).
- `climateTag` (Terrestres) : IceWorld <200K, Cold <250K, Eden 275–305K si Earthlike + `airMassIndex >= 0.45`, Desertic <=700K, sinon Volcanic.
- `climateTag` (Géantes) : HotGiant >900K, WarmGiant >300K, sinon ColdGiant. Naines : IcyDwarf <180K sinon RockyDwarf.

### 3.2 Atmosphères (primaire/secondaire)
- L’atmosphère primaire (H/He) n’est conservée que par des corps massifs et froids (super‑Terres) : `massEarth >= 2.2`, flux faible et `teqK < 600K`.
- En dessous de ~0.05 M⊕, l’atmosphère est considérée perdue (airless), même si un dégazage existe.
- Les atmosphères secondaires dépendent d’un compromis entre rétention (masse/gravité) et érosion (flux stellaire + température).
- Les petites masses (0.1–0.5 M⊕) tendent vers des atmosphères minces (Thin) ou CO2 lorsque le dégazage est suffisant.
- Les masses proches de la Terre (`>= 0.7 M⊕`) peuvent atteindre Earthlike si la planète est dans la zone habitable et si l’érosion reste modérée.
- Les lunes subissent une pénalité d’érosion additionnelle ; un chauffage de marée élevé augmente le dégazage (favorise CO2).

## 4. Invariants de sérialisation
- Lors de la désérialisation, `sanitizeStarSystemAstro` impose la présence des champs obligatoires : `seed`, `primarySpectralType`, `starCount`, `metallicityFeH`, bloc `derived` complet, ainsi que les tableaux `stars` et `planets`.
- Si un champ obligatoire est manquant, non numérique ou mal typé, le payload est considéré invalide et n’est pas réutilisé tel quel.
- Les collections doivent rester sérialisables en JSON standard (aucune référence circulaire, uniquement des valeurs primitives ou des tableaux/objets simples).

## 5. Régénération en absence de données valides
- **Avec données manquantes ou invalides** : si `astro` est absent ou rejeté par la sanitation et que `worldSeed` et `systemId` sont disponibles, `generateStellarSystem({ worldSeed, systemId })` régénère le payload complet de façon déterministe.
- **Sans seed ou identifiant** : si les entrées sont inexploitables (seed non finie ou `systemId` vide), `astro` reste `undefined` et aucune reconstruction n’est tentée.
- **Point d’entrée** : la logique de régénération est centralisée dans `restoreAstro` (appelée depuis la restauration du monde). La génération initiale lors de la création du monde applique la même fonction `generateStellarSystem` pour remplir `astro`.

## 6. Notes sur la zone habitable et la ligne de neige
- `snowLineAu` et les bornes de la zone habitable (`hzInnerAu`, `hzOuterAu`) sont calculées à partir de la luminosité totale combinée des étoiles.
- Les demi‑grands axes planétaires sont initialement dessinés en relatif, puis mis à l’échelle par la ligne de neige pour conserver des distributions plausibles. Les ajustements finaux respectent les caps d’orbites internes/externes définis par `StellarSystemGenParams`.
- Ces valeurs dérivées sont conservées dans le payload pour éviter des recomputations divergentes et garantir une cohérence totale entre génération, stockage et restitution.
