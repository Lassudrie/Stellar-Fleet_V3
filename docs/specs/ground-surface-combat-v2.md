# Specification Technique : Ground Surface Combat V2 (Surface Map)

Statut: Draft
Revision: v2.2 (decisions verrouillees)
Portee: combat terrestre + invasion orbitale (bombardement + blocus) sur surface map.
Remplace: `docs/specs/ground-surface-combat-v1.md` (reference historique).

## 0) Synthese des decisions

- Combat resolu sur surface map, positions persistantes.
- Stacking autorise, cap 10; penalite au-dela de 2 (-10% atk/def par unite excedentaire).
- Limite 100 unites par side sur une bataille.
- Ordres persistants; mouvement + attaque possibles le meme tour.
- Supply par BFS depuis sources controlees; binaire (ravitaille / non ravitaille).
- ZOC basee sur projectionRange; entrer en ZOC stoppe le mouvement et declenche un assaut frontal si pas d'ordre attack.
- Debarquement force avec pertes; bombardement orbital avant debarquement.
- Hex ennemi interdit au debarquement; hex ami autorise si cap respecte.
- Capture immediate d'un settlement si pas d'ennemi en ZOC; controle persistant.
- Victoire attaquant: controle de tous les settlements du body; defenseur: detruire/derouter toutes les unites.
- Post-battle: morale cap basse + fatigue ajoutee; condition inchangee.
- Anti-orbital reduit bombardement et augmente pertes de debarquement.
- Determinisme: RNG par engagement, tri stable partout.

## 1) Objectif

Refondre le systeme de combat terrestre pour qu'il soit strictement localise sur la surface map,
avec debarquement cible, positions persistantes, resolution deterministe, et integration multi-vues.

## 2) Invariants (determinisme et immutabilite)

- Pas de sources non deterministes dans le moteur.
- RNG isole par engagement.
- Ordre de tri stable par id pour toute boucle consommant la RNG.
- Pas de mutation in-place (pattern immutable).

## 3) Etat actuel (v1) - inventaire

### Conserver
- Supply par propagation depuis settlements/buildings controles.
- Fatigue appliquee apres mouvement et combat.
- RNG triangulaire a epsilon faible.
- Break / deroute (mais redefini).
- Pathfinding deterministe (ordre des voisins stable).
- Terrain derive des biomes.
- Logs detailes par engagement.
- Nettoyage fin de tour, suppression des unites hors combat.

### Modifier
- ZOC: suppression du cout MP, remplace par arret + engagement force.
- Combat: passage de 1v1 a engagements multi-attaquants vs defenseur.
- Ordres: plus de clear automatique en fin de phase, ordres persistants.
- Capture: via etat settlementControl persistant.

### Supprimer
- Limitation 1 unite par hex.
- Overrun strict base sur absence d'hex libre.

## 4) Modele de donnees v2

### 4.1 Army (unite terrestre)

Champs existants conserves:
- id, factionId, state, containerId, surfacePos?, unitType
- members, maxMembers, attack, defense, condition

Champs ajoutes:
- morale: number (0..1)
- fatigue: number (0..1)
- rangeMin, rangeMax: number (hex)
- projectionRange: number (hex) pour ZOC / projection de force
- lastCombatTurn?: number (tour du dernier engagement)
- groundOrders?: {
    move?: { type: 'move'; to: SurfacePos }
    attack?: { type: 'attack'; targetArmyId: string }
    posture?: 'normal' | 'prepared_defense'
  }
- landingOrder?: { type: 'land'; to: SurfacePos }

Notes:
- routed = morale < BREAK_THRESHOLD (pas de champ dedie).

### 4.2 Stats unite (GROUND_UNIT_STATS)

Champs exposes:
- baseMP
- baseAttack, baseDefense
- rangeMin, rangeMax
- projectionRange
- baseMorale, baseFatigue
- landingResistance (defaut 1.0)
- antiOrbital (defaut 0)
- terrainCombatAffinity
- terrainMoveAffinity
- tags: ['artillery','airborne','engineer','armored','amphibious','hardened','anti_orbital']

