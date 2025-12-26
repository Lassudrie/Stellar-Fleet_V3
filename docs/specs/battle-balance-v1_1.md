# Profil d’équilibrage : Balance v1.1

## Objectifs
- Séparer clairement les paramètres de balance des mécaniques moteur pour rester déterministe et testable.
- Préparer les itérations anti-bomber/transports sans changer le gameplay dans cette étape.
- Documenter un profil de référence pour mesurer les évolutions.

## Paramètres actuels (Balance v1.1)
- **Ciblage**
  - Friction : 60% de chances de conserver la cible courante si elle reste valide.
  - Focus bomber (capitals) : 25% de chances de cibler un bomber ennemi s’il existe.
  - Focus transport : probabilité croissante (5% +2%/round, max 12%) de cibler un transport même si escortes présentes.
- **Pacing**
  - MAX_ROUNDS : 10 (tiebreaker HP/ships si la bataille n’est pas tranchée)
  - ETA_MISSILE : 2
  - ETA_TORPEDO : 3
  - BASE_ACCURACY : 0.85
  - LOCK_GAIN_PER_ROUND : 0.35
  - MAX_LAUNCH_PER_ROUND : 3
- **Interception**
  - INTERCEPTION_BASE_CHANCE : 0.15
- **Défense ponctuelle**
  - PD_DAMAGE_PER_POINT : 6 (légère réduction pour rendre les salves plus punitives)
  - MISSILE_HP : 50
  - TORPEDO_HP : 150

> Ces valeurs introduisent une montée en létalité (friction plus basse, meilleure précision, interception plus faible) et un tiebreaker HP/ships à MAX_ROUNDS pour casser les draws.

## Mesure et reproductibilité
1. Lancer le simulateur CLI de batailles :
   ```bash
   npm run battle:sim -- --preset core --runs 1000
   ```
2. Les résultats sont déterministes pour un preset et une seed donnés (uses battle.id + turnCreated).
3. Les agrégats clés : win rate, draws, rounds moyens, pertes moyennes, munitions consommées.

## Observation (preset `core`, 2000 runs, seed 1337)
- Win rates : Blue 57.75%, Red 42.25%, Draw 0% (draws éliminés grâce au focus + tiebreaker).
- Rounds moyens : 10.00 (allongement du pacing pour laisser la décision se faire).
- Pertes moyennes : Blue 6.00 ships / Red 5.77 ships.
- Interceptions moyennes : Soft kill 6.53, PD 5.29 par run.
- Munitions moyennes consommées :
  - Blue : missiles 56/56, torpilles 16/16, intercepteurs ~26.72/56
  - Red : missiles 60/60, torpilles 18/18, intercepteurs ~29.41/60

> Lecture : le focus probabiliste (bomber/transport), la baisse de friction, la réduction d’interception et le tiebreaker HP/ships à MAX_ROUNDS suppriment les égalités. Le preset “core” reste relativement équilibré mais penche légèrement en faveur de Blue (57.75%) – à ajuster lors des prochaines passes (ex. resserrer la précision ou booster la défense de Red).

## Périmètre technique
- Configuration centralisée : `src/engine/battle/balance.ts`
- Façade runtime : `src/engine/battle/constants.ts`
- Ciblage : `src/engine/battle/targeting.ts`
- Documentation : `docs/specs/battle-balance-v1_1.md`