### 4.3 Controle des settlements (nouvel etat)

Les settlements viennent du `PlanetSurfaceMap` et sont fixes. Le controle est ajoute en state:

- `GameState.settlementControl: Record<SettlementId, { factionId: FactionId | null; lastCaptureTurn: number }>`

Le controle persiste meme si l'hex est vide.

### 4.4 Ordres

- `groundOrders.move` et `groundOrders.attack` peuvent coexister.
- `landingOrder` est utilise uniquement pour les unites EMBARKED.
- Un ordre persiste tant qu'il reste valide. Il est supprime si:
  - l'unite est detruite,
  - la cible n'existe plus,
  - l'unite n'est plus sur le body cible.

## 5) Pipeline de tour

1) Bombardement orbital (existant) - marque les hex bombardes du tour.
2) Debarquement (nouveau):
   - Valide les landingOrder.
   - Applique pertes de debarquement.
   - Place les survivants sur la surface map.
3) Mouvement terrestre.
4) Combat terrestre (multi-attaquants vs defenseur).
5) Capture settlements.
6) Victoires locales (conditions de victoire au sol).
7) Nettoyage ordres invalides.

Note: le joueur peut planifier des debarquements sur n'importe quel tour d'une bataille.

## 6) Mouvement et pathfinding

### 6.1 MP effectifs

conditionFactor = clamp(condition, 0, 1)
supplyFactor = supplied ? 1.0 : 0.7
fatigueFactor = clamp(1 - fatigue, FATIGUE_FACTOR_MIN, 1)
MPeff = floor(baseMP * conditionFactor * supplyFactor * fatigueFactor)
MPeff >= 1 si members > 0

### 6.2 Cout de mouvement

- Base: `MOVE_COST` (terrain -> cout).
- Road: cout fixe a 1 (min 1).
- River: +1 au cout (apres road).
- Passer a travers un hex ami: cout x2.
- Hex ennemi: bloque.
- Hex ami: passable si stackingCap non depasse.

### 6.3 Pathfinding

- Dijkstra deterministe, ordre des voisins stable.
- Le pathfinding peut etre tronque a MP eff.

### 6.4 ZOC

- Entrer dans une ZOC ennemie stoppe le mouvement (voir section 7).

## 7) ZOC et assaut frontal

- ZOC = projection des unites avec members > 0 et morale >= BREAK_THRESHOLD.
- Entrer dans une ZOC ennemie est autorise mais force l'arret.
- Si l'unite n'a pas d'ordre attack valide, elle declenche un assaut frontal implicite.
- Cible implicite: ennemi avec DefensePower potentielle max, tie-break par id.
- Assaut frontal: AttackPower *= FRONT_ASSAULT_MULT.

## 8) Stacking

- Cap 10 unites par hex.
- Les unites sur un hex sont triees par id.
- Les 2 premieres unites ne subissent pas de penalite.
- A partir de la 3e: stackingFactor = 1 - 0.10 * (index - 2).
- La penalite s'applique uniquement a l'attaque et la defense des excedentaires.

## 9) Combat et projection de force

### 9.1 Validite d'une attaque

Une attaque est valide si:
- distance en hex dans [rangeMin, rangeMax]
- LoS true (voir 9.2)
- attaquant et defenseur sur le meme body

### 9.2 Line of Sight (LoS)

- LoS calculee par raycast hex.
- Bloquee par biomes montagne/volcanic et Urban (settlement/building).
- Les autres biomes ne bloquent pas la LoS.

### 9.3 Cover et fortifications

- coverFactor depend du biome (section 10).
- fortifFactor depend des GroundBuildings (section 10).

### 9.4 Resolution multi-attaquants

Engagement = 1 defenseur + tous les attaquants valides qui le ciblent.
RNG: un tirage par camp et par engagement (triangulaire, epsilon faible).

AttackPower_i = members_i * attack_i * condition_i * moraleFactor_i * terrainAtk_i * supplyAtk_i * fatigueFactor_i * stackingFactor_i
AttackPower = sum(AttackPower_i) * rngAtk

DefensePower = members_def * defense_def * condition_def * moraleFactor_def * terrainDef_def * supplyDef_def * fatigueFactor_def * stackingFactor_def
DefensePower *= coverFactor(hex) * fortifFactor(hex) * rngDef

LossRateDef = clamp(ENGAGEMENT_LETHALITY * AttackPower / (AttackPower + DefensePower), 0, ENGAGEMENT_LOSS_CAP)
LossRateAtk = clamp(ENGAGEMENT_LETHALITY * DefensePower / (AttackPower + DefensePower), 0, ENGAGEMENT_LOSS_CAP)

LossesDef = round(members_def * LossRateDef)
LossesAtkTotal = round(sum(members_i) * LossRateAtk)

Distribution pertes attaquants:
- proportionnelle a AttackPower_i (pre-RNG), tie-break par id.

### 9.5 Morale, condition, destruction

- condition -= CONDITION_LOSS_COEFF * (losses / members_before)
- morale -= MORALE_LOSS_COEFF * (losses / members_before)
- unite detruite si members <= 0
- routed si morale < BREAK_THRESHOLD (see section 11)

## 10) Terrain, biomes, infrastructures

### 10.1 Mapping biome -> TerrainType

- Conservation de TerrainType pour mouvement/affinite.
- Mapping deterministe biome -> terrain (utiliser `biomeToTerrainType`).
- Urban si settlement/building.

### 10.2 Cover factors (biomes)

CoverFactor par biome (Urban override):
- desert, ash_desert, vitrified, oxidized, fossil_basin, rocky, cratered: 1.00
- grassland, coast, lake, dusty_ice, compressed_plateau: 1.05
- tundra, taiga, fractured_ice, thermal_polygons, chemical_erosion: 1.10
- forest: 1.15
- rainforest: 1.20
- mountain, volcanic, lava_flats: 1.25
- Urban (settlement/building): 1.25

Biomes non listes: default 1.05.

### 10.3 Routes / rivieres

- Road: cout fixe a 1 (min 1).
- River: +1 au cout (si pas de road).

### 10.4 Fortifications / bunkers

- Fortification legere: fortifFactor = 1.10.
- Bunker: fortifFactor = 1.25.
- Bunker AA (anti-orbital): ajoute antiOrbital au hex.

Les bonus se cumulent avec coverFactor.

## 11) Supply, morale, fatigue

### 11.1 Supply

- Algorithme: BFS.
- Sources: settlements controles + ground buildings controles.
- Rayon: SUPPLY_RADIUS (constante globale).
- Cout par hex uniforme (1).
- Pas de blocage par ZOC ou presence ennemie en V2.

Effets:
- Unites non ravitaillees: attack/defense *= (1 - SUPPLY_PENALTY_ATK/DEF)
- Mouvement: supplyFactor = 0.7 si non ravitaille

### 11.2 Morale et rout

- moraleLoss = MORALE_LOSS_COEFF * (losses / members_before)
- routed si morale < BREAK_THRESHOLD
- routed:
  - attaque interdite
  - AttackPower *= ROUTED_ATK_MULT
  - DefensePower *= ROUTED_DEF_MULT
  - MPeff *= ROUTED_MP_MULT
  - projectionRange = 0
- Ralliement:
  - si pas de combat pendant 2 tours, appliquer recovery
  - sortie de routed si morale >= BREAK_THRESHOLD

### 11.3 Fatigue

- fatigue += FATIGUE_MOVE_PER_HEX * steps
- fatigue += FATIGUE_COMBAT_ADD apres chaque engagement
- fatigueFactor = clamp(1 - fatigue, FATIGUE_FACTOR_MIN, 1)

### 11.4 Recovery (pas de combat pendant 2 tours)

- morale += MORALE_RECOVERY
- condition += CONDITION_RECOVERY
- fatigue -= FATIGUE_RECOVERY

## 12) Capture et controle des settlements

- Capture immediate si au moins une unite presente sur l'hex du settlement et aucun ennemi en ZOC.
- Contested si plusieurs factions occupent l'hex.
- Controle persistant meme si l'hex est vide.
- Settlement controle = source de supply.

## 13) Conditions de victoire au sol

- Attaquant: controle tous les settlements du body.
- Body sans settlements: detruire/derouter toutes les unites ennemies.
- Defenseur: detruire/derouter toutes les unites ennemies.
- Orbite sans effet sur la victoire au sol.
- Si attaquant controle tous les settlements mais defenseurs restent: victoire attaquant, combats continuent aux tours suivants.

Post-battle normalization:
- morale = min(morale, POST_BATTLE_MORALE_CAP)
- fatigue = clamp(fatigue + POST_BATTLE_FATIGUE_ADD, 0, 1)
- condition inchangee

## 14) Debarquement

### 14.1 Regles

- Commande specifique `ORDER_GROUND_LAND`.
- Selection par unite et par hex.
- Unites non debarquees restent embarquees.
- Debarquement possible a chaque tour tant que la bataille dure.
- Unites peuvent etre detruites avant d'atterrir.
- Amphibious peut debarquer sur ocean/coast, les autres non.

### 14.2 Occupation des hex

- Hex ami: autorise si stackingCap respecte, sinon ordre invalide.
- Hex ennemi: interdit en V2.

### 14.3 Pertes de debarquement

LandingForce = sum(members * landingResistance) sur l'hex
DefenseProjection = sum(defenseProjection ennemie + forts) sur l'hex
AntiOrbitalProjection = somme des antiOrbital des unites/buildings ennemis en projectionRange
BaseLoss = LANDING_BASE
VariableLoss = LANDING_VAR * (DefenseProjection / (DefenseProjection + LandingForce))
OrbitPenalty = ORBIT_CONTESTED ? ORBIT_CONTESTED_LANDING_PENALTY : 0
BombardedPenalty = HEX_BOMBARDED_THIS_TURN ? BOMBARD_LANDING_PENALTY : 0
AntiOrbitalPenalty = min(AO_LANDING_MAX, AO_LANDING_COEFF * AntiOrbitalProjection)
TotalLossRate = clamp(BaseLoss + VariableLoss + OrbitPenalty + BombardedPenalty + AntiOrbitalPenalty, 0, LANDING_MAX)

- Les pertes sont appliquees avant placement.
- Distribution des pertes par unite au prorata de members, tie-break id.

## 15) Interaction orbite / sol

- Bombardement orbital a chaque tour, avant debarquement.
- Bombardement tagge les hex bombardes du tour via `bombardedHexesByBodyId` (state).
- Orbite contestee augmente les pertes de debarquement.
- Anti-orbital:
  - AntiOrbitalProjection = somme des antiOrbital des unites/buildings dans projectionRange
  - bombardDamage *= 1 / (1 + AO_COEFF * AntiOrbitalProjection)
  - landingLossRate += min(AO_LANDING_MAX, AO_LANDING_COEFF * AntiOrbitalProjection)
- Le blocus est represente par l'orbite contestee (pas de blocage du debarquement).

## 16) Commandes et flux joueur

- Nouvelle commande `ORDER_GROUND_LAND`.
- Ordres move/attack persistants par unite.
- Pas d'ordre hold/capture.
- Pas de multi-selection / planification.
- Actions non annulables (a la selection, ordre fixe jusqu'a execution/invalid).

## 17) UI et synchro multi-vues

Galaxy view:
- Presence combat sol par systeme.
- % settlements controles par body.

System view 3D:
- Ratio settlements controles, statut contested.
- Indicateur des debarquements planifies sur le tour.

Surface view:
- Overlays: ZOC, supply, stacking, controle settlements, bombardedHexesByBodyId (tour courant).
- Details unite: morale, fatigue, condition, supply, ordre courant, portee.
- Ordre de rendu sur un hex: tri par id (determinisme).

## 18) IA

- Tactiques multiples (attaque/defense) par profil.
- Eviter le stacking penalise.
- Priorite attaque settlements.
- Retrait / annulation de debarquement possible.
- Choix de zone de debarquement base sur terrain + defense ennemie.

## 19) Logs et messages

- Logs par engagement + logs specifiques de debarquement.
- Tres detaille; affichage pertes, supply, stacking.
- Localisation i18n requise.

## 20) Save format

- Serialiser tous les nouveaux champs (settlementControl, morale, fatigue, landingOrder, etc.).
- Pas de retro-compatibilite requise.
- Bump `SAVE_VERSION` obligatoire, load refuse si mismatch.

## 21) Determinisme et performance

- RNG par engagement.
- Taille cible: 200 unites fluide.
- Tri stable obligatoire pour:
  - landing resolution
  - mouvement
  - groupement d'engagements
  - distribution des pertes
  - capture settlements
  - nettoyage
- Caches autorises uniquement si derives d'inputs purs et stables (terrain, voisins, couts).
- Pathfinding limite a MPeff (Dijkstra tronque).
- Pas de mutation in-place.

## 22) Tests et validation

- Priorite: debarquement, capture, stacking.
- Tests perf requis (200 unites, cap stacking).
- Cas limite: body sans settlement.
- Smoke sim specifique requise.

## 23) Parametres et equilibrage

Expose dans `GROUND_UNIT_STATS`:
- baseMP, baseAttack, baseDefense
- rangeMin, rangeMax
- projectionRange
- baseMorale, baseFatigue
- landingResistance, antiOrbital
- terrainCombatAffinity, terrainMoveAffinity
- tags (artillery, airborne, amphibious, armored, engineer, hardened, anti_orbital)

Constantes globales:
- STACKING_PENALTY_PER_EXTRA = 0.10
- STACKING_FREE_SLOTS = 2
- STACKING_CAP = 10
- MAX_UNITS_PER_SIDE = 100
- SUPPLY_PENALTY_ATK = 0.20
- SUPPLY_PENALTY_DEF = 0.20
- SUPPLY_FACTOR_UNSUPPLIED = 0.7
- RNG_EPSILON = 0.08
- ENGAGEMENT_LETHALITY = 0.35
- ENGAGEMENT_LOSS_CAP = 0.35
- CONDITION_LOSS_COEFF = 0.60
- MORALE_LOSS_COEFF = 0.60
- BREAK_THRESHOLD = 0.25
- ROUTED_ATK_MULT = 0.70
- ROUTED_DEF_MULT = 0.70
- ROUTED_MP_MULT = 0.50
- FRONT_ASSAULT_MULT = 0.85
- FATIGUE_MOVE_PER_HEX = 0.02
- FATIGUE_COMBAT_ADD = 0.10
- FATIGUE_RECOVERY = 0.15
- FATIGUE_FACTOR_MIN = 0.50
- MORALE_RECOVERY = 0.20
- CONDITION_RECOVERY = 0.05
- POST_BATTLE_MORALE_CAP = 0.35
- POST_BATTLE_FATIGUE_ADD = 0.15
- LANDING_BASE = 0.10
- LANDING_VAR = 0.15
- LANDING_MAX = 0.60
- ORBIT_CONTESTED_LANDING_PENALTY = 0.10
- BOMBARD_LANDING_PENALTY = 0.05
- AO_COEFF = 0.15
- AO_LANDING_COEFF = 0.05
- AO_LANDING_MAX = 0.15

## 24) Questions ouvertes (post-V2)

1) Regles de victoire multi-factions (hors MVP).
2) Supply bloquee par controle ennemi (option future).
3) Unites logistics comme sources de supply (option future).
4) Debarquement airborne sur hex ennemi (option future).
5) Artillerie: tir indirect + splash (option future).
